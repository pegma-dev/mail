# Mail Project Plan

## Status

**Stage:** Phases 1–3 are complete. `@pegma/mail@0.1.1` is published and is
composed by both Identity and Support Desk. The public API remains unstable.

The first advertised supported release was published from the protected,
signed annotated `v0.1.0` tag through the environment-protected GitHub
trusted-publishing/OIDC workflow, with npm SLSA provenance. The earlier
`0.0.0` package-name bootstrap was the one-time manual prerequisite; it
remains isolated and non-advertised rather than part of the normal release
lane.

**Trigger:** fired on 2026-07-27. Support Desk supplied a stabilized generic
outbound state machine and Identity supplied the second real consumer:
enrollment, fallback, and recovery messages whose state change and send intent
must commit together.

**Extraction source:** the uncommitted
`@pegma/support-desk-mail`/application outbound implementation. Its
provider-neutral leases, acceptance/reconciliation distinction, retry bounds,
and adversarial tests are the conformance evidence. Support-specific ticket
threading, callback receipt/authentication, and template rendering remain in
Support Desk.

**Package:** `@pegma/mail@0.1.1`

**Dependencies:** exactly `@pegma/spine@0.1.1` and
`@pegma/storage-core@0.4.0`

## Delivered first release

- A caller-owned `MailProjection` binds mail jobs to the caller's existing
  `CollectionDefinition`; `action` yields the insert for the caller's own
  transaction.
- Jobs store generic recipient and content references. A host preparation port
  resolves and renders content only after a fenced claim.
- Provider send requests always carry a partition-qualified idempotency key.
- Ambiguous outcomes reuse a bounded submission-generation key; authoritative
  failure rotates it before another physical submission. `maxAttempts` bounds
  recorded completions and generations, not physical provider calls.
- Preparation, send, and reconciliation adapters settle before the claim lease
  and enforce finite I/O timeouts below it; a hung promise may otherwise
  overlap lease recovery, with send duplicate prevention depending on provider
  idempotency.
- Sending and reconciliation use distinct states and fresh UUID claim tokens.
  Expired reconciliation work can only be reclaimed by reconciliation.
- Acceptance waits for an authenticated callback. Expired acceptance is
  reconciled, never blindly resent.
- Send failures use bounded exponential retry and dead-lettering. Unknown
  reconciliation becomes explicit `terminal_unknown`.
- Provider and preparation results are copied from own data properties without
  invoking accessors.
- Persisted jobs, callbacks, adapter-reported scan keys, and projection keys are
  normalized from own data properties; projection updates merge the previous
  caller row and must round-trip the exact job. Sendable states cannot retain
  provider acceptance evidence, and persisted chronology must be internally
  consistent.
- A trusted clock is sampled after awaited provider work. Provider event time
  is retained as evidence and never drives retries or terminal retention.
  Callback time cannot precede persisted operational history.
- A storage-fenced claim revalidation after preparation prevents a callback
  from resolving a claim before the stale worker invokes the provider.
- Authenticated delivery callbacks may resolve late `terminal_unknown` jobs or
  ambiguous same-generation dead-letters. They clear prior acknowledgement
  and fence concurrent retention; delivered jobs never regress.
- Send, reconciliation, and terminal discovery use bounded, cross-partition
  `CollectionStore.scan` pages issued by the storage adapter. There is no
  host-attached source or separately persisted post-commit hint. Mail passes
  opaque cursors through unchanged; claims still decide against the current
  row, so replay after a crash is safe.
- Retention uses each scan row's physical key and version with
  `deleteIfUnchanged`; it never materializes a shared partition. Delivered work
  can expire automatically; dead-letter and terminal-unknown work first require
  explicit acknowledgement.
- Tests cover the in-memory reference store and real Azurite, including a crash
  immediately after the caller transaction, an uncommitted phantom, repeated
  pages, strict page bounds, complete-cycle cursor fairness, live-prefix
  insertion, transaction refusal, lease recovery, send-versus-reconcile
  fencing, malformed provider objects, callback monotonicity, and conditional
  terminal retention.
- The package has local README/LICENSE, prepack build, test exclusion, exact
  release inventory, pack/import smoke verification, exact-integrity registry
  decisions, Node 22/24 CI, and a minimal OIDC publisher. Version `0.1.0` is
  the first supported release accepted by the normal lane. Version `0.0.0`
  remains accepted only by a separate manual bootstrap mode that never
  publishes automatically.

## Delivery phases

### Phase 1 — first consumer integration ✓

Wire Identity's enrollment and recovery sends into its own collection and
transaction. The host supplies cursor scheduling, rendering, provider adapters,
and callback authentication/deduplication; the storage adapter supplies
authoritative discovery.

**Complete.** Identity owns the operation/Mail union that commits code state
and delivery intent atomically. pegma.dev supplies the scheduled cursor,
rendering, Resend adapter, and callback/acknowledgement boundary.

### Phase 2 — Support Desk migration ✓

Replace Support Desk's duplicated generic state machine with `@pegma/mail`.
Keep ticket-specific content, Message-ID/threading, callback receipt storage,
and provider authentication there. Run its existing mail tests as the
migration conformance bar.

**Complete.** [Support Desk PR #2](https://github.com/pegma-dev/support-desk/pull/2)
replaced the duplicated state machine with exact `@pegma/mail@0.1.0` while
retaining ticket-specific projection, templates, threading, and authenticated
callback receipt handling.

### Phase 3 — first advertised release ✓

Keep the package-name bootstrap isolated at the protected signed `v0.0.0`
source tag and exact manually verified tarball. After that one-time prerequisite,
publish the reviewed `0.1.0` artifact from its own protected signed tag through
OIDC so `latest` advertises the supported scan-based release.

**Complete.** The signed `v0.1.0` release published the reviewed artifact
through trusted-publisher OIDC with provenance. npm `latest` resolves to
`0.1.0`; the bootstrap artifact remains non-advertised.

## Non-goals

- A mail-owned store, collection, partition, candidate index, or scheduler
- Provider SDK adapters without a real consumer
- Templates, localization, branding, or executable rendering
- Webhook signature verification or receipt storage
- Inbound mail, threading, campaigns, lists, or bulk delivery
- SPF, DKIM, DMARC, reputation, or a deliverability abstraction
- Automatic replay of dead-letter or terminal-unknown jobs
