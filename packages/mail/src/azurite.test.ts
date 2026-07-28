import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { expect, it } from "vitest";
import { TABLE_PORT } from "../../../test/azurite.js";
import {
  candidate,
  hostRecords,
  mail,
  mailAction,
  preparation,
  setTestTime,
  testClock,
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

it("preserves atomic projection, lease fencing, and conditional retention on real Azurite", async () => {
  const records = freshRecords();
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
    mailAction(),
  ]);
  expect(transaction.committed).toBe(true);

  const worker = mail.worker({
    records,
    clock: testClock,
    workerId: "azure-worker",
    provider: {
      send: async () => ({ providerMessageRef: "azure-provider-ref" }),
    },
    reconciliation: unknownReconciliation,
    preparation,
    sendCandidates: { next: async () => null },
    reconciliationCandidates: { next: async () => null },
    acceptedCallbackMilliseconds: 1_000,
  });
  setTestTime("2026-07-27T12:00:01.000Z");
  expect((await worker.send(candidate)).status).toBe("accepted");
  setTestTime("2026-07-27T12:00:02.000Z");
  expect((await worker.reconcile(candidate)).status).toBe("terminal_unknown");

  expect(
    await mail.sweep(records, candidate.partition, {
      terminalBefore: "2026-07-27T12:00:03.000Z",
      candidates: {
        next: async () => candidate,
      },
      limit: 1,
    }),
  ).toMatchObject({ deleted: 0 });
  await mail.acknowledgeTerminal(records, {
    ...candidate,
    jobId: candidate.jobId,
    acknowledgedAt: "2026-07-27T12:00:03.000Z",
    acknowledgementRef: "operator:azure-test",
  });
  expect(
    await mail.sweep(records, candidate.partition, {
      terminalBefore: "2026-07-27T12:00:04.000Z",
      candidates: {
        next: async () => candidate,
      },
      limit: 1,
    }),
  ).toMatchObject({ deleted: 1 });
});
