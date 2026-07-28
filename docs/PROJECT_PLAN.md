# Mail Project Plan

## Status

**Stage:** extraction bootstrap complete (`0.0.0`, unpublished and blocked from
publication)

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

**Package:** `@pegma/mail` at bootstrap version `0.0.0`

**Dependencies:** exactly `@pegma/spine@0.1.1` and
`@pegma/storage-core@0.3.0`

## Delivered bootstrap

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
- Persisted jobs, callbacks, candidates, and projection keys are normalized
  from own data properties; projection updates merge the previous caller row
  and must round-trip the exact job. Sendable states cannot retain provider
  acceptance evidence, and persisted chronology must be internally consistent.
- A trusted clock is sampled after awaited provider work. Provider event time
  is retained as evidence and never drives retries or terminal retention.
  Callback time cannot precede persisted operational history.
- A storage-fenced claim revalidation after preparation prevents a callback
  from resolving a claim before the stale worker invokes the provider.
- Authenticated delivery callbacks may resolve late `terminal_unknown` jobs or
  ambiguous same-generation dead-letters. They clear prior acknowledgement
  and fence concurrent retention; delivered jobs never regress.
- Retention consumes at most a configured number of host-owned candidate
  hints, re-reads each authoritative row, and uses `deleteIfUnchanged`; it
  never materializes a shared partition. Delivered work can expire
  automatically; dead-letter and terminal-unknown work first require explicit
  acknowledgement.
- Tests cover the in-memory reference store and real Azurite, including
  transaction refusal, lease recovery, send-versus-reconcile fencing,
  malformed provider objects, callback monotonicity, and retention.
- The package has local README/LICENSE, prepack build, test exclusion, exact
  release inventory, pack/import smoke verification, exact-integrity registry
  decisions, Node 22/24 CI, and a minimal OIDC publisher. Version `0.0.0` is
  rejected from every release path.

## Next phases

### Phase 1 — first consumer integration

Wire Identity's enrollment and recovery sends into its own collection and
transaction. The host supplies candidate discovery, rendering, provider
adapters, callback authentication/deduplication, and scheduling.

### Phase 2 — Support Desk migration

Replace Support Desk's duplicated generic state machine with `@pegma/mail`.
Keep ticket-specific content, Message-ID/threading, callback receipt storage,
and provider authentication there. Run its existing mail tests as the
migration conformance bar.

### Phase 3 — first release

After at least one consumer integration is merged, choose a non-bootstrap
version, complete security review, configure npm trusted publishing and
protected signed tags, and release the exact prepared tarball.

## Non-goals

- A mail-owned store, collection, partition, candidate index, or scheduler
- Provider SDK adapters without a real consumer
- Templates, localization, branding, or executable rendering
- Webhook signature verification or receipt storage
- Inbound mail, threading, campaigns, lists, or bulk delivery
- SPF, DKIM, DMARC, reputation, or a deliverability abstraction
- Automatic replay of dead-letter or terminal-unknown jobs
