# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Mail is the transactional-mail component of **Pegma**, a family of
MIT-licensed packages a host application composes. Shared contracts live in
`@pegma/spine`; persistence in `@pegma/storage-core`. One repository per
component, publishing under the `@pegma` scope. This repository is
deliberately dormant: the component is created by extraction from the
support desk when `@pegma/identity` becomes its second consumer — the plan
is the current deliverable.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

## Hard rules

**This package owns no store, no collection, no partition. Ever.** The
outbox row is projected into the CALLER's collection and committed in the
CALLER's `transact` — that atomicity is the entire product. A convenience
store, a default collection, or a "managed" outbox reintroduces the lost-
send gap this component exists to close. The `@pegma/audit` design is the
binding precedent.

**Idempotency keys are mandatory at the send port.** The worker is
at-least-once; the provider key (the job id) is what makes retries safe.
An adapter that omits it, or a provider that cannot honor it, gets
documented double-send risk — never a workaround that pretends.

**Dead-lettering is terminal and human-visible.** Bounded attempts, then a
durable `dead` row with the last error. No automatic replay, no infinite
backoff, no silent drop.

**Claiming goes through deciders.** Lease acquisition and outcome
recording are `update` deciders re-run against fresh state; sweeps are
version-conditional. Read-then-write claiming double-sends under exactly
the contention that matters.

**No inbound, no bulk, no templating growth, no deliverability
abstraction.** Inbound belongs to the support desk and `@pegma/webhooks`;
campaigns are a different product; branded templates are host concerns;
SPF/DKIM/DMARC live in the host's DNS. Refuse each regardless of how small
the request looks.

**Do not implement ahead of the trigger.** Phase 1 is an extraction from
`@pegma/support-desk-mail`, with its tests as the conformance bar. Writing
this component fresh, before that source exists, forfeits the
production-shaped evidence the extraction rule exists to capture.

## Reference points

The plan is `docs/PROJECT_PLAN.md`. The support desk's ARCHITECTURE.md
transaction-and-delivery pattern is the specification the extraction must
preserve; the audit repository is the precedent for owning no store.
