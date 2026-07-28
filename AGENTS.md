# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Mail is the transactional-mail component of Pegma. Shared contracts live in
`@pegma/spine`; persistence in `@pegma/storage-core`. The component is now
implemented by extraction from Support Desk after Identity became its second
real consumer.

> Optimize for a fresh agent context window. Minimize what must be read to make
> a correct change, and mechanize the proof that the change is correct.

## Hard rules

**This package owns no store, collection, or partition. Ever.** A mail job is
projected into the caller's collection and committed in the caller's
`transact`. A convenience store, default collection, or managed outbox
reintroduces the lost-send gap. `@pegma/audit` is the binding precedent.

**Idempotency keys are mandatory at the provider send port.** The worker is
at-least-once. An adapter or provider that cannot honor the key has documented
double-send risk; never add a workaround that pretends otherwise. Preparation,
send, and reconciliation adapters must settle before the claim lease, with
finite I/O timeouts comfortably below it: `maxAttempts` bounds recorded
completions and generations, not physical work whose promises remain pending
across lease recovery.

**Dead-letter and terminal-unknown work are human-visible.** Recorded completed
attempts are bounded. Neither state automatically replays or disappears.
Retention requires explicit acknowledgement.

**Claims go through deciders.** Sending and reconciliation are separate lanes.
Every claim gets a fresh UUID token. Outcome recording requires the worker and
exact token. Sweeps are version-conditional.

**Acceptance is not delivery.** Provider acceptance stops sending but does not
become delivered. Reconcile expired acceptance. A late authenticated callback
may resolve terminal-unknown or an ambiguous same-generation dead-letter, and
delivered never regresses.

**No inbound, bulk, templates, provider SDKs, webhook receipt storage, or
deliverability abstraction.** Inbound belongs to the host and webhooks
component; content preparation and branding are host concerns; DNS remains
with the host.

**Preserve the extraction boundary.** Generic state, claiming, retry,
reconciliation, callback application, and retention live here. Support Desk
keeps ticket threading, callback authentication/deduplication, and templates.

**No literal control characters in source.** Use escaped forms such as
backslash-u-0000 through backslash-u-001F and scan the bytes after edits.

## Packaging and workflow

The package needs its own README and LICENSE. `prepack` must build, package
TypeScript must exclude tests, and sibling dependencies are pinned exactly.

Work on a `claude/*` branch and open a pull request. The gate is
`npm run format:check`, `npm run check`, and `npm test` on Node 22 and 24.

Stable publishing is trusted-publisher OIDC only. The sole exception is the
first package-name bootstrap: `0.0.0` may be packed and verified only through
the explicit manual bootstrap mode documented in `docs/RELEASING.md`. Every
normal release path rejects the entire `0.0.x` range and starts at `0.1.0`.
Every source tag is protected, signed, annotated, and already on `origin/main`;
never tag, publish, or move dist-tags casually.

## Reference points

Read `docs/PROJECT_PLAN.md`, then `docs/ARCHITECTURE.md`. The Support Desk mail
tests are the extraction conformance source; Audit is the no-store precedent.
