import {
  defineCollection,
  type Codec,
  type StoredRecord,
} from "@pegma/storage-core";
import { defineMail, type MailJob, type MailProjection } from "./index.js";

export type HostRecord =
  | {
      readonly kind: "state";
      readonly partition: string;
      readonly id: string;
      readonly value: string;
    }
  | {
      readonly kind: "mail";
      readonly partition: string;
      readonly id: string;
      readonly job: MailJob;
      readonly callerMetadata: string;
    };

const codec: Codec<HostRecord> = {
  encode(value) {
    return {
      partition: value.partition,
      id: value.id,
      payload: JSON.stringify(value),
    };
  },
  decode(record: StoredRecord) {
    if (typeof record["payload"] !== "string") {
      throw new TypeError("host test record has no payload");
    }
    return JSON.parse(record["payload"]) as HostRecord;
  },
};

export const hostRecords = defineCollection<HostRecord>({
  name: "mail_host_records_v1",
  key: (record) => ({ partition: record.partition, id: record.id }),
  codec,
});

export const hostMailProjection: MailProjection<HostRecord> = {
  collection: hostRecords,
  key: ({ partition, jobId }) => ({
    partition,
    id: `mail-${jobId}`,
  }),
  toRecord: (job, previous) =>
    previous?.kind === "mail"
      ? { ...previous, job }
      : {
          kind: "mail",
          partition: job.partition,
          id: `mail-${job.id}`,
          job,
          callerMetadata: "preserve-me",
        },
  toJob: (record) => (record.kind === "mail" ? record.job : null),
};

export const mail = defineMail(hostMailProjection);

export const candidate = {
  partition: "account-a",
  jobId: "welcome",
} as const;

export function mailAction(createdAt = "2026-07-27T12:00:00.000Z") {
  return mail.action({
    ...candidate,
    id: candidate.jobId,
    recipientRef: "principal:42",
    contentRef: "identity.enrollment:v1:message-1",
    createdAt,
    maxAttempts: 2,
  });
}

export const preparation = {
  prepare: async () => ({
    recipient: "person@example.test",
    subject: "Finish enrollment",
    text: "Use your enrollment code.",
  }),
};

export const unknownReconciliation = {
  reconcile: async () => ({ status: "unknown" as const }),
};

let currentTime = "2026-07-27T12:00:00.000Z";

export const testClock = {
  now: () => currentTime,
};

export function setTestTime(value: string): void {
  currentTime = value;
}
