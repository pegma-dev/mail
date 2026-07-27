# Mail Project Plan

## Status

**Stage:** planning, deliberately dormant — this component is created by
EXTRACTION, not invention, and its extraction trigger has not fired yet
(see Timing). (`0.x`, unpublished.)

**Extraction source:** the Pegma support desk, whose Phases 6–7 build
transactional mail in-repo first (`@pegma/support-desk-mail`): outbox-backed
delivery jobs committed in one `transact` with the state change, bounded
retry, dead-lettering, provider callbacks.

**Extraction trigger:** a second real consumer. That consumer is now
planned: `@pegma/identity`, whose enrollment/fallback/recovery codes are
canonical must-not-be-lost sends. Per the ecosystem's audit rule — two
implementations differing in field names rather than substance are the
signal — when identity's Phase 2 needs mail, the shared part of the support
desk's implementation moves here.

**License:** MIT

## Vision

Every host eventually sends transactional mail, and the failure mode is
always the same: the send is a second operation after the state change, and
the gap between them is where verification emails vanish. The durable
outbox closes that gap — and `@pegma/spine` already assigns it: anything
that must survive a crash is written in the same operation as the state
change and delivered by a dispatcher.

One mail component, whose central design commitment is the same one that
made `@pegma/audit` work: **it owns no store.** The outbox row lives in the
CALLER's collection and partition, yielded as a `TransactionAction` the
caller includes in its own `transact` — because a storage-core transaction
is scoped to one collection and one partition, and a mail package with its
own outbox collection could never commit atomically with the state change
it announces. Atomicity is the product; the factoring follows.

## Fundamental model

**Delivery job** — the outbox row: recipient, template/message reference,
correlation id, attempt count, status (`pending` / `sent` / `dead`),
lease-until. Defined by a projection the CALLER supplies (the audit
pattern: `defineMail(projection)` against the caller's
`CollectionDefinition`), so the job commits inside the caller's
transaction.

**Send port** — the narrow provider interface: one message out, an
idempotency key in (the job's id — a provider retry must not double-send),
provider message id back. Adapters implement it per provider; hosts on an
unlisted provider implement it directly.

**Delivery worker** — claims pending jobs with an `update` decider writing
a lease (a crashed worker's lease expires; a decider re-run refuses a job
someone else holds — the storage-core idiom), calls the send port, records
the outcome, retries with bounded backoff, and dead-letters past the bound.
A dead job is a durable row for a human, exactly like a quarantined webhook
receipt — never silently dropped, never retried forever.

**Callback** — normalized delivery state (delivered / bounced /
complained) from provider webhooks. Receipt dedup for those webhooks is
`@pegma/webhooks`' job; this component only defines the normalized shape
and applies it to the job row.

## Design decisions

### Owns no store — the audit precedent, load-bearing

No mail collection, no mail partition, no mail database. The caller
projects the job into its own collection; readers and the worker take a
`CollectionStore`. This is what makes "the ticket reply and its
notification job commit together" true, and it is not negotiable — a
convenience `createMailStore()` would be the exact defect audit exists to
prevent.

### At-least-once toward the provider, idempotent at the provider

The worker may retry a send whose outcome it never learned. The provider
idempotency key (the job id) is what makes that safe; adapters MUST pass
it, and a provider without idempotent send gets documented double-send
risk, not a pretend fix.

### Dead-lettering is a signal, not a queue

Bounded attempts, then `dead` with the last error retained. Nothing
auto-replays a dead job; a human (or a host's explicit tooling) does,
deliberately. Retry storms toward a failing provider help nobody.

### Templates stay thin, or stay out

The component carries at most a trivial substitution mechanism; branded
layout, localization, and MJML-style pipelines are host concerns (the
support desk keeps its branded templates). If template logic starts
growing here, it is scope creep wearing a helpful face.

### Deliverability is the host's DNS, stated plainly

SPF, DKIM, DMARC, and sender reputation live with the host and its
provider. The docs point, explain the one-time setup, and refuse to
abstract it — a component cannot own what DNS owns.

## Scope

### Non-goals

- **An outbox store of its own** (above — the defining refusal).
- **Inbound mail.** Parsing, threading, and mailbox handling are the
  support desk's; webhook receipt dedup is `@pegma/webhooks`'.
- **Marketing/bulk email, campaigns, lists, tracking pixels.** Different
  product, different consent regime.
- **Rich templating** (above).
- **Deliverability magic** (above).
- **Conversation threading.** Message-ID reply-matching is desk domain
  logic; this component records provider message ids and no more.

## Package architecture

One package: `packages/mail` publishing `@pegma/mail` — the projection
factory, worker, send port, and callback shapes. Provider adapters
(`@pegma/mail-postmark`, `-ses`, `-cloudflare`, …) are added ONLY on a real
consumer's pull, starting with whichever provider the support desk's
reference deployment selects in its Phase 7. Dependencies: `@pegma/spine`,
`@pegma/storage-core`, pinned exactly.

## Delivery phases

### Phase 1 — extraction

When the trigger fires (identity Phase 2 needs sends; support-desk mail
exists): lift the job shape, worker loop, and send port from
`@pegma/support-desk-mail`, generalize the field names, and swap the
support desk to consume this package. The support desk's tests come along
as the conformance bar; its architecture doc's transaction-and-delivery
pattern is the specification.

### Phase 2 — the first adapter

The support desk reference deployment's provider, behind the send port,
with idempotency-key conformance tests.

### Phase 3 — the second consumer

`@pegma/identity` wires its code sends through the outbox. Exit: the same
worker delivers desk notifications and identity codes from two different
callers' partitions, and neither caller can lose a send to a crash.

## Timing

Dormant until support-desk Phase 6 ships in-repo and identity Phase 2
approaches. The support desk deliberately builds first and builds inward —
its delivery worker written "as if it will be extracted" (clean port
boundaries, no ticket-specific assumptions in claim/retry) so Phase 1 here
is a rename, not a redesign. Creating this repository now records the
factoring decision; it does not accelerate the work.

## Open questions

**Worker residence.** The delivery worker as a library function the host
schedules (timer trigger, cron) versus a long-running loop. Lean: a
`runOnce(batch)` the host schedules — every Pegma host already has a timer
story, and long-running loops assume infrastructure the ecosystem does not.

**Lease duration vs. provider timeout.** The claim lease must comfortably
exceed the slowest send attempt or two workers double-send within
idempotency's mercy. Settle with real provider numbers in Phase 2.

**Callback authenticity.** Provider webhook signature verification is the
host's (per the webhooks component's posture); whether adapters ship
optional verifier helpers mirrors the same open question there — lean no,
revisit together.
