# @pegma/mail

Durable transactional-mail jobs for Pegma hosts.

The package owns no store, collection, or partition. `defineMail` binds it to
the caller's record union. `mail.action(...)` returns an insert action that the
caller commits in the same `@pegma/storage-core` transaction as the state
change that caused the message.

```ts
const mail = defineMail({
  collection: applicationRecords,
  key: ({ partition, jobId }) => ({
    partition,
    id: `mail:${jobId}`,
  }),
  toRecord: (job, previous) =>
    previous?.kind === "mail_job"
      ? { ...previous, job }
      : {
          kind: "mail_job",
          partition: job.partition,
          id: `mail:${job.id}`,
          job,
          callerMetadata: "preserved across worker transitions",
        },
  toJob: (record) => (record.kind === "mail_job" ? record.job : null),
});

await records.transact(accountId, [
  enrollmentAction,
  mail.action({
    partition: accountId,
    id: notificationId,
    recipientRef: principalId,
    contentRef: enrollmentMessageId,
    createdAt: clock.now(),
  }),
]);
```

The host supplies content preparation, an idempotent provider send adapter,
reconciliation, a trusted clock, and scheduling. Discovery itself is not a host
port: `runSendPage`, `runReconciliationPage`, and `sweep` call the storage
adapter's authoritative cross-partition `CollectionStore.scan` over the
caller's collection. A separately persisted post-commit candidate hint is not
valid because a crash between the caller transaction and that hint could
strand mail forever.

Each call examines at most the requested page limit and returns the storage
adapter's opaque `nextCursor`. Persist that cursor only after the page
completes. If the process crashes first, replay the prior cursor; claims make
repeated records safe. Follow `nextCursor` through `null`, then omit it to
start the next complete cycle. Storage promises no filter, order, or snapshot,
so rows written behind a cursor may wait for that next cycle but cannot be
permanently lost across repeated complete cycles. Maintain independent cursor
state for sending, reconciliation, and terminal sweeping.

Mail validates the adapter-reported physical key against the decoded caller
record and projection. Claims still re-read the current row through an
`update` decider, so an uncommitted phantom or stale scan row cannot authorize
work. Sending and reconciliation remain separate fenced lanes. Provider
acceptance is not confirmed delivery. Completion, retry, deadline, and
terminal times are sampled after provider I/O, not backdated to claim time or
provider-reported event time. Callback processing refuses trusted clock
samples that precede persisted operational history.

One logical provider submission has one generation and one key. Ambiguous send
failures and crash recovery reuse that key. Only an authenticated callback or
reconciliation result that authoritatively reports failure advances the
generation and rotates the key before another physical submission.
`maxAttempts` bounds recorded completed attempts and submission generations,
not actual provider calls.

Preparation, send, and reconciliation adapters must settle before the worker
lease expires, enforcing their own finite I/O timeouts comfortably below that
lease. A promise that remains pending cannot be cancelled by this package;
after lease expiry another worker may start overlapping work. Recovered sends
reuse the same idempotency key, which prevents a logical duplicate only when
the provider honors that key.

Authenticated callbacks identify the submission generation (and may also carry
the provider message reference). This fences delayed callbacks from older
submissions. A callback that resolves a claim during preparation prevents the
stale worker from crossing the final storage-fenced provider-call boundary.
Callbacks can confirm late delivery after `terminal_unknown` or an ambiguous
same-generation `dead_letter`; confirmation clears prior acknowledgement,
advances the record version, and confirmed delivery never regresses. Provider
`occurredAt` is retained as evidence but never drives scheduling or retention.
The package does not verify or deduplicate webhooks.

Terminal retention consumes the same authoritative scan pages. It deletes with
the adapter-reported physical key and version through `deleteIfUnchanged`.
Stale, repeated, and colliding rows cannot authorize deletion. `dead_letter`
and `terminal_unknown` are eligible only after explicit operator
acknowledgement; delivered jobs do not require acknowledgement.

The package intentionally contains no provider SDK, rendering or templating,
webhook receipt store, inbound mail, bulk mail, or deliverability abstraction.

## Distribution

Version `0.1.0` is the first advertised supported release and requires
`@pegma/spine@0.1.1` and `@pegma/storage-core@0.4.0` exactly. Version `0.0.0`
exists only for the one-time, manual npm package-name bootstrap; it is packed
and integrity-verified by a separate mode. Every `0.0.x` version remains
rejected by the normal OIDC lane. See the repository release procedure.
