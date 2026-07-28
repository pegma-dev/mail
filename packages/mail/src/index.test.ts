import { createMemoryStore, type CollectionStore } from "@pegma/storage-core";
import { describe, expect, it, vi } from "vitest";
import {
  candidate,
  hostMailProjection,
  hostRecords,
  mail,
  mailAction,
  preparation,
  setTestTime,
  testClock,
  type HostRecord,
  unknownReconciliation,
} from "./test-support.js";
import {
  defineMail,
  type MailCandidate,
  type MailJob,
  type MailProjection,
} from "./index.js";

async function pending() {
  const store = createMemoryStore();
  const records = store.collection(hostRecords);
  await records.transact(candidate.partition, [mailAction()]);
  return records;
}

function worker(
  records: CollectionStore<HostRecord>,
  overrides: Partial<Parameters<typeof mail.worker>[0]> = {},
) {
  return workerFor(mail, records, overrides);
}

function workerFor(
  boundMail: typeof mail,
  records: CollectionStore<HostRecord>,
  overrides: Partial<Parameters<typeof mail.worker>[0]> = {},
) {
  return boundMail.worker({
    records,
    clock: testClock,
    workerId: "worker-a",
    provider: {
      send: async () => ({ providerMessageRef: "provider-1" }),
    },
    reconciliation: unknownReconciliation,
    preparation,
    ...overrides,
  });
}

function sendAt(
  delivery: ReturnType<typeof mail.worker>,
  now: string,
  work = candidate,
) {
  setTestTime(now);
  return delivery.send(work);
}

function reconcileAt(
  delivery: ReturnType<typeof mail.worker>,
  now: string,
  work = candidate,
) {
  setTestTime(now);
  return delivery.reconcile(work);
}

describe("@pegma/mail", () => {
  it("projects an insert into the caller transaction and leaves nothing on refusal", async () => {
    const store = createMemoryStore();
    const records = store.collection(hostRecords);
    const state: HostRecord = {
      kind: "state",
      partition: candidate.partition,
      id: "state",
      value: "before",
    };
    await records.put(state);

    const refused = await records.transact(candidate.partition, [
      mailAction(),
      { action: "insert", value: state },
    ]);

    expect(refused.committed).toBe(false);
    expect(
      await records.get({
        partition: candidate.partition,
        id: `mail-${candidate.jobId}`,
      }),
    ).toBeNull();

    const committed = await records.transact(candidate.partition, [
      mailAction(),
      { action: "put", value: { ...state, value: "after" } },
    ]);
    expect(committed.committed).toBe(true);
    expect(
      (await records.list(candidate.partition)).map((row) => row.kind),
    ).toEqual(expect.arrayContaining(["state", "mail"]));
  });

  it("discovers a committed job after immediate process loss and ignores a precommit phantom", async () => {
    const store = createMemoryStore();
    const records = store.collection(hostRecords);
    const send = vi.fn(async () => ({ providerMessageRef: "provider-crash" }));
    const projected = mailAction();

    setTestTime("2026-07-27T12:00:01.000Z");
    expect(
      await worker(records, { provider: { send } }).runSendPage({
        limit: 100,
      }),
    ).toEqual({ examined: 0, results: [], nextCursor: null });
    expect(send).not.toHaveBeenCalled();

    expect(
      (
        await records.transact(candidate.partition, [
          {
            action: "insert",
            value: {
              kind: "state",
              partition: candidate.partition,
              id: "identity-enrollment",
              value: "committed",
            },
          },
          projected,
        ])
      ).committed,
    ).toBe(true);

    const restarted = worker(records, { provider: { send } });
    expect(
      (await restarted.runSendPage({ limit: 100 })).results.map(
        (result) => result.status,
      ),
    ).toEqual(["accepted"]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("replays a scan page after cursor-save loss without duplicating provider work", async () => {
    const records = await pending();
    const send = vi.fn(async () => ({ providerMessageRef: "provider-once" }));
    const delivery = worker(records, { provider: { send } });

    setTestTime("2026-07-27T12:00:01.000Z");
    const completed = await delivery.runSendPage({ limit: 100 });
    expect(completed.results.map((result) => result.status)).toEqual([
      "accepted",
    ]);
    // Simulate a crash before saving completed.nextCursor: restart from the
    // same omitted cursor and replay the authoritative row.
    const replayed = await delivery.runSendPage({ limit: 100 });
    expect(replayed.results.map((result) => result.status)).toEqual([
      "not_claimed",
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("advances a fair bounded cursor cycle and finds a live-prefix insert by the next cycle", async () => {
    const store = createMemoryStore();
    const records = store.collection(hostRecords);
    for (const [partition, id] of [
      ["account-m", "middle"],
      ["account-z", "last"],
    ] as const) {
      await records.transact(partition, [
        mail.action({
          partition,
          id,
          recipientRef: `principal:${id}`,
          contentRef: `content:${id}`,
          createdAt: "2026-07-27T12:00:00.000Z",
        }),
      ]);
    }
    const send = vi.fn(async () => ({
      providerMessageRef: crypto.randomUUID(),
    }));
    const delivery = worker(records, { provider: { send } });
    const accepted = new Set<string>();
    let insertedLivePrefix = false;

    const runCycle = async () => {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await delivery.runSendPage({
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.examined).toBeLessThanOrEqual(1);
        for (const result of page.results) {
          if (result.status === "accepted") accepted.add(result.job.id);
        }
        pages += 1;
        if (!insertedLivePrefix) {
          insertedLivePrefix = true;
          await records.transact("000-live-prefix", [
            mail.action({
              partition: "000-live-prefix",
              id: "live-prefix",
              recipientRef: "principal:live-prefix",
              contentRef: "content:live-prefix",
              createdAt: "2026-07-27T12:00:00.000Z",
            }),
          ]);
        }
        cursor = page.nextCursor ?? undefined;
        if (pages > 10) throw new Error("mail scan cycle did not terminate");
      } while (cursor !== undefined);
    };

    setTestTime("2026-07-27T12:00:01.000Z");
    await runCycle();
    await runCycle();

    expect([...accepted].sort()).toEqual(["last", "live-prefix", "middle"]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("refuses an action whose caller projection does not round-trip the mail job", () => {
    const broken = defineMail<HostRecord>({
      ...hostMailProjection,
      toRecord: (job) => ({
        kind: "state",
        partition: job.partition,
        id: `mail-${job.id}`,
        value: "not-a-mail-record",
      }),
      toJob: () => null,
    });
    expect(() =>
      broken.action({
        partition: candidate.partition,
        id: candidate.jobId,
        recipientRef: "principal:42",
        contentRef: "content:1",
        createdAt: "2026-07-27T12:00:00.000Z",
      }),
    ).toThrow(/decode a valid mail job|round-trip/);
  });

  it("rejects malformed persisted jobs and accessor-bearing projection keys before provider I/O", async () => {
    const records = await pending();
    let statusReads = 0;
    const accessorProjection: MailProjection<HostRecord> = {
      ...hostMailProjection,
      toJob(record) {
        const job = hostMailProjection.toJob(record);
        if (job === null) return null;
        const malicious = { ...job };
        Object.defineProperty(malicious, "status", {
          enumerable: true,
          get() {
            statusReads += 1;
            return "pending";
          },
        });
        return malicious;
      },
    };
    const provider = { send: vi.fn(async () => ({ providerMessageRef: "x" })) };
    setTestTime("2026-07-27T12:00:01.000Z");
    await expect(
      workerFor(defineMail(accessorProjection), records, { provider }).send(
        candidate,
      ),
    ).rejects.toThrow(/projection did not decode/);
    expect(statusReads).toBe(0);
    expect(provider.send).not.toHaveBeenCalled();

    const attackerKey = defineMail<HostRecord>({
      ...hostMailProjection,
      toJob(record) {
        const job = hostMailProjection.toJob(record);
        return job === null
          ? null
          : { ...job, idempotencyKey: "attacker-controlled" };
      },
    });
    await expect(
      workerFor(attackerKey, records, { provider }).send(candidate),
    ).rejects.toThrow(/projection did not decode/);
    expect(provider.send).not.toHaveBeenCalled();

    let keyReads = 0;
    const accessorKey = defineMail<HostRecord>({
      ...hostMailProjection,
      key: () =>
        ({
          get partition() {
            keyReads += 1;
            return candidate.partition;
          },
          id: `mail-${candidate.jobId}`,
        }) as never,
    });
    await expect(
      workerFor(accessorKey, records, { provider }).send(candidate),
    ).rejects.toThrow(/own data property/);
    expect(keyReads).toBe(0);
    expect(provider.send).not.toHaveBeenCalled();

    let collectionKeyReads = 0;
    const accessorCollectionKey = defineMail<HostRecord>({
      ...hostMailProjection,
      collection: {
        ...hostRecords,
        key: () =>
          ({
            partition: candidate.partition,
            get id() {
              collectionKeyReads += 1;
              return `mail-${candidate.jobId}`;
            },
          }) as never,
      },
    });
    expect(() =>
      accessorCollectionKey.action({
        partition: candidate.partition,
        id: candidate.jobId,
        recipientRef: "principal:42",
        contentRef: "content:1",
        createdAt: "2026-07-27T12:00:00.000Z",
      }),
    ).toThrow(/own data property/);
    expect(collectionKeyReads).toBe(0);

    let candidateReads = 0;
    await expect(
      worker(records, { provider }).send({
        get partition() {
          candidateReads += 1;
          return candidate.partition;
        },
        jobId: candidate.jobId,
      } as never),
    ).rejects.toThrow(/own data property/);
    expect(candidateReads).toBe(0);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("rejects an adapter scan key that disagrees with the decoded caller record", async () => {
    const records = await pending();
    const page = await records.scan({ limit: 100 });
    const mismatched: CollectionStore<HostRecord> = {
      ...records,
      scan: async () => ({
        records: page.records.map((record) => ({
          ...record,
          key: {
            partition: record.key.partition,
            id: `${record.key.id}-wrong`,
          },
        })),
        nextCursor: null,
      }),
    };
    const send = vi.fn(async () => ({ providerMessageRef: "never" }));
    await expect(
      worker(mismatched, { provider: { send } }).runSendPage({ limit: 100 }),
    ).rejects.toThrow(/authoritative scan key/);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an overfull adapter page before provider work", async () => {
    const records = await pending();
    const page = await records.scan({ limit: 100 });
    const overfull: CollectionStore<HostRecord> = {
      ...records,
      scan: async () => ({
        records: [page.records[0]!, page.records[0]!],
        nextCursor: null,
      }),
    };
    const send = vi.fn(async () => ({ providerMessageRef: "never" }));
    await expect(
      worker(overfull, { provider: { send } }).runSendPage({ limit: 1 }),
    ).rejects.toThrow(/requested limit/);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects accessor scan elements without invoking them or provider work", async () => {
    const records = await pending();
    const page = await records.scan({ limit: 100 });
    let elementReads = 0;
    const hostile = [page.records[0]!];
    Object.defineProperty(hostile, "0", {
      configurable: true,
      enumerable: true,
      get() {
        elementReads += 1;
        return page.records[0]!;
      },
    });
    const accessorPage: CollectionStore<HostRecord> = {
      ...records,
      scan: async () => ({ records: hostile, nextCursor: null }),
    };
    const send = vi.fn(async () => ({ providerMessageRef: "never" }));

    await expect(
      worker(accessorPage, { provider: { send } }).runSendPage({ limit: 1 }),
    ).rejects.toThrow(/own data properties/);
    expect(elementReads).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a custom scan iterator without invoking it or provider work", async () => {
    const records = await pending();
    const page = await records.scan({ limit: 100 });
    let iteratorCalls = 0;
    const hostile = [page.records[0]!];
    Object.defineProperty(hostile, Symbol.iterator, {
      configurable: true,
      value() {
        iteratorCalls += 1;
        return Array.prototype[Symbol.iterator].call(hostile);
      },
    });
    const customIteratorPage: CollectionStore<HostRecord> = {
      ...records,
      scan: async () => ({ records: hostile, nextCursor: null }),
    };
    const send = vi.fn(async () => ({ providerMessageRef: "never" }));

    await expect(
      worker(customIteratorPage, { provider: { send } }).runSendPage({
        limit: 1,
      }),
    ).rejects.toThrow(/custom iterator/);
    expect(iteratorCalls).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects holes in an adapter scan array before provider work", async () => {
    const records = await pending();
    const sparse = new Array<unknown>(1);
    const sparsePage: CollectionStore<HostRecord> = {
      ...records,
      scan: async () => ({ records: sparse as never, nextCursor: null }),
    };
    const send = vi.fn(async () => ({ providerMessageRef: "never" }));

    await expect(
      worker(sparsePage, { provider: { send } }).runSendPage({ limit: 1 }),
    ).rejects.toThrow(/without holes/);
    expect(send).not.toHaveBeenCalled();
  });

  it("snapshots an ordinary adapter array and processes its record", async () => {
    const records = await pending();
    const page = await records.scan({ limit: 100 });
    const validPage: CollectionStore<HostRecord> = {
      ...records,
      scan: async () => ({ records: [page.records[0]!], nextCursor: null }),
    };
    const send = vi.fn(async () => ({ providerMessageRef: "valid-array" }));

    setTestTime("2026-07-27T12:00:01.000Z");
    expect(
      (
        await worker(validPage, { provider: { send } }).runSendPage({
          limit: 1,
        })
      ).results.map((result) => result.status),
    ).toEqual(["accepted"]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects numeric provider references and colliding candidate references before reconciliation or send", async () => {
    const records = await pending();
    const normal = worker(records, { acceptedCallbackMilliseconds: 1_000 });
    await sendAt(normal, "2026-07-27T12:00:01.000Z");
    const reconcile = vi.fn(async () => ({ status: "delivered" as const }));
    const numericProviderRef = defineMail<HostRecord>({
      ...hostMailProjection,
      toJob(record) {
        const job = hostMailProjection.toJob(record);
        return job === null
          ? null
          : ({ ...job, providerMessageRef: 42 } as never);
      },
    });
    setTestTime("2026-07-27T12:00:02.000Z");
    await expect(
      workerFor(numericProviderRef, records, {
        reconciliation: { reconcile },
      }).reconcile(candidate),
    ).rejects.toThrow(/projection did not decode/);
    expect(reconcile).not.toHaveBeenCalled();

    const impossibleAccepted = defineMail<HostRecord>({
      ...hostMailProjection,
      toJob(record) {
        const job = hostMailProjection.toJob(record);
        return job === null ? null : { ...job, attemptCount: 0 };
      },
    });
    await expect(
      workerFor(impossibleAccepted, records, {
        reconciliation: { reconcile },
      }).reconcile(candidate),
    ).rejects.toThrow(/projection did not decode/);
    expect(reconcile).not.toHaveBeenCalled();

    const collisionRecords = await pending();
    const send = vi.fn(async () => ({ providerMessageRef: "never" }));
    const colliding = defineMail<HostRecord>({
      ...hostMailProjection,
      key: ({ partition }) => ({
        partition,
        id: `mail-${candidate.jobId}`,
      }),
    });
    setTestTime("2026-07-27T12:00:01.000Z");
    expect(
      (
        await workerFor(colliding, collisionRecords, {
          provider: { send },
        }).send({
          partition: candidate.partition,
          jobId: "attacker-collision",
        })
      ).status,
    ).toBe("not_claimed");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [
      "availableAt before creation",
      (job: MailJob): MailJob => ({
        ...job,
        availableAt: "2026-07-27T11:59:59.000Z",
      }),
    ],
    [
      "acceptance before creation",
      (job: MailJob): MailJob => ({
        ...job,
        status: "accepted",
        attemptCount: 1,
        acceptedAt: "2026-07-27T11:59:59.000Z",
        acceptedDeadlineAt: "2026-07-27T12:00:01.000Z",
        providerMessageRef: "provider-malformed",
      }),
    ],
    [
      "delivery before creation",
      (job: MailJob): MailJob => ({
        ...job,
        status: "delivered",
        attemptCount: 1,
        deliveredAt: "2026-07-27T11:59:59.000Z",
        terminalAt: "2026-07-27T11:59:59.000Z",
      }),
    ],
    [
      "terminal time before acceptance",
      (job: MailJob): MailJob => ({
        ...job,
        status: "terminal_unknown",
        attemptCount: 1,
        acceptedAt: "2026-07-27T12:00:02.000Z",
        acceptedDeadlineAt: "2026-07-27T12:00:03.000Z",
        providerMessageRef: "provider-malformed",
        terminalAt: "2026-07-27T12:00:01.000Z",
        failureCategory: "delivery_status_unknown",
      }),
    ],
    [
      "provider acceptance evidence on a retryable job",
      (job: MailJob): MailJob => ({
        ...job,
        status: "retrying",
        attemptCount: 1,
        availableAt: "2026-07-27T12:00:01.000Z",
        acceptedAt: "2026-07-27T12:00:01.000Z",
        acceptedDeadlineAt: "2026-07-27T12:00:02.000Z",
        providerMessageRef: "already-accepted",
        failureCategory: "provider_unavailable",
      }),
    ],
  ])("rejects persisted chronology with %s", async (_name, mutate) => {
    const records = await pending();
    const malformed = defineMail<HostRecord>({
      ...hostMailProjection,
      toJob(record) {
        const job = hostMailProjection.toJob(record);
        return job === null ? null : mutate(job);
      },
    });
    const send = vi.fn(async () => ({ providerMessageRef: "never" }));
    await expect(
      workerFor(malformed, records, { provider: { send } }).send(candidate),
    ).rejects.toThrow(/projection did not decode/);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends with one mandatory stable idempotency key and treats acceptance as non-delivery", async () => {
    const records = await pending();
    const send = vi.fn(async (_request: unknown) => ({
      providerMessageRef: "provider-1",
    }));
    const delivery = worker(records, { provider: { send } });

    const accepted = await sendAt(delivery, "2026-07-27T12:00:01.000Z");
    const repeated = await sendAt(delivery, "2026-07-27T12:00:02.000Z");

    expect(accepted.status).toBe("accepted");
    expect(
      accepted.status === "accepted" ? accepted.job.status : undefined,
    ).toBe("accepted");
    expect(repeated.status).toBe("not_claimed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: "pegma-mail:v1:account-a:welcome:1",
      mail: { recipient: "person@example.test" },
    });
    const stored = await records.get({
      partition: candidate.partition,
      id: `mail-${candidate.jobId}`,
    });
    expect(stored?.kind === "mail" && stored.callerMetadata).toBe(
      "preserve-me",
    );
  });

  it("rotates the provider key only after authoritative reconciliation failure", async () => {
    const records = await pending();
    const keys: string[] = [];
    const delivery = worker(records, {
      acceptedCallbackMilliseconds: 1_000,
      provider: {
        send: async (request) => {
          keys.push(request.idempotencyKey);
          return { providerMessageRef: `provider-${keys.length}` };
        },
      },
      reconciliation: {
        reconcile: async () => ({
          status: "failed" as const,
          failureCategory: "provider_rejected",
        }),
      },
    });

    expect((await sendAt(delivery, "2026-07-27T12:00:01.000Z")).status).toBe(
      "accepted",
    );
    const failed = await reconcileAt(delivery, "2026-07-27T12:00:02.000Z");
    expect(failed.status).toBe("retrying");
    expect(
      failed.status === "retrying"
        ? failed.job.submissionGeneration
        : undefined,
    ).toBe(2);
    expect((await sendAt(delivery, "2026-07-27T12:00:03.000Z")).status).toBe(
      "accepted",
    );
    expect(keys).toEqual([
      "pegma-mail:v1:account-a:welcome:1",
      "pegma-mail:v1:account-a:welcome:2",
    ]);
  });

  it("keeps the same key after ambiguous send failure until a callback authoritatively rotates it", async () => {
    const records = await pending();
    const keys: string[] = [];
    const delivery = worker(records, {
      provider: {
        send: async (request) => {
          keys.push(request.idempotencyKey);
          throw new Error("ambiguous transport loss");
        },
      },
    });
    expect((await sendAt(delivery, "2026-07-27T12:00:01.000Z")).status).toBe(
      "retrying",
    );

    setTestTime("2026-07-27T12:00:02.000Z");
    const rotated = await mail.applyAuthenticatedCallback(
      records,
      {
        ...candidate,
        submissionGeneration: 1,
        status: "failed",
        failureCategory: "provider_rejected",
        occurredAt: "2026-07-27T12:00:01.500Z",
      },
      testClock,
    );
    expect(rotated?.status).toBe("retrying");
    expect(rotated?.submissionGeneration).toBe(2);
    expect(rotated?.idempotencyKey).toBe("pegma-mail:v1:account-a:welcome:2");
    expect(keys).toEqual(["pegma-mail:v1:account-a:welcome:1"]);
  });

  it("uses bounded retries and dead-letters exhausted jobs", async () => {
    const records = await pending();
    const send = vi.fn(async () => {
      throw new Error("provider secret");
    });
    const delivery = worker(records, {
      provider: { send },
      baseRetryMilliseconds: 1_000,
      classifyFailure: () => "provider_unavailable",
    });

    expect((await sendAt(delivery, "2026-07-27T12:00:01.000Z")).status).toBe(
      "retrying",
    );
    expect((await sendAt(delivery, "2026-07-27T12:00:01.500Z")).status).toBe(
      "not_claimed",
    );
    expect((await sendAt(delivery, "2026-07-27T12:00:02.000Z")).status).toBe(
      "dead_letter",
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      await mail.sweep(records, {
        terminalBefore: "2026-07-27T12:00:03.000Z",
      }),
    ).toMatchObject({ deleted: 0 });
  });

  it("lets late authenticated delivery supersede acknowledged ambiguous dead-letter and fence its sweep", async () => {
    const records = await pending();
    const delivery = worker(records, {
      provider: {
        send: async () => {
          throw new Error("ambiguous provider outcome");
        },
      },
      baseRetryMilliseconds: 1_000,
    });
    await sendAt(delivery, "2026-07-27T12:00:01.000Z");
    expect((await sendAt(delivery, "2026-07-27T12:00:02.000Z")).status).toBe(
      "dead_letter",
    );
    setTestTime("2026-07-27T12:00:03.000Z");
    expect(
      (
        await mail.acknowledgeTerminal(records, {
          ...candidate,
          acknowledgedAt: "2026-07-27T12:00:03.000Z",
          acknowledgementRef: "operator:ambiguous-send",
        })
      )?.status,
    ).toBe("dead_letter");

    const callbackResults: MailJob[] = [];
    const racingRecords: CollectionStore<HostRecord> = {
      ...records,
      async deleteIfUnchanged(key, version) {
        setTestTime("2026-07-27T12:00:04.000Z");
        const result = await mail.applyAuthenticatedCallback(
          records,
          {
            ...candidate,
            submissionGeneration: 1,
            providerMessageRef: "provider-late",
            status: "delivered",
            occurredAt: "2026-07-27T12:00:01.500Z",
          },
          testClock,
        );
        if (result !== null) callbackResults.push(result);
        return records.deleteIfUnchanged(key, version);
      },
    };

    expect(
      await mail.sweep(racingRecords, {
        terminalBefore: "2026-07-27T12:00:03.500Z",
      }),
    ).toMatchObject({ deleted: 0, more: true });
    expect(callbackResults).toHaveLength(1);
    expect(callbackResults[0]).toMatchObject({
      status: "delivered",
      providerMessageRef: "provider-late",
      deliveredAt: "2026-07-27T12:00:04.000Z",
      terminalAt: "2026-07-27T12:00:04.000Z",
    });
    expect(callbackResults[0]?.acknowledgedAt).toBeUndefined();
    expect(callbackResults[0]?.acknowledgementRef).toBeUndefined();
    expect(callbackResults[0]?.failureCategory).toBeUndefined();
    expect(
      await records.get({
        partition: candidate.partition,
        id: `mail-${candidate.jobId}`,
      }),
    ).not.toBeNull();
  });

  it("fences a stale send completion with a fresh UUID claim token", async () => {
    const records = await pending();
    let releaseFirst:
      ((value: { providerMessageRef: string }) => void) | undefined;
    const firstProviderResult = new Promise<{ providerMessageRef: string }>(
      (resolve) => {
        releaseFirst = resolve;
      },
    );
    let calls = 0;
    const keys: string[] = [];
    const delivery = worker(records, {
      leaseMilliseconds: 1_000,
      provider: {
        send: async (request) => {
          calls += 1;
          keys.push(request.idempotencyKey);
          return calls === 1
            ? firstProviderResult
            : { providerMessageRef: "provider-new" };
        },
      },
    });

    setTestTime("2026-07-27T12:00:01.000Z");
    const stale = delivery.send(candidate);
    await vi.waitFor(() => expect(calls).toBe(1));
    const recovered = await sendAt(delivery, "2026-07-27T12:00:02.000Z");
    releaseFirst?.({ providerMessageRef: "provider-stale" });

    expect(recovered.status).toBe("accepted");
    expect((await stale).status).toBe("not_claimed");
    expect(
      recovered.status === "accepted"
        ? recovered.job.providerMessageRef
        : undefined,
    ).toBe("provider-new");
    expect(keys).toEqual([
      "pegma-mail:v1:account-a:welcome:1",
      "pegma-mail:v1:account-a:welcome:1",
    ]);
  });

  it("durably applies an early failed callback, fences the pending response, and ignores the old generation later", async () => {
    const records = await pending();
    let release: ((value: { providerMessageRef: string }) => void) | undefined;
    const pendingProvider = new Promise<{ providerMessageRef: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const keys: string[] = [];
    const delivery = worker(records, {
      provider: {
        send: async (request) => {
          keys.push(request.idempotencyKey);
          return keys.length === 1
            ? pendingProvider
            : { providerMessageRef: "provider-generation-2" };
        },
      },
    });

    setTestTime("2026-07-27T12:00:01.000Z");
    const inFlight = delivery.send(candidate);
    await vi.waitFor(() => expect(keys).toHaveLength(1));
    setTestTime("2026-07-27T12:00:02.000Z");
    const failed = await mail.applyAuthenticatedCallback(
      records,
      {
        ...candidate,
        submissionGeneration: 1,
        status: "failed",
        failureCategory: "provider_rejected",
        occurredAt: "2026-07-27T12:00:01.500Z",
      },
      testClock,
    );
    expect(failed?.status).toBe("retrying");
    expect(failed?.submissionGeneration).toBe(2);
    release?.({ providerMessageRef: "provider-generation-1" });
    expect((await inFlight).status).toBe("not_claimed");

    expect((await sendAt(delivery, "2026-07-27T12:00:03.000Z")).status).toBe(
      "accepted",
    );
    setTestTime("2026-07-27T12:00:04.000Z");
    expect(
      await mail.applyAuthenticatedCallback(
        records,
        {
          ...candidate,
          submissionGeneration: 1,
          providerMessageRef: "provider-generation-1",
          status: "failed",
          failureCategory: "late_old_failure",
          occurredAt: "2026-07-27T12:00:03.500Z",
        },
        testClock,
      ),
    ).toBeNull();
    const stored = await records.get({
      partition: candidate.partition,
      id: `mail-${candidate.jobId}`,
    });
    expect(stored?.kind === "mail" ? stored.job.status : undefined).toBe(
      "accepted",
    );
    expect(
      stored?.kind === "mail" ? stored.job.submissionGeneration : undefined,
    ).toBe(2);
    expect(keys).toEqual([
      "pegma-mail:v1:account-a:welcome:1",
      "pegma-mail:v1:account-a:welcome:2",
    ]);
  });

  it("durably applies an early delivered callback and the provider response cannot regress it", async () => {
    const records = await pending();
    let release: ((value: { providerMessageRef: string }) => void) | undefined;
    const pendingProvider = new Promise<{ providerMessageRef: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    let providerCalled = false;
    const delivery = worker(records, {
      provider: {
        send: async () => {
          providerCalled = true;
          return pendingProvider;
        },
      },
    });
    setTestTime("2026-07-27T12:00:01.000Z");
    const inFlight = delivery.send(candidate);
    await vi.waitFor(() => expect(providerCalled).toBe(true));
    setTestTime("2026-07-27T12:00:02.000Z");
    const delivered = await mail.applyAuthenticatedCallback(
      records,
      {
        ...candidate,
        submissionGeneration: 1,
        providerMessageRef: "provider-early",
        status: "delivered",
        occurredAt: "2026-07-27T12:00:01.500Z",
      },
      testClock,
    );
    expect(delivered).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-07-27T12:00:02.000Z",
      providerOccurredAt: "2026-07-27T12:00:01.500Z",
    });
    release?.({ providerMessageRef: "provider-early" });
    expect((await inFlight).status).toBe("not_claimed");
  });

  it.each(["failed", "delivered"] as const)(
    "does not invoke the provider when a %s callback resolves the claim during preparation",
    async (callbackStatus) => {
      const records = await pending();
      let releasePreparation: (() => void) | undefined;
      const preparationBlocked = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      const prepare = vi.fn(async () => {
        await preparationBlocked;
        return {
          recipient: "person@example.test",
          subject: "Subject",
          text: "Body",
        };
      });
      const providerKeys: string[] = [];
      const delivery = worker(records, {
        preparation: { prepare },
        provider: {
          send: async (request) => {
            providerKeys.push(request.idempotencyKey);
            return { providerMessageRef: "provider-current" };
          },
        },
      });

      setTestTime("2026-07-27T12:00:01.000Z");
      const stale = delivery.send(candidate);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());

      setTestTime("2026-07-27T12:00:02.000Z");
      const callback = await mail.applyAuthenticatedCallback(
        records,
        {
          ...candidate,
          submissionGeneration: 1,
          providerMessageRef: "provider-generation-1",
          status: callbackStatus,
          occurredAt: "2026-07-27T12:00:01.500Z",
          ...(callbackStatus === "failed"
            ? { failureCategory: "provider_rejected" }
            : {}),
        },
        testClock,
      );
      expect(callback?.status).toBe(
        callbackStatus === "failed" ? "retrying" : "delivered",
      );

      releasePreparation?.();
      expect((await stale).status).toBe("not_claimed");
      expect(providerKeys).toEqual([]);

      setTestTime("2026-07-27T12:00:03.000Z");
      const next = await delivery.send(candidate);
      if (callbackStatus === "failed") {
        expect(next.status).toBe("accepted");
        expect(providerKeys).toEqual(["pegma-mail:v1:account-a:welcome:2"]);
      } else {
        expect(next.status).toBe("not_claimed");
        expect(providerKeys).toEqual([]);
      }
    },
  );

  it("never lets an expired reconciliation lease cross into the send lane", async () => {
    const records = await pending();
    const delivery = worker(records, {
      leaseMilliseconds: 1_000,
      acceptedCallbackMilliseconds: 1_000,
    });
    expect((await sendAt(delivery, "2026-07-27T12:00:01.000Z")).status).toBe(
      "accepted",
    );

    let release: ((value: { status: "unknown" }) => void) | undefined;
    const status = new Promise<{ status: "unknown" }>((resolve) => {
      release = resolve;
    });
    const reconciling = worker(records, {
      workerId: "reconciler-a",
      leaseMilliseconds: 1_000,
      acceptedCallbackMilliseconds: 1_000,
      reconciliation: { reconcile: async () => status },
    });
    setTestTime("2026-07-27T12:00:02.000Z");
    const stale = reconciling.reconcile(candidate);
    await Promise.resolve();

    expect((await sendAt(delivery, "2026-07-27T12:00:03.000Z")).status).toBe(
      "not_claimed",
    );
    const recovered = worker(records, {
      workerId: "reconciler-b",
      leaseMilliseconds: 1_000,
      acceptedCallbackMilliseconds: 1_000,
    });
    expect(
      (await reconcileAt(recovered, "2026-07-27T12:00:03.000Z")).status,
    ).toBe("terminal_unknown");
    release?.({ status: "unknown" });
    expect((await stale).status).toBe("not_claimed");
  });

  it("normalizes provider results without invoking accessors", async () => {
    let preparationReads = 0;
    let sendReads = 0;
    const preparationRecords = await pending();
    const invalidPreparation = worker(preparationRecords, {
      preparation: {
        prepare: async () => ({
          recipient: "person@example.test",
          subject: "Subject",
          get text() {
            preparationReads += 1;
            return "must not execute";
          },
        }),
      },
    });
    expect(
      (await sendAt(invalidPreparation, "2026-07-27T12:00:01.000Z")).status,
    ).toBe("retrying");

    const sendRecords = await pending();
    const invalidSend = worker(sendRecords, {
      provider: {
        send: async () => ({
          get providerMessageRef() {
            sendReads += 1;
            return "must not execute";
          },
        }),
      },
    });
    expect((await sendAt(invalidSend, "2026-07-27T12:00:01.000Z")).status).toBe(
      "retrying",
    );

    const numericRecords = await pending();
    const numericSend = worker(numericRecords, {
      provider: {
        send: async () => ({ providerMessageRef: 42 }) as never,
      },
    });
    expect((await sendAt(numericSend, "2026-07-27T12:00:01.000Z")).status).toBe(
      "retrying",
    );
    expect(preparationReads).toBe(0);
    expect(sendReads).toBe(0);
  });

  it("uses trusted post-I/O time for acceptance and reconciliation, and rejects a backward clock", async () => {
    const records = await pending();
    const times = ["2026-07-27T12:00:01.000Z", "2026-07-27T12:00:05.000Z"];
    const delivery = worker(records, {
      clock: { now: () => times.shift() ?? "invalid" },
      acceptedCallbackMilliseconds: 1_000,
    });
    const accepted = await delivery.send(candidate);
    expect(accepted.status === "accepted" ? accepted.job : null).toMatchObject({
      acceptedAt: "2026-07-27T12:00:05.000Z",
      acceptedDeadlineAt: "2026-07-27T12:00:06.000Z",
    });

    const reconcileTimes = [
      "2026-07-27T12:00:06.000Z",
      "2026-07-27T12:00:09.000Z",
    ];
    const reconciliation = worker(records, {
      clock: { now: () => reconcileTimes.shift() ?? "invalid" },
      acceptedCallbackMilliseconds: 1_000,
    });
    const unknown = await reconciliation.reconcile(candidate);
    expect(
      unknown.status === "terminal_unknown" ? unknown.job.terminalAt : null,
    ).toBe("2026-07-27T12:00:09.000Z");

    const backwardRecords = await pending();
    const backwardTimes = [
      "2026-07-27T12:00:05.000Z",
      "2026-07-27T12:00:04.000Z",
    ];
    const backward = worker(backwardRecords, {
      clock: { now: () => backwardTimes.shift() ?? "invalid" },
    });
    await expect(backward.send(candidate)).rejects.toThrow(/moved backward/);
  });

  it("rejects a callback clock before persisted operational time and cannot backdate retention", async () => {
    const records = await pending();
    const delivery = worker(records);
    await sendAt(delivery, "2026-07-27T12:00:01.000Z");

    setTestTime("2026-07-27T11:00:00.000Z");
    await expect(
      mail.applyAuthenticatedCallback(
        records,
        {
          ...candidate,
          submissionGeneration: 1,
          providerMessageRef: "provider-1",
          status: "delivered",
          occurredAt: "2026-07-27T12:00:01.500Z",
        },
        testClock,
      ),
    ).rejects.toThrow(/precedes persisted mail operational time/);
    expect(
      await mail.sweep(records, {
        terminalBefore: "2026-07-27T11:30:00.000Z",
      }),
    ).toMatchObject({ deleted: 0 });
    const stored = await records.get({
      partition: candidate.partition,
      id: `mail-${candidate.jobId}`,
    });
    expect(stored?.kind === "mail" ? stored.job.status : undefined).toBe(
      "accepted",
    );
  });

  it("maps malformed reconciliation to terminal unknown without invoking accessors", async () => {
    const malformed: unknown[] = [null, { status: "other" }];
    let statusReads = 0;
    let failureReads = 0;
    malformed.push(
      {
        get status() {
          statusReads += 1;
          return "delivered";
        },
      },
      {
        status: "failed",
        get failureCategory() {
          failureReads += 1;
          return "provider_failed";
        },
      },
    );

    for (const result of malformed) {
      const records = await pending();
      const delivery = worker(records, {
        acceptedCallbackMilliseconds: 1_000,
        reconciliation: { reconcile: async () => result as never },
      });
      await sendAt(delivery, "2026-07-27T12:00:01.000Z");
      expect(
        (await reconcileAt(delivery, "2026-07-27T12:00:02.000Z")).status,
      ).toBe("terminal_unknown");
    }
    expect(statusReads).toBe(0);
    expect(failureReads).toBe(0);
  });

  it("allows a late authenticated delivery callback to resolve terminal unknown and never regresses delivered", async () => {
    const records = await pending();
    const delivery = worker(records, { acceptedCallbackMilliseconds: 1_000 });
    await sendAt(delivery, "2026-07-27T12:00:01.000Z");
    await reconcileAt(delivery, "2026-07-27T12:00:02.000Z");

    setTestTime("2026-07-27T12:00:04.000Z");
    const delivered = await mail.applyAuthenticatedCallback(
      records,
      {
        ...candidate,
        jobId: candidate.jobId,
        submissionGeneration: 1,
        status: "delivered",
        occurredAt: "2026-07-27T12:00:03.000Z",
      },
      testClock,
    );
    expect(delivered?.status).toBe("delivered");
    expect(
      await mail.applyAuthenticatedCallback(
        records,
        {
          ...candidate,
          jobId: candidate.jobId,
          submissionGeneration: 1,
          status: "failed",
          failureCategory: "late_failure",
          occurredAt: "2026-07-27T12:00:04.000Z",
        },
        testClock,
      ),
    ).toBeNull();
    const stored = await records.get({
      partition: candidate.partition,
      id: `mail-${candidate.jobId}`,
    });
    expect(stored?.kind === "mail" ? stored.job.status : undefined).toBe(
      "delivered",
    );
  });

  it("snapshots callback own data without invoking accessors and rejects malformed runtime status", async () => {
    const records = await pending();
    let statusReads = 0;
    let occurredReads = 0;
    const accessorCallback = {
      partition: candidate.partition,
      jobId: candidate.jobId,
      submissionGeneration: 1,
      get status() {
        statusReads += 1;
        return statusReads === 1 ? "failed" : "delivered";
      },
      get occurredAt() {
        occurredReads += 1;
        return "2026-07-27T12:00:01.000Z";
      },
      failureCategory: "provider_rejected",
    };
    await expect(
      mail.applyAuthenticatedCallback(
        records,
        accessorCallback as never,
        testClock,
      ),
    ).rejects.toThrow(/own data property/);
    expect(statusReads).toBe(0);
    expect(occurredReads).toBe(0);

    await expect(
      mail.applyAuthenticatedCallback(
        records,
        {
          ...candidate,
          submissionGeneration: 1,
          status: "accepted",
          occurredAt: "2026-07-27T12:00:01.000Z",
        } as never,
        testClock,
      ),
    ).rejects.toThrow(/delivered or failed/);
    await expect(
      mail.applyAuthenticatedCallback(
        records,
        {
          ...candidate,
          submissionGeneration: 1,
          providerMessageRef: 42,
          status: "delivered",
          occurredAt: "2026-07-27T12:00:01.000Z",
        } as never,
        testClock,
      ),
    ).rejects.toThrow(/providerMessageRef/);
  });

  it("bounds authoritative terminal scan pages and exposes the opaque continuation", async () => {
    const records = await pending();
    await records.put({
      kind: "state",
      partition: candidate.partition,
      id: "caller-state",
      value: "live",
    });
    const result = await mail.sweep(records, {
      terminalBefore: "2026-07-27T12:00:03.000Z",
      limit: 1,
    });

    expect(result).toMatchObject({ examined: 1, deleted: 0, more: true });
    expect(typeof result.nextCursor).toBe("string");
  });

  it("enforces strict storage scan page limits", async () => {
    const records = await pending();
    await expect(
      mail.sweep(records, {
        terminalBefore: "2026-07-27T12:00:03.000Z",
        limit: 0,
      }),
    ).rejects.toThrow(/limit/);
    await expect(worker(records).runSendPage({ limit: 1_001 })).rejects.toThrow(
      /limit/,
    );
  });

  it("keeps cross-partition caller rows safe and makes terminal page replay harmless", async () => {
    const records = await pending();
    const callerState: HostRecord = {
      kind: "state",
      partition: candidate.partition,
      id: "caller-state",
      value: "must-survive",
    };
    await records.put(callerState);
    const delivery = worker(records);
    await sendAt(delivery, "2026-07-27T12:00:01.000Z");
    setTestTime("2026-07-27T12:00:02.000Z");
    await mail.applyAuthenticatedCallback(
      records,
      {
        ...candidate,
        submissionGeneration: 1,
        status: "delivered",
        occurredAt: "2026-07-27T12:00:01.500Z",
      },
      testClock,
    );

    await records.transact("other-account", [
      mail.action({
        partition: "other-account",
        id: "other-mail",
        recipientRef: "principal:other",
        contentRef: "content:other",
        createdAt: "2026-07-27T12:00:00.000Z",
      }),
    ]);
    const completed = await mail.sweep(records, {
      terminalBefore: "2026-07-27T12:00:03.000Z",
      limit: 10,
    });
    expect(completed).toEqual({
      examined: 3,
      deleted: 1,
      nextCursor: null,
      more: false,
    });
    expect(
      await mail.sweep(records, {
        terminalBefore: "2026-07-27T12:00:03.000Z",
        limit: 10,
      }),
    ).toEqual({
      examined: 2,
      deleted: 0,
      nextCursor: null,
      more: false,
    });
    expect(
      await records.get({
        partition: callerState.partition,
        id: callerState.id,
      }),
    ).toEqual(callerState);
    expect(
      await records.get({
        partition: "other-account",
        id: "mail-other-mail",
      }),
    ).not.toBeNull();
  });

  it("automates only delivered retention and requires explicit acknowledgement for uncertain terminal work", async () => {
    const records = await pending();
    const delivery = worker(records, { acceptedCallbackMilliseconds: 1_000 });
    await sendAt(delivery, "2026-07-27T12:00:01.000Z");
    await reconcileAt(delivery, "2026-07-27T12:00:02.000Z");

    expect(
      await mail.sweep(records, {
        terminalBefore: "2026-07-27T12:00:03.000Z",
      }),
    ).toMatchObject({ deleted: 0 });
    expect(
      (
        await mail.acknowledgeTerminal(records, {
          ...candidate,
          jobId: candidate.jobId,
          acknowledgedAt: "2026-07-27T12:00:03.000Z",
          acknowledgementRef: "operator:case-123",
        })
      )?.status,
    ).toBe("terminal_unknown");
    expect(
      await mail.sweep(records, {
        terminalBefore: "2026-07-27T12:00:04.000Z",
      }),
    ).toMatchObject({ deleted: 1 });
  });

  it("does not delete a terminal row that changes after sweep enumeration", async () => {
    const records = await pending();
    const delivery = worker(records);
    await sendAt(delivery, "2026-07-27T12:00:01.000Z");
    setTestTime("2026-07-27T12:00:02.000Z");
    await mail.applyAuthenticatedCallback(
      records,
      {
        ...candidate,
        jobId: candidate.jobId,
        submissionGeneration: 1,
        status: "delivered",
        occurredAt: "2026-07-27T12:00:01.500Z",
      },
      testClock,
    );
    let raced = false;
    const racingRecords: CollectionStore<HostRecord> = {
      ...records,
      async deleteIfUnchanged(key, version) {
        if (!raced) {
          raced = true;
          await records.update(key, (current) =>
            current?.kind === "mail"
              ? {
                  action: "write",
                  value: {
                    ...current,
                    job: {
                      ...current.job,
                      providerMessageRef: "callback-won-the-race",
                    },
                  },
                }
              : { action: "keep" },
          );
        }
        return records.deleteIfUnchanged(key, version);
      },
    };

    expect(
      await mail.sweep(racingRecords, {
        terminalBefore: "2026-07-27T12:00:03.000Z",
      }),
    ).toMatchObject({ deleted: 0, more: true });
    expect(
      await records.get({
        partition: candidate.partition,
        id: `mail-${candidate.jobId}`,
      }),
    ).not.toBeNull();
  });

  it("refuses a same-version projection key collision instead of deleting caller data", async () => {
    const records = await pending();
    const state: HostRecord = {
      kind: "state",
      partition: candidate.partition,
      id: "caller-live-state",
      value: "must-survive",
    };
    await records.put(state);
    const delivery = worker(records);
    await sendAt(delivery, "2026-07-27T12:00:01.000Z");
    setTestTime("2026-07-27T12:00:02.000Z");
    await mail.applyAuthenticatedCallback(
      records,
      {
        ...candidate,
        submissionGeneration: 1,
        status: "delivered",
        occurredAt: "2026-07-27T12:00:01.500Z",
      },
      testClock,
    );
    const wrongCollectionKey = defineMail<HostRecord>({
      ...hostMailProjection,
      collection: {
        ...hostRecords,
        key(record) {
          return record.kind === "mail"
            ? {
                partition: record.partition,
                id: "caller-live-state",
              }
            : hostRecords.key(record);
        },
      },
    });

    await expect(
      wrongCollectionKey.sweep(records, {
        terminalBefore: "2026-07-27T12:00:03.000Z",
      }),
    ).rejects.toThrow(/projection.*key/);
    expect(
      await records.get({
        partition: candidate.partition,
        id: "caller-live-state",
      }),
    ).toEqual(state);
  });

  it("derives separate send and reconciliation decisions from authoritative scan pages", async () => {
    const records = await pending();
    const delivery = worker(records, {
      acceptedCallbackMilliseconds: 1_000,
    });
    setTestTime("2026-07-27T12:00:01.000Z");
    expect(
      (await delivery.runSendPage({ limit: 100 })).results.map(
        (result) => result.status,
      ),
    ).toEqual(["accepted"]);
    setTestTime("2026-07-27T12:00:02.000Z");
    expect(
      (await delivery.runReconciliationPage({ limit: 100 })).results.map(
        (result) => result.status,
      ),
    ).toEqual(["terminal_unknown"]);
    setTestTime("2026-07-27T12:00:03.000Z");
    expect(
      (await delivery.runSendPage({ limit: 100 })).results.map(
        (result) => result.status,
      ),
    ).toEqual(["not_claimed"]);
  });
});
