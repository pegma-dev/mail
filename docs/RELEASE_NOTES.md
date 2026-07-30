# Release notes

## 0.1.1 — security scan triage

No public API, runtime dependency, or behavior change: `@pegma/mail@0.1.1` is
byte-equivalent in surface to `0.1.0` and still requires exactly
`@pegma/spine@0.1.1` and `@pegma/storage-core@0.4.0`.

This release records the 2026-07-29 triage of `docs/securityscan.md`:

- the `uuid` buffer-bounds advisory (GHSA-w5hq-g745-h8pq) is cleared from the
  development tree by a root `overrides` pin to `^11.1.1`, with a lockfile
  regression test; and
- the hardcoded-emulator-key and unvalidated-recipient findings were
  re-examined and disputed as not valid, so no source changed for either.

`npm audit --omit=dev` remains 0. The residual `brace-expansion` and
`@opentelemetry/core` advisories are development-only, are documented as
accepted in `docs/securityscan.md` with the verified reason each patched
release is API-incompatible with azurite's pinned tree, and never reach a
published artifact.

## 0.1.0 — first advertised supported release

Status: prepared for reviewed merge, a protected signed annotated `v0.1.0`
tag, and trusted-publisher OIDC publication. It is not published by this
change.

`@pegma/mail@0.1.0` provides the provider-neutral durable mail state machine
shared by Pegma hosts:

- mail jobs are projected into caller-owned records and committed beside the
  state change that caused them;
- send, reconciliation, and terminal discovery page the caller's authoritative
  collection through bounded `@pegma/storage-core` scans;
- adapter-issued cursors stay opaque, completed pages may replay safely, and
  repeated complete cycles cannot permanently omit a live committed row;
- physical scan keys, opaque versions, page bounds, dense data-property
  records, and projection keys are validated before provider work;
- UUID-fenced send and reconciliation claims, stable provider idempotency
  keys, bounded retry generations, late authenticated callbacks, explicit
  terminal acknowledgement, and version-conditional retention are included;
  and
- Node 22 and 24, the in-memory store, and real Azurite exercise crash,
  phantom, replay, fairness, corruption, and retention-race behavior.

This first supported API requires exactly `@pegma/spine@0.1.1` and
`@pegma/storage-core@0.4.0`. The separate `0.0.0` artifact is only the
manual package-name bootstrap prerequisite; it is not an advertised supported
release and remains outside the normal OIDC lane.
