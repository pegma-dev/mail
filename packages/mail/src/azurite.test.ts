import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import type { CollectionStore } from "@pegma/storage-core";
import { expect, it, vi } from "vitest";
import { TABLE_PORT } from "../../../test/azurite.js";
import {
  candidate,
  hostRecords,
  mail,
  mailAction,
  preparation,
  setTestTime,
  testClock,
  type HostRecord,
  unknownReconciliation,
} from "./test-support.js";

const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONNECTION_STRING = [
  "DefaultEndpointsProtocol=http",
  `AccountName=${ACCOUNT}`,
  `AccountKey=${KEY}`,
  `TableEndpoint=http://127.0.0.1:${TABLE_PORT}/${ACCOUNT};`,
].join(";");

let table = 0;

function freshRecords() {
  table += 1;
  const client = TableClient.fromConnectionString(
    CONNECTION_STRING,
    `pegmamail${process.pid}t${table}`,
    { allowInsecureConnection: true },
  );
  return createAzureTablesStore({ client }).collection(hostRecords);
}

it("keeps authoritative discovery atomic through crash, claims, and terminal retention on real Azurite", async () => {
  const records = freshRecords();
  const projected = mailAction();
  const send = vi.fn(async () => ({
    providerMessageRef: "azure-provider-ref",
  }));
  setTestTime("2026-07-27T12:00:01.000Z");
  expect(
    await mail
      .worker({
        records,
        clock: testClock,
        workerId: "precommit-worker",
        provider: { send },
        reconciliation: unknownReconciliation,
        preparation,
      })
      .runSendPage({ limit: 100 }),
  ).toEqual({ examined: 0, results: [], nextCursor: null });
  expect(send).not.toHaveBeenCalled();

  const transaction = await records.transact(candidate.partition, [
    {
      action: "insert",
      value: {
        kind: "state",
        partition: candidate.partition,
        id: "identity",
        value: "enrolled",
      },
    },
    projected,
  ]);
  expect(transaction.committed).toBe(true);

  // A restarted host has only the committed rows; no post-commit hint exists.
  const worker = mail.worker({
    records,
    clock: testClock,
    workerId: "azure-worker",
    provider: { send },
    reconciliation: unknownReconciliation,
    preparation,
    acceptedCallbackMilliseconds: 1_000,
  });
  setTestTime("2026-07-27T12:00:01.000Z");
  const completed = await worker.runSendPage({ limit: 100 });
  expect(completed.results.map((result) => result.status)).toEqual([
    "accepted",
  ]);
  // Crash before saving completed.nextCursor: replay the same scan start.
  expect(
    (await worker.runSendPage({ limit: 100 })).results.map(
      (result) => result.status,
    ),
  ).toEqual(["not_claimed"]);
  expect(send).toHaveBeenCalledOnce();

  await records.transact("account-z", [
    mail.action({
      partition: "account-z",
      id: "fair-page",
      recipientRef: "principal:fair-page",
      contentRef: "content:fair-page",
      createdAt: "2026-07-27T12:00:00.000Z",
    }),
  ]);
  const accepted = new Set<string>();
  let insertedLivePrefix = false;
  const runCycle = async () => {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await worker.runSendPage({
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
            id: "azure-live-prefix",
            recipientRef: "principal:azure-live-prefix",
            contentRef: "content:azure-live-prefix",
            createdAt: "2026-07-27T12:00:00.000Z",
          }),
        ]);
      }
      cursor = page.nextCursor ?? undefined;
      if (pages > 10)
        throw new Error("Azure mail scan cycle did not terminate");
    } while (cursor !== undefined);
  };
  await runCycle();
  await runCycle();
  expect([...accepted].sort()).toEqual(["azure-live-prefix", "fair-page"]);
  expect(send).toHaveBeenCalledTimes(3);

  setTestTime("2026-07-27T12:00:02.000Z");
  expect(
    (await worker.runReconciliationPage({ limit: 100 })).results.map(
      (result) => result.status,
    ),
  ).toEqual(["terminal_unknown", "terminal_unknown", "terminal_unknown"]);

  expect(
    await mail.sweep(records, {
      terminalBefore: "2026-07-27T12:00:03.000Z",
      limit: 100,
    }),
  ).toMatchObject({ deleted: 0 });
  await mail.acknowledgeTerminal(records, {
    ...candidate,
    jobId: candidate.jobId,
    acknowledgedAt: "2026-07-27T12:00:03.000Z",
    acknowledgementRef: "operator:azure-test",
  });

  let raced = false;
  const racingRecords: CollectionStore<HostRecord> = {
    ...records,
    async deleteIfUnchanged(key, version) {
      if (!raced && key.partition === candidate.partition) {
        raced = true;
        setTestTime("2026-07-27T12:00:04.000Z");
        await mail.applyAuthenticatedCallback(
          records,
          {
            ...candidate,
            submissionGeneration: 1,
            status: "delivered",
            occurredAt: "2026-07-27T12:00:03.500Z",
          },
          testClock,
        );
      }
      return records.deleteIfUnchanged(key, version);
    },
  };
  expect(
    await mail.sweep(racingRecords, {
      terminalBefore: "2026-07-27T12:00:03.500Z",
      limit: 100,
    }),
  ).toMatchObject({ deleted: 0, more: true });
  expect(raced).toBe(true);
  expect(
    await mail.sweep(records, {
      terminalBefore: "2026-07-27T12:00:05.000Z",
      limit: 100,
    }),
  ).toMatchObject({ deleted: 1 });
});
