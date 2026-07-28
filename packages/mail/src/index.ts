/**
 * Durable transactional-mail state for records owned by the caller.
 *
 * Mail owns no store, collection, or partition. A caller projects a mail job
 * into its own record union and commits {@link Mail.action} beside the state
 * change that caused it.
 */

import type { Clock, IsoTimestamp } from "@pegma/spine";
import {
  MAX_SCAN_PAGE_SIZE,
  type CollectionDefinition,
  type CollectionStore,
  type EntityKey,
  type ScanRecord,
  type TransactionAction,
} from "@pegma/storage-core";

export type MailStatus =
  | "pending"
  | "sending"
  | "retrying"
  | "accepted"
  | "reconciling"
  | "delivered"
  | "dead_letter"
  | "terminal_unknown";

export interface MailJob {
  readonly partition: string;
  readonly id: string;
  /**
   * Logical provider submission generation. It advances only after an
   * authoritative provider failure, never after an ambiguous send outcome.
   */
  readonly submissionGeneration: number;
  readonly idempotencyKey: string;
  readonly recipientRef: string;
  readonly contentRef: string;
  readonly status: MailStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly claimToken?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: IsoTimestamp;
  readonly acceptedAt?: IsoTimestamp;
  readonly acceptedDeadlineAt?: IsoTimestamp;
  readonly deliveredAt?: IsoTimestamp;
  readonly terminalAt?: IsoTimestamp;
  readonly providerMessageRef?: string;
  /** Provider-reported event time, retained as evidence but never scheduling. */
  readonly providerOccurredAt?: IsoTimestamp;
  readonly failureCategory?: string;
  readonly acknowledgedAt?: IsoTimestamp;
  readonly acknowledgementRef?: string;
}

export interface CreateMailJob {
  readonly partition: string;
  readonly id: string;
  readonly recipientRef: string;
  readonly contentRef: string;
  readonly createdAt: IsoTimestamp;
  readonly maxAttempts?: number;
}

export interface MailCandidate {
  readonly partition: string;
  readonly jobId: string;
}

export interface MailProjection<TRecord> {
  readonly collection: CollectionDefinition<TRecord>;
  key(candidate: MailCandidate): EntityKey;
  /**
   * Merge the job into a caller record. Worker transitions receive the
   * current record so caller-owned fields can be preserved.
   */
  toRecord(job: MailJob, previous: TRecord | null): TRecord;
  toJob(record: TRecord): MailJob | null;
}

export interface PreparedMail {
  readonly recipient: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MailPreparationRequest {
  readonly partition: string;
  readonly jobId: string;
  readonly recipientRef: string;
  readonly contentRef: string;
}

/** Host-owned content resolution and rendering. */
export interface MailPreparationPort {
  /**
   * The adapter must settle within the configured worker lease, enforcing its
   * own shorter finite timeout for any underlying I/O.
   */
  prepare(request: MailPreparationRequest): Promise<PreparedMail>;
}

export interface MailSendRequest {
  /**
   * Mandatory provider idempotency key. An adapter that cannot honor it has
   * an explicit double-send risk under the worker's at-least-once execution.
   */
  readonly idempotencyKey: string;
  readonly mail: PreparedMail;
}

export interface MailSendResult {
  readonly providerMessageRef: string;
}

export interface MailProvider {
  /**
   * The adapter must settle within the configured worker lease, enforcing its
   * own shorter finite provider timeout. JavaScript cannot cancel a promise
   * the adapter leaves pending, so lease recovery may otherwise overlap calls.
   */
  send(request: MailSendRequest): Promise<MailSendResult>;
}

export interface MailReconciliationRequest {
  readonly idempotencyKey: string;
  readonly providerMessageRef: string;
}

export type MailReconciliationResult =
  | { readonly status: "delivered" }
  | { readonly status: "failed"; readonly failureCategory: string }
  | { readonly status: "unknown" };

export interface MailReconciliationPort {
  /**
   * The adapter must settle within the configured worker lease, enforcing its
   * own shorter finite timeout for any underlying I/O.
   */
  reconcile(
    request: MailReconciliationRequest,
  ): Promise<MailReconciliationResult>;
}

export interface AuthenticatedMailCallback {
  readonly partition: string;
  readonly jobId: string;
  /** Provider submission generation this event describes. */
  readonly submissionGeneration: number;
  /** Optional additional correlation when the provider exposes it. */
  readonly providerMessageRef?: string;
  readonly status: "delivered" | "failed";
  readonly occurredAt: IsoTimestamp;
  readonly failureCategory?: string;
}

export interface AcknowledgeTerminalMail {
  readonly partition: string;
  readonly jobId: string;
  readonly acknowledgedAt: IsoTimestamp;
  readonly acknowledgementRef: string;
}

export interface MailPageOptions {
  /**
   * Opaque adapter-issued continuation. Omit to start or restart a complete
   * collection scan cycle.
   */
  readonly cursor?: string;
  /** Maximum authoritative caller rows to examine. */
  readonly limit?: number;
}

export interface MailPageResult<TResult> {
  readonly examined: number;
  readonly results: readonly TResult[];
  /**
   * Persist only after the page has completed. Reusing the prior cursor after
   * a crash may repeat records, which authoritative claims make safe.
   */
  readonly nextCursor: string | null;
}

export interface SweepTerminalMailOptions extends MailPageOptions {
  readonly terminalBefore: IsoTimestamp;
}

export interface SweepTerminalMailResult {
  /** Authoritative caller rows consumed from the bounded scan page. */
  readonly examined: number;
  readonly deleted: number;
  readonly nextCursor: string | null;
  /**
   * A retry may be useful because a conditional deletion lost a race or
   * `nextCursor` continues the current scan cycle.
   */
  readonly more: boolean;
}

export type FailureClassifier = (error: unknown) => string;

export interface MailWorkerOptions<TRecord> {
  readonly records: CollectionStore<TRecord>;
  /** Trusted host time, sampled before claims and again after awaited I/O. */
  readonly clock: Clock;
  readonly provider: MailProvider;
  readonly reconciliation: MailReconciliationPort;
  readonly preparation: MailPreparationPort;
  readonly workerId: string;
  /**
   * Claim duration, not an I/O timeout. Every post-claim adapter must enforce
   * its own shorter finite timeout and settle before this lease expires.
   */
  readonly leaseMilliseconds?: number;
  readonly baseRetryMilliseconds?: number;
  readonly acceptedCallbackMilliseconds?: number;
  readonly classifyFailure?: FailureClassifier;
}

export type SendMailResult =
  | { readonly status: "not_claimed" }
  | { readonly status: "accepted"; readonly job: MailJob }
  | {
      readonly status: "retrying" | "dead_letter";
      readonly job: MailJob;
    };

export type ReconcileMailResult =
  | { readonly status: "not_claimed" }
  | {
      readonly status:
        "delivered" | "retrying" | "dead_letter" | "terminal_unknown";
      readonly job: MailJob;
    };

export interface MailWorker {
  send(candidate: MailCandidate): Promise<SendMailResult>;
  reconcile(candidate: MailCandidate): Promise<ReconcileMailResult>;
  /** Scan and decide one bounded page using the sending cursor cycle. */
  runSendPage(
    options?: MailPageOptions,
  ): Promise<MailPageResult<SendMailResult>>;
  /** Scan and decide one bounded page using a separate reconciliation cursor. */
  runReconciliationPage(
    options?: MailPageOptions,
  ): Promise<MailPageResult<ReconcileMailResult>>;
}

export interface Mail<TRecord> {
  /** Insert this action in the caller's own single-partition transaction. */
  action(job: CreateMailJob): TransactionAction<TRecord>;
  worker(options: MailWorkerOptions<TRecord>): MailWorker;
  /**
   * Applies an already-authenticated, already-deduplicated provider callback.
   * Webhook receipt storage and authenticity remain host concerns.
   */
  applyAuthenticatedCallback(
    records: CollectionStore<TRecord>,
    callback: AuthenticatedMailCallback,
    clock: Clock,
  ): Promise<MailJob | null>;
  acknowledgeTerminal(
    records: CollectionStore<TRecord>,
    acknowledgement: AcknowledgeTerminalMail,
  ): Promise<MailJob | null>;
  sweep(
    records: CollectionStore<TRecord>,
    options: SweepTerminalMailOptions,
  ): Promise<SweepTerminalMailResult>;
}

export class MailError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MailError";
  }
}

export const maxMailAttempts = 20;

const CONTROL = /[\u0000-\u001F\u007F]/;
const BODY_CONTROL = /[\u0000\u000B\u000C\u000E-\u001F\u007F]/;
const FAILURE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_LEASE_MILLISECONDS = 86_400_000;
const MAX_BASE_RETRY_MILLISECONDS = 86_400_000;
const MAX_RETRY_DELAY_MILLISECONDS = 2_592_000_000;
const MAX_ACCEPTED_CALLBACK_MILLISECONDS = 604_800_000;
const MAX_DATE_EPOCH_MILLISECONDS = 8_640_000_000_000_000;

function requireText(value: unknown, field: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    CONTROL.test(value)
  ) {
    throw new MailError(
      `${field} must be a non-empty string of at most ${maximum} characters with no controls`,
    );
  }
  return value;
}

function timestamp(value: unknown, field: string): IsoTimestamp {
  const text = requireText(value, field, 64);
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== text) {
    throw new MailError(`${field} must be a canonical ISO timestamp`);
  }
  return text;
}

function epoch(value: IsoTimestamp, field: string): number {
  timestamp(value, field);
  return Date.parse(value);
}

function at(epochMilliseconds: number): IsoTimestamp {
  if (
    !Number.isFinite(epochMilliseconds) ||
    Math.abs(epochMilliseconds) > MAX_DATE_EPOCH_MILLISECONDS
  ) {
    throw new MailError("mail timestamp is outside the supported range");
  }
  return new Date(epochMilliseconds).toISOString();
}

function positiveInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new MailError(
      `${field} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
}

function scanOptions(input: MailPageOptions | undefined): {
  readonly limit: number;
  readonly cursor?: string;
} {
  const fields = ownDataSnapshot(
    input ?? {},
    ["cursor", "limit"],
    "mail page options",
  );
  const limit = positiveInteger(
    (fields["limit"] as number | undefined) ?? 100,
    "limit",
    MAX_SCAN_PAGE_SIZE,
  );
  const cursor = fields["cursor"];
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new MailError("cursor must be an opaque adapter-issued string");
  }
  return cursor === undefined ? { limit } : { limit, cursor };
}

function encodeIdempotencyPart(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Provider-safe key unique across caller partitions. */
export function mailIdempotencyKey(
  partition: string,
  jobId: string,
  submissionGeneration = 1,
): string {
  requireText(partition, "partition", 300);
  requireText(jobId, "jobId", 200);
  positiveInteger(
    submissionGeneration,
    "submissionGeneration",
    maxMailAttempts,
  );
  const key = `pegma-mail:v1:${encodeIdempotencyPart(partition)}:${encodeIdempotencyPart(jobId)}:${submissionGeneration}`;
  if (
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[A-Za-z0-9._~%:-]+$/.test(key)
  ) {
    throw new MailError(
      "mail idempotency key exceeds the safe provider format",
    );
  }
  return key;
}

function createJob(input: CreateMailJob): MailJob {
  const fields = ownDataSnapshot(
    input,
    [
      "partition",
      "id",
      "recipientRef",
      "contentRef",
      "createdAt",
      "maxAttempts",
    ],
    "mail action",
  );
  const partition = requireText(fields["partition"], "partition", 300);
  const id = requireText(fields["id"], "id", 200);
  const createdAt = timestamp(fields["createdAt"], "createdAt");
  const maxAttempts = positiveInteger(
    (fields["maxAttempts"] as number | undefined) ?? 5,
    "maxAttempts",
    maxMailAttempts,
  );
  return Object.freeze({
    partition,
    id,
    submissionGeneration: 1,
    idempotencyKey: mailIdempotencyKey(partition, id, 1),
    recipientRef: requireText(fields["recipientRef"], "recipientRef", 512),
    contentRef: requireText(fields["contentRef"], "contentRef", 512),
    status: "pending",
    attemptCount: 0,
    maxAttempts,
    availableAt: createdAt,
    createdAt,
  });
}

function sameKey(left: EntityKey, right: EntityKey): boolean {
  return left.partition === right.partition && left.id === right.id;
}

function dataProperty(value: unknown, name: string): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  const property = Object.getOwnPropertyDescriptor(value, name);
  return property !== undefined && Object.hasOwn(property, "value")
    ? property.value
    : undefined;
}

const MAIL_JOB_FIELDS = [
  "partition",
  "id",
  "submissionGeneration",
  "idempotencyKey",
  "recipientRef",
  "contentRef",
  "status",
  "attemptCount",
  "maxAttempts",
  "availableAt",
  "createdAt",
  "claimToken",
  "leaseOwner",
  "leaseExpiresAt",
  "acceptedAt",
  "acceptedDeadlineAt",
  "deliveredAt",
  "terminalAt",
  "providerMessageRef",
  "providerOccurredAt",
  "failureCategory",
  "acknowledgedAt",
  "acknowledgementRef",
] as const;

function ownDataSnapshot(
  value: unknown,
  fields: readonly string[],
  subject: string,
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new MailError(`${subject} must be an object`);
  }
  const snapshot: Record<string, unknown> = {};
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(value, field);
    if (property === undefined) continue;
    if (!Object.hasOwn(property, "value")) {
      throw new MailError(`${subject}.${field} must be an own data property`);
    }
    snapshot[field] = property.value;
  }
  return snapshot;
}

function normalizeEntityKey(value: unknown, subject: string): EntityKey {
  const fields = ownDataSnapshot(value, ["partition", "id"], subject);
  return Object.freeze({
    partition: requireText(fields["partition"], `${subject}.partition`, 1_024),
    id: requireText(fields["id"], `${subject}.id`, 1_024),
  });
}

function normalizeCandidate(value: unknown): MailCandidate {
  const fields = ownDataSnapshot(value, ["partition", "jobId"], "candidate");
  return Object.freeze({
    partition: requireText(fields["partition"], "candidate.partition", 300),
    jobId: requireText(fields["jobId"], "candidate.jobId", 200),
  });
}

function requireCount(
  value: unknown,
  field: string,
  maximum: number,
  minimum = 0,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new MailError(
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : requireText(value, field, maximum);
}

function optionalTimestamp(
  value: unknown,
  field: string,
): IsoTimestamp | undefined {
  return value === undefined ? undefined : timestamp(value, field);
}

function normalizeMailJob(value: unknown): MailJob {
  const fields = ownDataSnapshot(value, MAIL_JOB_FIELDS, "mail job");
  const partition = requireText(fields["partition"], "job.partition", 300);
  const id = requireText(fields["id"], "job.id", 200);
  const maxAttempts = requireCount(
    fields["maxAttempts"],
    "job.maxAttempts",
    maxMailAttempts,
    1,
  );
  const attemptCount = requireCount(
    fields["attemptCount"],
    "job.attemptCount",
    maxAttempts,
  );
  const submissionGeneration = requireCount(
    fields["submissionGeneration"],
    "job.submissionGeneration",
    maxAttempts,
    1,
  );
  if (submissionGeneration > attemptCount + 1) {
    throw new MailError(
      "job.submissionGeneration cannot exceed completed attempts plus one",
    );
  }
  const idempotencyKey = requireText(
    fields["idempotencyKey"],
    "job.idempotencyKey",
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  if (
    idempotencyKey !== mailIdempotencyKey(partition, id, submissionGeneration)
  ) {
    throw new MailError(
      "job.idempotencyKey does not match its partition, id, and submission generation",
    );
  }
  const status = fields["status"];
  if (
    status !== "pending" &&
    status !== "sending" &&
    status !== "retrying" &&
    status !== "accepted" &&
    status !== "reconciling" &&
    status !== "delivered" &&
    status !== "dead_letter" &&
    status !== "terminal_unknown"
  ) {
    throw new MailError("job.status is invalid");
  }
  const availableAt = timestamp(fields["availableAt"], "job.availableAt");
  const createdAt = timestamp(fields["createdAt"], "job.createdAt");
  const createdEpoch = epoch(createdAt, "job.createdAt");
  if (epoch(availableAt, "job.availableAt") < createdEpoch) {
    throw new MailError("job.availableAt cannot precede createdAt");
  }
  const recipientRef = requireText(
    fields["recipientRef"],
    "job.recipientRef",
    512,
  );
  const contentRef = requireText(fields["contentRef"], "job.contentRef", 512);
  const claimToken = optionalText(fields["claimToken"], "job.claimToken", 36);
  if (
    claimToken !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      claimToken,
    )
  ) {
    throw new MailError("job.claimToken must be a UUID v4");
  }
  const leaseOwner = optionalText(fields["leaseOwner"], "job.leaseOwner", 200);
  const leaseExpiresAt = optionalTimestamp(
    fields["leaseExpiresAt"],
    "job.leaseExpiresAt",
  );
  const acceptedAt = optionalTimestamp(fields["acceptedAt"], "job.acceptedAt");
  const acceptedDeadlineAt = optionalTimestamp(
    fields["acceptedDeadlineAt"],
    "job.acceptedDeadlineAt",
  );
  const deliveredAt = optionalTimestamp(
    fields["deliveredAt"],
    "job.deliveredAt",
  );
  const terminalAt = optionalTimestamp(fields["terminalAt"], "job.terminalAt");
  const providerMessageRef = optionalText(
    fields["providerMessageRef"],
    "job.providerMessageRef",
    512,
  );
  const providerOccurredAt = optionalTimestamp(
    fields["providerOccurredAt"],
    "job.providerOccurredAt",
  );
  const failureCategory = optionalText(
    fields["failureCategory"],
    "job.failureCategory",
    64,
  );
  if (
    failureCategory !== undefined &&
    !FAILURE_CATEGORY.test(failureCategory)
  ) {
    throw new MailError("job.failureCategory must be a coarse safe token");
  }
  const acknowledgedAt = optionalTimestamp(
    fields["acknowledgedAt"],
    "job.acknowledgedAt",
  );
  const acknowledgementRef = optionalText(
    fields["acknowledgementRef"],
    "job.acknowledgementRef",
    512,
  );
  if (
    leaseExpiresAt !== undefined &&
    epoch(leaseExpiresAt, "job.leaseExpiresAt") < createdEpoch
  ) {
    throw new MailError("job.leaseExpiresAt cannot precede createdAt");
  }
  if (
    (acceptedAt === undefined) !== (acceptedDeadlineAt === undefined) ||
    (acceptedAt !== undefined &&
      (epoch(acceptedAt, "job.acceptedAt") < createdEpoch ||
        ((status === "accepted" || status === "reconciling") &&
          epoch(acceptedAt, "job.acceptedAt") <
            epoch(availableAt, "job.availableAt"))))
  ) {
    throw new MailError(
      "job acceptance timestamps must occur together after availableAt",
    );
  }
  if (
    deliveredAt !== undefined &&
    (status !== "delivered" ||
      epoch(deliveredAt, "job.deliveredAt") < createdEpoch ||
      epoch(deliveredAt, "job.deliveredAt") <
        epoch(availableAt, "job.availableAt") ||
      (acceptedAt !== undefined &&
        epoch(deliveredAt, "job.deliveredAt") <
          epoch(acceptedAt, "job.acceptedAt")))
  ) {
    throw new MailError(
      "job.deliveredAt must occur in delivered state after prior operational time",
    );
  }
  if (
    terminalAt !== undefined &&
    (epoch(terminalAt, "job.terminalAt") < createdEpoch ||
      epoch(terminalAt, "job.terminalAt") <
        epoch(availableAt, "job.availableAt") ||
      (acceptedAt !== undefined &&
        epoch(terminalAt, "job.terminalAt") <
          epoch(acceptedAt, "job.acceptedAt")) ||
      (deliveredAt !== undefined &&
        epoch(terminalAt, "job.terminalAt") <
          epoch(deliveredAt, "job.deliveredAt")))
  ) {
    throw new MailError("job.terminalAt cannot precede prior operational time");
  }
  const claiming = status === "sending" || status === "reconciling";
  if (
    claiming !==
    (claimToken !== undefined &&
      leaseOwner !== undefined &&
      leaseExpiresAt !== undefined)
  ) {
    throw new MailError(
      "job claim token, owner, and expiry must exist exactly while claiming",
    );
  }
  if (
    (status === "accepted" ||
      status === "reconciling" ||
      status === "terminal_unknown") &&
    (acceptedAt === undefined ||
      acceptedDeadlineAt === undefined ||
      providerMessageRef === undefined)
  ) {
    throw new MailError(
      "accepted, reconciling, and terminal-unknown jobs require acceptance metadata",
    );
  }
  if (
    (status === "pending" || status === "sending" || status === "retrying") &&
    (acceptedAt !== undefined ||
      acceptedDeadlineAt !== undefined ||
      providerMessageRef !== undefined)
  ) {
    throw new MailError(
      "sendable jobs cannot retain provider acceptance metadata",
    );
  }
  if (
    acceptedAt !== undefined &&
    acceptedDeadlineAt !== undefined &&
    epoch(acceptedDeadlineAt, "job.acceptedDeadlineAt") <=
      epoch(acceptedAt, "job.acceptedAt")
  ) {
    throw new MailError("job.acceptedDeadlineAt must be later than acceptedAt");
  }
  const terminal =
    status === "delivered" ||
    status === "dead_letter" ||
    status === "terminal_unknown";
  if (terminal !== (terminalAt !== undefined)) {
    throw new MailError("job.terminalAt must exist exactly in terminal state");
  }
  if (status === "delivered" && deliveredAt === undefined) {
    throw new MailError("delivered jobs require deliveredAt");
  }
  if (
    (status === "retrying" ||
      status === "dead_letter" ||
      status === "terminal_unknown") &&
    failureCategory === undefined
  ) {
    throw new MailError(`${status} jobs require failureCategory`);
  }
  if (status === "pending" && attemptCount !== 0) {
    throw new MailError("pending jobs cannot have completed attempts");
  }
  if (
    (status === "retrying" ||
      status === "accepted" ||
      status === "reconciling" ||
      status === "delivered" ||
      status === "dead_letter" ||
      status === "terminal_unknown") &&
    attemptCount < 1
  ) {
    throw new MailError(`${status} jobs require a completed attempt`);
  }
  if (
    (status === "sending" || status === "retrying") &&
    attemptCount >= maxAttempts
  ) {
    throw new MailError("retrying jobs must have an attempt remaining");
  }
  if (status === "dead_letter" && attemptCount < maxAttempts) {
    throw new MailError("dead-letter jobs must have exhausted attempts");
  }
  if (
    (acknowledgedAt === undefined) !== (acknowledgementRef === undefined) ||
    (acknowledgedAt !== undefined &&
      status !== "dead_letter" &&
      status !== "terminal_unknown")
  ) {
    throw new MailError(
      "terminal acknowledgement fields must occur together on actionable terminal jobs",
    );
  }
  if (
    acknowledgedAt !== undefined &&
    terminalAt !== undefined &&
    epoch(acknowledgedAt, "job.acknowledgedAt") <
      epoch(terminalAt, "job.terminalAt")
  ) {
    throw new MailError("job acknowledgement cannot precede terminalAt");
  }
  return Object.freeze({
    partition,
    id,
    submissionGeneration,
    idempotencyKey,
    recipientRef,
    contentRef,
    status,
    attemptCount,
    maxAttempts,
    availableAt,
    createdAt,
    ...(claimToken === undefined ? {} : { claimToken }),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    ...(acceptedDeadlineAt === undefined ? {} : { acceptedDeadlineAt }),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(terminalAt === undefined ? {} : { terminalAt }),
    ...(providerMessageRef === undefined ? {} : { providerMessageRef }),
    ...(providerOccurredAt === undefined ? {} : { providerOccurredAt }),
    ...(failureCategory === undefined ? {} : { failureCategory }),
    ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }),
    ...(acknowledgementRef === undefined ? {} : { acknowledgementRef }),
  });
}

function normalizeAuthenticatedCallback(
  value: unknown,
): AuthenticatedMailCallback {
  const fields = ownDataSnapshot(
    value,
    [
      "partition",
      "jobId",
      "submissionGeneration",
      "providerMessageRef",
      "status",
      "occurredAt",
      "failureCategory",
    ],
    "callback",
  );
  const status = fields["status"];
  if (status !== "delivered" && status !== "failed") {
    throw new MailError("callback.status must be delivered or failed");
  }
  const failureCategory = optionalText(
    fields["failureCategory"],
    "callback.failureCategory",
    64,
  );
  if (
    status === "failed" &&
    (failureCategory === undefined || !FAILURE_CATEGORY.test(failureCategory))
  ) {
    throw new MailError("a failed callback requires a coarse failureCategory");
  }
  if (status === "delivered" && failureCategory !== undefined) {
    throw new MailError(
      "a delivered callback cannot include a failureCategory",
    );
  }
  const providerMessageRef = optionalText(
    fields["providerMessageRef"],
    "callback.providerMessageRef",
    512,
  );
  return Object.freeze({
    partition: requireText(fields["partition"], "callback.partition", 300),
    jobId: requireText(fields["jobId"], "callback.jobId", 200),
    submissionGeneration: requireCount(
      fields["submissionGeneration"],
      "callback.submissionGeneration",
      maxMailAttempts,
      1,
    ),
    ...(providerMessageRef === undefined ? {} : { providerMessageRef }),
    status,
    occurredAt: timestamp(fields["occurredAt"], "callback.occurredAt"),
    ...(failureCategory === undefined ? {} : { failureCategory }),
  });
}

function optionalDataString(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  const property = dataProperty(value, name);
  if (property === undefined) return undefined;
  return typeof property === "string" &&
    property.length <= maximum &&
    !CONTROL.test(property)
    ? property
    : undefined;
}

function normalizePreparedMail(value: unknown): PreparedMail | null {
  const recipient = optionalDataString(value, "recipient", 1_024);
  const subject = optionalDataString(value, "subject", 998);
  const textValue = dataProperty(value, "text");
  const text =
    typeof textValue === "string" &&
    textValue.length <= 1_000_000 &&
    !BODY_CONTROL.test(textValue)
      ? textValue
      : undefined;
  if (
    recipient === undefined ||
    recipient.trim().length === 0 ||
    subject === undefined ||
    subject.trim().length === 0 ||
    text === undefined
  ) {
    return null;
  }
  const htmlValue = dataProperty(value, "html");
  const html =
    htmlValue === undefined
      ? undefined
      : typeof htmlValue === "string" &&
          htmlValue.length <= 1_000_000 &&
          !BODY_CONTROL.test(htmlValue)
        ? htmlValue
        : null;
  if (html === null) return null;

  const headersValue = dataProperty(value, "headers");
  let headers: Readonly<Record<string, string>> | undefined;
  if (headersValue !== undefined) {
    if (
      headersValue === null ||
      typeof headersValue !== "object" ||
      Array.isArray(headersValue)
    ) {
      return null;
    }
    const copied: Record<string, string> = {};
    const names = Object.getOwnPropertyNames(headersValue);
    if (names.length > 64) return null;
    for (const name of names) {
      if (
        !/^[A-Za-z0-9-]{1,64}$/.test(name) ||
        Object.hasOwn(copied, name.toLowerCase())
      ) {
        return null;
      }
      const header = Object.getOwnPropertyDescriptor(headersValue, name);
      if (
        header === undefined ||
        !Object.hasOwn(header, "value") ||
        typeof header.value !== "string" ||
        header.value.length > 8_192 ||
        CONTROL.test(header.value)
      ) {
        return null;
      }
      copied[name.toLowerCase()] = header.value;
    }
    headers = Object.freeze(copied);
  }
  return Object.freeze({
    recipient,
    subject,
    text,
    ...(html === undefined ? {} : { html }),
    ...(headers === undefined ? {} : { headers }),
  });
}

function normalizeSendResult(value: unknown): MailSendResult | null {
  const providerMessageRef = optionalDataString(
    value,
    "providerMessageRef",
    512,
  );
  return providerMessageRef === undefined ||
    providerMessageRef.trim().length === 0
    ? null
    : { providerMessageRef };
}

function normalizeReconciliation(value: unknown): MailReconciliationResult {
  const status = dataProperty(value, "status");
  if (status === "delivered") return { status };
  if (status === "unknown") return { status };
  if (status !== "failed") return { status: "unknown" };
  const failureCategory = dataProperty(value, "failureCategory");
  return typeof failureCategory === "string" &&
    FAILURE_CATEGORY.test(failureCategory)
    ? { status, failureCategory }
    : { status: "unknown" };
}

function withoutClaim(
  job: MailJob,
): Omit<MailJob, "claimToken" | "leaseOwner" | "leaseExpiresAt"> {
  const {
    claimToken: _claimToken,
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    ...unclaimed
  } = job;
  return unclaimed;
}

function withoutPriorOutcome(
  job: MailJob,
): Omit<
  MailJob,
  | "acceptedAt"
  | "acceptedDeadlineAt"
  | "providerMessageRef"
  | "providerOccurredAt"
  | "deliveredAt"
  | "terminalAt"
  | "failureCategory"
  | "acknowledgedAt"
  | "acknowledgementRef"
> {
  const {
    acceptedAt: _acceptedAt,
    acceptedDeadlineAt: _acceptedDeadlineAt,
    providerMessageRef: _providerMessageRef,
    providerOccurredAt: _providerOccurredAt,
    deliveredAt: _deliveredAt,
    terminalAt: _terminalAt,
    failureCategory: _failureCategory,
    acknowledgedAt: _acknowledgedAt,
    acknowledgementRef: _acknowledgementRef,
    ...clean
  } = job;
  return clean;
}

function rotateSubmission(
  job: MailJob,
): Pick<MailJob, "submissionGeneration" | "idempotencyKey"> {
  const submissionGeneration = job.submissionGeneration + 1;
  if (
    submissionGeneration > job.maxAttempts ||
    submissionGeneration > job.attemptCount + 1
  ) {
    throw new MailError("mail submission generation is exhausted");
  }
  return {
    submissionGeneration,
    idempotencyKey: mailIdempotencyKey(
      job.partition,
      job.id,
      submissionGeneration,
    ),
  };
}

function withoutAcknowledgement(
  job: MailJob,
): Omit<MailJob, "acknowledgedAt" | "acknowledgementRef"> {
  const {
    acknowledgedAt: _acknowledgedAt,
    acknowledgementRef: _acknowledgementRef,
    ...unacknowledged
  } = job;
  return unacknowledged;
}

function withoutFailure(job: MailJob): Omit<MailJob, "failureCategory"> {
  const { failureCategory: _failureCategory, ...successful } = job;
  return successful;
}

function jobFrom<TRecord>(
  projection: MailProjection<TRecord>,
  record: TRecord | null,
  strict = false,
): MailJob | null {
  if (record === null) return null;
  try {
    const projected = projection.toJob(record);
    return projected === null ? null : normalizeMailJob(projected);
  } catch (error) {
    if (!strict) return null;
    throw new MailError("mail projection did not decode a valid mail job", {
      cause: error,
    });
  }
}

function requireProjectedKey<TRecord>(
  projection: MailProjection<TRecord>,
  job: MailJob,
  record: TRecord,
): void {
  const expected = normalizeEntityKey(
    projection.key({
      partition: job.partition,
      jobId: job.id,
    }),
    "projection key",
  );
  const actual = normalizeEntityKey(
    projection.collection.key(record),
    "collection key",
  );
  if (!sameKey(actual, expected) || actual.partition !== job.partition) {
    throw new MailError(
      "mail projection must key the job into the caller partition at projection.key(candidate)",
    );
  }
}

/**
 * Binds mail behavior to a caller-owned collection and record projection.
 */
export function defineMail<TRecord>(
  projection: MailProjection<TRecord>,
): Mail<TRecord> {
  const project = (job: MailJob, previous: TRecord | null): TRecord => {
    const normalized = normalizeMailJob(job);
    const record = projection.toRecord(normalized, previous);
    requireProjectedKey(projection, normalized, record);
    const roundTrip = jobFrom(projection, record, true);
    if (
      roundTrip === null ||
      JSON.stringify(roundTrip) !== JSON.stringify(normalized)
    ) {
      throw new MailError(
        "mail projection must round-trip the exact normalized mail job",
      );
    }
    return record;
  };

  const key = (candidate: MailCandidate): EntityKey => {
    const normalized = normalizeCandidate(candidate);
    const result = normalizeEntityKey(
      projection.key(normalized),
      "projection key",
    );
    if (result.partition !== normalized.partition) {
      throw new MailError(
        "mail projection key must use the candidate partition",
      );
    }
    return result;
  };

  const mailFromScan = (
    scanned: ScanRecord<TRecord>,
  ): {
    readonly candidate: MailCandidate;
    readonly job: MailJob;
    readonly key: EntityKey;
    readonly version: string;
  } | null => {
    const fields = ownDataSnapshot(
      scanned,
      ["key", "value", "version"],
      "authoritative scan record",
    );
    const value = fields["value"] as TRecord;
    const version = fields["version"];
    if (typeof version !== "string" || version.length === 0) {
      throw new MailError(
        "authoritative scan record version must be a non-empty opaque string",
      );
    }
    const job = jobFrom(projection, value, true);
    if (job === null) return null;
    requireProjectedKey(projection, job, value);
    const storedKey = normalizeEntityKey(fields["key"], "scan key");
    const decodedKey = normalizeEntityKey(
      projection.collection.key(value),
      "collection key",
    );
    if (!sameKey(storedKey, decodedKey)) {
      throw new MailError(
        "authoritative scan key does not match the decoded caller record key",
      );
    }
    return Object.freeze({
      candidate: Object.freeze({
        partition: job.partition,
        jobId: job.id,
      }),
      job,
      key: storedKey,
      version,
    });
  };

  const scanPage = async (
    records: CollectionStore<TRecord>,
    input: MailPageOptions | undefined,
  ): Promise<{
    readonly records: readonly ScanRecord<TRecord>[];
    readonly nextCursor: string | null;
  }> => {
    const request = scanOptions(input);
    const raw = await records.scan(request);
    const fields = ownDataSnapshot(
      raw,
      ["records", "nextCursor"],
      "authoritative scan page",
    );
    const scanned = fields["records"];
    const nextCursor = fields["nextCursor"];
    if (!Array.isArray(scanned) || scanned.length > request.limit) {
      throw new MailError(
        "authoritative scan page records must be an array within the requested limit",
      );
    }
    if (nextCursor !== null && typeof nextCursor !== "string") {
      throw new MailError(
        "authoritative scan page nextCursor must be null or an opaque string",
      );
    }
    return Object.freeze({
      records: scanned as readonly ScanRecord<TRecord>[],
      nextCursor,
    });
  };

  async function updateJob(
    records: CollectionStore<TRecord>,
    candidate: MailCandidate,
    decide: (job: MailJob) => MailJob | null,
  ): Promise<MailJob | null> {
    const normalizedCandidate = normalizeCandidate(candidate);
    const candidateKey = key(normalizedCandidate);
    const result = await records.update(candidateKey, (current) => {
      const job = jobFrom(projection, current, true);
      if (
        job === null ||
        current === null ||
        job.partition !== normalizedCandidate.partition ||
        job.id !== normalizedCandidate.jobId ||
        !sameKey(
          normalizeEntityKey(
            projection.collection.key(current),
            "collection key",
          ),
          candidateKey,
        )
      ) {
        return { action: "keep" };
      }
      const next = decide(job);
      return next === null
        ? { action: "keep" }
        : { action: "write", value: project(next, current) };
    });
    return result.written ? jobFrom(projection, result.value, true) : null;
  }

  async function claim(
    records: CollectionStore<TRecord>,
    candidate: MailCandidate,
    lane: "send" | "reconcile",
    workerId: string,
    now: IsoTimestamp,
    leaseExpiresAt: IsoTimestamp,
  ): Promise<MailJob | null> {
    const claimToken = crypto.randomUUID();
    const nowEpoch = epoch(now, "now");
    return updateJob(records, candidate, (current) => {
      if (lane === "send") {
        const sendable =
          (current.status === "pending" || current.status === "retrying") &&
          epoch(current.availableAt, "job.availableAt") <= nowEpoch;
        const expiredSend =
          current.status === "sending" &&
          current.leaseExpiresAt !== undefined &&
          epoch(current.leaseExpiresAt, "job.leaseExpiresAt") <= nowEpoch;
        if (!sendable && !expiredSend) return null;
        return {
          ...current,
          status: "sending",
          leaseOwner: workerId,
          leaseExpiresAt,
          claimToken,
        };
      }
      const acceptedExpired =
        current.status === "accepted" &&
        current.acceptedDeadlineAt !== undefined &&
        epoch(current.acceptedDeadlineAt, "job.acceptedDeadlineAt") <= nowEpoch;
      const expiredReconciliation =
        current.status === "reconciling" &&
        current.leaseExpiresAt !== undefined &&
        epoch(current.leaseExpiresAt, "job.leaseExpiresAt") <= nowEpoch;
      if (!acceptedExpired && !expiredReconciliation) return null;
      return {
        ...current,
        status: "reconciling",
        leaseOwner: workerId,
        leaseExpiresAt,
        claimToken,
      };
    });
  }

  async function completeSend(
    records: CollectionStore<TRecord>,
    candidate: MailCandidate,
    workerId: string,
    claimToken: string,
    now: IsoTimestamp,
    outcome:
      | {
          readonly accepted: true;
          readonly providerMessageRef: string;
          readonly acceptedDeadlineAt: IsoTimestamp;
        }
      | {
          readonly accepted: false;
          readonly failureCategory: string;
          readonly retryAt: IsoTimestamp;
        },
  ): Promise<MailJob | null> {
    return updateJob(records, candidate, (current) => {
      if (
        current.status !== "sending" ||
        current.leaseOwner !== workerId ||
        current.claimToken !== claimToken
      ) {
        return null;
      }
      const attemptCount = current.attemptCount + 1;
      const unclaimed = withoutClaim(current);
      if (outcome.accepted) {
        const clean = withoutPriorOutcome(unclaimed);
        return {
          ...clean,
          status: "accepted",
          attemptCount,
          acceptedAt: now,
          acceptedDeadlineAt: outcome.acceptedDeadlineAt,
          providerMessageRef: outcome.providerMessageRef,
        };
      }
      const exhausted = attemptCount >= current.maxAttempts;
      return {
        ...unclaimed,
        status: exhausted ? "dead_letter" : "retrying",
        attemptCount,
        availableAt: exhausted ? now : outcome.retryAt,
        failureCategory: outcome.failureCategory,
        ...(exhausted ? { terminalAt: now } : {}),
      };
    });
  }

  /**
   * Linearizes permission to cross the provider side-effect boundary after
   * preparation. Rewriting the unchanged projected job makes a callback that
   * resolves the claim during preparation win the storage conflict; a stale
   * worker then observes that it no longer owns a sending claim.
   */
  async function revalidateSendClaim(
    records: CollectionStore<TRecord>,
    candidate: MailCandidate,
    workerId: string,
    claimToken: string,
  ): Promise<MailJob | null> {
    return updateJob(records, candidate, (current) =>
      current.status === "sending" &&
      current.leaseOwner === workerId &&
      current.claimToken === claimToken
        ? current
        : null,
    );
  }

  async function completeReconciliation(
    records: CollectionStore<TRecord>,
    candidate: MailCandidate,
    workerId: string,
    claimToken: string,
    now: IsoTimestamp,
    outcome: MailReconciliationResult,
  ): Promise<MailJob | null> {
    return updateJob(records, candidate, (current) => {
      if (
        current.status !== "reconciling" ||
        current.leaseOwner !== workerId ||
        current.claimToken !== claimToken
      ) {
        return null;
      }
      const unclaimed = withoutClaim(current);
      if (outcome.status === "delivered") {
        return {
          ...withoutFailure(withoutAcknowledgement(unclaimed)),
          status: "delivered",
          deliveredAt: now,
          terminalAt: now,
        };
      }
      if (outcome.status === "failed") {
        const exhausted = current.attemptCount >= current.maxAttempts;
        if (!exhausted) {
          return {
            ...withoutPriorOutcome(unclaimed),
            ...rotateSubmission(current),
            status: "retrying",
            availableAt: now,
            failureCategory: outcome.failureCategory,
          };
        }
        return {
          ...unclaimed,
          status: "dead_letter",
          availableAt: now,
          failureCategory: outcome.failureCategory,
          terminalAt: now,
        };
      }
      return {
        ...unclaimed,
        status: "terminal_unknown",
        failureCategory: "delivery_status_unknown",
        terminalAt: now,
      };
    });
  }

  return {
    action(input) {
      return { action: "insert", value: project(createJob(input), null) };
    },

    worker(options) {
      const workerId = requireText(options.workerId, "workerId", 200);
      const leaseMilliseconds = positiveInteger(
        options.leaseMilliseconds ?? 30_000,
        "leaseMilliseconds",
        MAX_LEASE_MILLISECONDS,
      );
      const baseRetryMilliseconds = positiveInteger(
        options.baseRetryMilliseconds ?? 1_000,
        "baseRetryMilliseconds",
        MAX_BASE_RETRY_MILLISECONDS,
      );
      const acceptedCallbackMilliseconds = positiveInteger(
        options.acceptedCallbackMilliseconds ?? 86_400_000,
        "acceptedCallbackMilliseconds",
        MAX_ACCEPTED_CALLBACK_MILLISECONDS,
      );
      const classifyFailure =
        options.classifyFailure ?? (() => "provider_unavailable");

      function clockNow(): {
        readonly text: IsoTimestamp;
        readonly epoch: number;
      } {
        const text = timestamp(options.clock.now(), "clock.now()");
        return { text, epoch: Date.parse(text) };
      }

      function completionNow(claimEpoch: number): {
        readonly text: IsoTimestamp;
        readonly epoch: number;
      } {
        const completed = clockNow();
        if (completed.epoch < claimEpoch) {
          throw new MailError(
            "clock.now() moved backward during mail provider work",
          );
        }
        return completed;
      }

      function failure(error: unknown): string {
        try {
          const classified = classifyFailure(error);
          return FAILURE_CATEGORY.test(classified)
            ? classified
            : "provider_unavailable";
        } catch {
          return "provider_unavailable";
        }
      }

      async function send(input: MailCandidate): Promise<SendMailResult> {
        const claimedAt = clockNow();
        if (
          claimedAt.epoch >
          MAX_DATE_EPOCH_MILLISECONDS -
            Math.max(leaseMilliseconds, MAX_RETRY_DELAY_MILLISECONDS)
        ) {
          throw new MailError(
            "now is too late to represent the bounded mail schedule",
          );
        }
        const candidate = normalizeCandidate(input);
        const claimed = await claim(
          options.records,
          candidate,
          "send",
          workerId,
          claimedAt.text,
          at(claimedAt.epoch + leaseMilliseconds),
        );
        if (claimed?.claimToken === undefined) {
          return { status: "not_claimed" };
        }
        const claimToken = claimed.claimToken;
        const exponent = Math.min(Math.max(0, claimed.attemptCount), 19);

        const fail = async (category: string): Promise<SendMailResult> => {
          const completedAt = completionNow(claimedAt.epoch);
          if (
            completedAt.epoch >
            MAX_DATE_EPOCH_MILLISECONDS - MAX_RETRY_DELAY_MILLISECONDS
          ) {
            throw new MailError(
              "clock is too late to represent the bounded retry schedule",
            );
          }
          const retryAt = at(
            completedAt.epoch +
              Math.min(
                MAX_RETRY_DELAY_MILLISECONDS,
                baseRetryMilliseconds * 2 ** exponent,
              ),
          );
          const completed = await completeSend(
            options.records,
            candidate,
            workerId,
            claimToken,
            completedAt.text,
            {
              accepted: false,
              failureCategory: category,
              retryAt,
            },
          );
          return completed === null
            ? { status: "not_claimed" }
            : {
                status:
                  completed.status === "dead_letter"
                    ? "dead_letter"
                    : "retrying",
                job: completed,
              };
        };

        try {
          if (
            claimed.partition !== candidate.partition ||
            claimed.id !== candidate.jobId ||
            claimed.idempotencyKey !==
              mailIdempotencyKey(
                claimed.partition,
                claimed.id,
                claimed.submissionGeneration,
              )
          ) {
            return fail("mail_job_invalid");
          }
        } catch {
          return fail("mail_job_invalid");
        }

        let prepared: PreparedMail;
        try {
          const normalized = normalizePreparedMail(
            await options.preparation.prepare({
              partition: claimed.partition,
              jobId: claimed.id,
              recipientRef: claimed.recipientRef,
              contentRef: claimed.contentRef,
            }),
          );
          if (normalized === null) return fail("content_preparation_invalid");
          prepared = normalized;
        } catch {
          return fail("content_preparation_failed");
        }

        const authorized = await revalidateSendClaim(
          options.records,
          candidate,
          workerId,
          claimToken,
        );
        if (authorized === null) {
          return { status: "not_claimed" };
        }

        let providerMessageRef: string;
        try {
          const normalized = normalizeSendResult(
            await options.provider.send({
              idempotencyKey: authorized.idempotencyKey,
              mail: prepared,
            }),
          );
          if (normalized === null) return fail("provider_response_invalid");
          providerMessageRef = normalized.providerMessageRef;
        } catch (error) {
          return fail(failure(error));
        }

        const completedAt = completionNow(claimedAt.epoch);
        if (
          completedAt.epoch >
          MAX_DATE_EPOCH_MILLISECONDS - acceptedCallbackMilliseconds
        ) {
          throw new MailError(
            "clock is too late to represent the callback deadline",
          );
        }
        const completed = await completeSend(
          options.records,
          candidate,
          workerId,
          claimToken,
          completedAt.text,
          {
            accepted: true,
            providerMessageRef,
            acceptedDeadlineAt: at(
              completedAt.epoch + acceptedCallbackMilliseconds,
            ),
          },
        );
        return completed === null
          ? { status: "not_claimed" }
          : { status: "accepted", job: completed };
      }

      async function reconcile(
        input: MailCandidate,
      ): Promise<ReconcileMailResult> {
        const claimedAt = clockNow();
        const candidate = normalizeCandidate(input);
        const claimed = await claim(
          options.records,
          candidate,
          "reconcile",
          workerId,
          claimedAt.text,
          at(claimedAt.epoch + leaseMilliseconds),
        );
        if (
          claimed?.claimToken === undefined ||
          claimed.providerMessageRef === undefined
        ) {
          return { status: "not_claimed" };
        }
        let outcome: MailReconciliationResult;
        try {
          outcome = normalizeReconciliation(
            await options.reconciliation.reconcile({
              idempotencyKey: claimed.idempotencyKey,
              providerMessageRef: claimed.providerMessageRef,
            }),
          );
        } catch {
          outcome = { status: "unknown" };
        }
        const completedAt = completionNow(claimedAt.epoch);
        const completed = await completeReconciliation(
          options.records,
          candidate,
          workerId,
          claimed.claimToken,
          completedAt.text,
          outcome,
        );
        if (completed === null) return { status: "not_claimed" };
        return {
          status:
            completed.status === "delivered"
              ? "delivered"
              : completed.status === "dead_letter"
                ? "dead_letter"
                : completed.status === "retrying"
                  ? "retrying"
                  : "terminal_unknown",
          job: completed,
        };
      }

      return {
        send,
        reconcile,
        async runSendPage(input) {
          const page = await scanPage(options.records, input);
          const results: SendMailResult[] = [];
          for (const scanned of page.records) {
            const discovered = mailFromScan(scanned);
            if (discovered === null) continue;
            results.push(await send(discovered.candidate));
          }
          return Object.freeze({
            examined: page.records.length,
            results: Object.freeze(results),
            nextCursor: page.nextCursor,
          });
        },
        async runReconciliationPage(input) {
          const page = await scanPage(options.records, input);
          const results: ReconcileMailResult[] = [];
          for (const scanned of page.records) {
            const discovered = mailFromScan(scanned);
            if (discovered === null) continue;
            results.push(await reconcile(discovered.candidate));
          }
          return Object.freeze({
            examined: page.records.length,
            results: Object.freeze(results),
            nextCursor: page.nextCursor,
          });
        },
      };
    },

    async applyAuthenticatedCallback(records, input, clock) {
      const callback = normalizeAuthenticatedCallback(input);
      const processedAt = timestamp(clock.now(), "clock.now()");
      const processedEpoch = epoch(processedAt, "clock.now()");
      const callbackFailure =
        callback.status === "failed" ? callback.failureCategory : undefined;
      return updateJob(
        records,
        { partition: callback.partition, jobId: callback.jobId },
        (current) => {
          if (
            current.submissionGeneration !== callback.submissionGeneration ||
            (callback.providerMessageRef !== undefined &&
              current.providerMessageRef !== undefined &&
              callback.providerMessageRef !== current.providerMessageRef)
          ) {
            return null;
          }
          if (callback.status === "delivered") {
            if (
              current.status === "pending" ||
              current.status === "delivered"
            ) {
              return null;
            }
            const operationalFloor = Math.max(
              epoch(current.createdAt, "job.createdAt"),
              current.acceptedAt === undefined
                ? Number.NEGATIVE_INFINITY
                : epoch(current.acceptedAt, "job.acceptedAt"),
              current.terminalAt === undefined
                ? Number.NEGATIVE_INFINITY
                : epoch(current.terminalAt, "job.terminalAt"),
            );
            if (processedEpoch < operationalFloor) {
              throw new MailError(
                "clock.now() precedes persisted mail operational time",
              );
            }
            const attemptCount =
              current.status === "sending"
                ? current.attemptCount + 1
                : current.attemptCount;
            const unclaimed = withoutFailure(
              withoutAcknowledgement(withoutClaim(current)),
            );
            return {
              ...unclaimed,
              status: "delivered",
              attemptCount,
              ...(callback.providerMessageRef === undefined
                ? {}
                : { providerMessageRef: callback.providerMessageRef }),
              availableAt: processedAt,
              providerOccurredAt: callback.occurredAt,
              deliveredAt: processedAt,
              terminalAt: processedAt,
            };
          }
          if (callbackFailure === undefined) {
            throw new MailError(
              "normalized failed callback has no failureCategory",
            );
          }
          if (
            current.status !== "sending" &&
            current.status !== "retrying" &&
            current.status !== "accepted" &&
            current.status !== "reconciling"
          ) {
            return null;
          }
          const operationalFloor = Math.max(
            epoch(current.createdAt, "job.createdAt"),
            current.acceptedAt === undefined
              ? Number.NEGATIVE_INFINITY
              : epoch(current.acceptedAt, "job.acceptedAt"),
          );
          if (processedEpoch < operationalFloor) {
            throw new MailError(
              "clock.now() precedes persisted mail operational time",
            );
          }
          const attemptCount =
            current.status === "sending"
              ? current.attemptCount + 1
              : current.attemptCount;
          const exhausted = attemptCount >= current.maxAttempts;
          const unclaimed = {
            ...withoutClaim(current),
            attemptCount,
            providerOccurredAt: callback.occurredAt,
          };
          if (exhausted) {
            return {
              ...unclaimed,
              status: "dead_letter",
              availableAt: processedAt,
              failureCategory: callbackFailure,
              terminalAt: processedAt,
            };
          }
          return {
            ...withoutPriorOutcome(unclaimed),
            ...rotateSubmission(unclaimed),
            status: "retrying",
            availableAt: processedAt,
            providerOccurredAt: callback.occurredAt,
            failureCategory: callbackFailure,
          };
        },
      );
    },

    async acknowledgeTerminal(records, input) {
      const acknowledgement = ownDataSnapshot(
        input,
        ["partition", "jobId", "acknowledgedAt", "acknowledgementRef"],
        "acknowledgement",
      );
      const acknowledgedAt = epoch(
        requireText(acknowledgement["acknowledgedAt"], "acknowledgedAt", 64),
        "acknowledgedAt",
      );
      const acknowledgementRef = requireText(
        acknowledgement["acknowledgementRef"],
        "acknowledgementRef",
        512,
      );
      const partition = requireText(
        acknowledgement["partition"],
        "partition",
        300,
      );
      const jobId = requireText(acknowledgement["jobId"], "jobId", 200);
      return updateJob(records, { partition, jobId }, (current) => {
        if (
          (current.status !== "dead_letter" &&
            current.status !== "terminal_unknown") ||
          current.acknowledgedAt !== undefined
        ) {
          return null;
        }
        if (
          current.terminalAt === undefined ||
          acknowledgedAt < epoch(current.terminalAt, "job.terminalAt")
        ) {
          throw new MailError(
            "acknowledgedAt must not precede the terminal outcome",
          );
        }
        return {
          ...current,
          acknowledgedAt: String(acknowledgement["acknowledgedAt"]),
          acknowledgementRef,
        };
      });
    },

    async sweep(records, input) {
      const options = ownDataSnapshot(
        input,
        ["terminalBefore"],
        "sweep options",
      );
      const terminalBeforeText = timestamp(
        options["terminalBefore"],
        "terminalBefore",
      );
      const terminalBefore = epoch(terminalBeforeText, "terminalBefore");
      const page = await scanPage(records, input);
      let deleted = 0;
      let more = false;
      for (const scanned of page.records) {
        const discovered = mailFromScan(scanned);
        if (discovered === null) continue;
        const job = discovered.job;
        if (
          job.status !== "delivered" &&
          job.status !== "dead_letter" &&
          job.status !== "terminal_unknown"
        ) {
          continue;
        }
        const eligible =
          job.terminalAt !== undefined &&
          epoch(job.terminalAt, "job.terminalAt") < terminalBefore &&
          (job.status === "delivered" || job.acknowledgedAt !== undefined);
        if (!eligible) continue;
        if (
          await records.deleteIfUnchanged(discovered.key, discovered.version)
        ) {
          deleted += 1;
        } else {
          more = true;
        }
      }
      if (page.nextCursor !== null) more = true;
      return Object.freeze({
        examined: page.records.length,
        deleted,
        nextCursor: page.nextCursor,
        more,
      });
    },
  };
}
