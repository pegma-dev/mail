# Mail Architecture

## Atomicity is the product

`@pegma/mail` owns no store, collection, or partition. Storage Core transactions
cover one collection and one partition, so a separate mail collection could
not commit atomically with an Identity enrollment or Support Desk reply.

A caller defines one projection:

```text
caller state change ─┐
                     ├─ caller records.transact(caller partition)
mail.action(job) ────┘
```

The projection maps the generic `MailJob` into the caller's record union,
provides its authoritative key, and reads it back. Updates receive the previous
caller record so unrelated caller metadata survives. Every write validates its
key and exact `toRecord`/`toJob` round trip. Worker operations take the
already-built caller `CollectionStore`.

## State machine

```text
pending/retrying --send claim--> sending
sending --provider accepted--> accepted
sending --failure--> retrying | dead_letter
accepted --authenticated delivered callback--> delivered
accepted --deadline/reconcile claim--> reconciling
reconciling --delivered--> delivered
reconciling --failed--> retrying | dead_letter
reconciling --unknown/malformed/error--> terminal_unknown
terminal_unknown --late authenticated delivered callback--> delivered
dead_letter --same-generation authenticated delivered callback--> delivered
```

Sending and reconciliation have separate discovery lanes and states. Every
claim mints a UUID fencing token. Completion requires the worker ID and exact
token. An expired reconciliation lease remains reconciliation-only; sending
cannot turn uncertainty into a blind resend.

After content preparation, sending atomically revalidates and rewrites the
exact claim immediately before crossing the provider side-effect boundary. A
callback that resolved the claim during preparation wins that conflict, so the
stale worker never invokes the provider.

Provider acceptance is not delivery. An accepted job cannot send again. It
waits for an authenticated normalized callback until its deadline, then asks
the reconciliation port for provider state.

## Ports and trust

Discovery is the storage adapter's `CollectionStore.scan` over the
caller-owned collection. It is not a structural host port and accepts no
host-attached consistency marker. The adapter reports bounded pages of decoded
records together with their physical keys, versions, and an opaque
collection-scoped cursor. A separately persisted post-commit hint is
forbidden: the caller transaction can commit and the process can crash before
writing the hint, stranding must-not-be-lost work.

`runSendPage`, `runReconciliationPage`, and terminal `sweep` pass cursors
through without interpreting them. The scheduler persists `nextCursor` only
after a whole page completes. A crash before that save repeats the page, which
authoritative claims and version-conditional deletion make safe. The adapter
promises no filter, order, or snapshot. A row written behind the cursor may
wait until the next cycle, so schedulers follow the cursor through `null` and
then restart from an omitted cursor. Repeated complete cycles provide
liveness. Sending, reconciliation, and terminal sweeping each maintain their
own cursor cycle.

Mail validates every physical scan key against both the decoded collection key
and the mail projection. Claims still use `update` deciders that re-read the
current row; discovery never authorizes a state transition.

Jobs hold generic `recipientRef` and `contentRef` values. The host preparation
port resolves those references into provider-neutral content after claiming.
The package owns no rendering or templates.

The provider port always receives the job's stable, partition-qualified
idempotency key. At-least-once execution can call a provider twice after a
crash; a provider that cannot honor the key carries documented double-send
risk.

The key also names a bounded submission generation. Ambiguous send errors and
expired send leases reuse the same generation and key because the provider may
already have accepted that operation. Only authoritative failed reconciliation
or an authenticated failed callback advances the generation and rotates the
key before a new submission. `maxAttempts` bounds recorded completed attempts
and submission generations, not actual provider calls. Preparation, send, and
reconciliation adapters must settle before the worker lease, enforcing finite
I/O timeouts comfortably below it. This package cannot cancel an adapter
promise that stays pending; lease recovery can therefore overlap work.
Recovered sends reuse the same key, which prevents a logical duplicate only
when the provider honors idempotency.

Provider results cross an untrusted structural boundary. Normalization reads
only own data-property descriptors and never invokes getters. Invalid send
results become bounded failures; invalid reconciliation results become
`terminal_unknown`.

`applyAuthenticatedCallback` assumes the host already authenticated,
deduplicated, and normalized the provider event. It requires the submission
generation and optionally checks the provider message reference, so an old
failure cannot clobber a newer accepted submission. A callback racing an
in-flight send durably resolves that claim; the later provider return is
fenced. Receipt collections and signatures are not mail state. A delivered
callback is monotonic and can resolve a late `terminal_unknown` or an ambiguous
same-generation `dead_letter`; delivered never regresses.

The host injects a trusted clock. The worker samples it before claiming and
again after awaited preparation, send, or reconciliation, rejecting backward
movement. Operational retry, deadline, delivery, and terminal timestamps use
the completion sample. Callback processing rejects a clock sample before
persisted creation, acceptance, or terminal time. Provider `occurredAt`
remains evidence only.

Persisted jobs, callback inputs, adapter-reported physical keys, and projection
keys are copied from own data properties and fully normalized before decisions
or external calls. Accessors are never invoked. Malformed non-mail collisions
are skipped; a malformed value that claims to be a mail job is surfaced as
corruption.
Normalization rejects sendable states carrying provider acceptance evidence
and operational timestamps that precede creation or prior accepted, delivered,
or terminal state.

## Failure and retention

Send attempts use bounded exponential delay and a maximum of 20 configured
attempts. Exhaustion produces durable `dead_letter`. Unresolvable provider
state produces durable `terminal_unknown`. Neither is automatically replayed.

Terminal retention examines at most the caller-specified scan page size across
the caller-owned collection. Mail itself never materializes a shared
partition. Eligible rows are deleted with the adapter-reported physical key and
version through `deleteIfUnchanged`. Stale, repeated, wrong-reference, and
decoded-key collision results are harmless or surfaced as corruption.
`nextCursor` continues the current cycle; a lost cursor repeats work safely.

Delivered jobs can be swept after the caller's time bound. `dead_letter` and
`terminal_unknown` require a separate explicit acknowledgement before becoming
eligible. A concurrent callback or acknowledgement changes the version and
prevents deletion of stale enumeration and reports `more: true`. A
same-generation delivered callback supersedes even an acknowledged ambiguous
dead-letter, clears its acknowledgement, resets terminal time to trusted
processing time, and fences a sweep holding the old version. Projection keys
are revalidated so colliding caller data cannot be removed.

## Boundaries

The package contains no provider SDK, persistent candidate index, scheduler,
template system, webhook receipt/authentication, inbound handling, threading,
campaign logic, access model, or deliverability/DNS abstraction.
