# Mail

`@pegma/mail` is Pegma's provider-neutral transactional-mail state machine and
worker.

It closes the lost-send gap without owning persistence: the caller projects a
mail job into its own collection and commits the returned transaction action
beside the state change that caused the message. The worker later consumes
host-supplied candidate hints and confirms every claim against that
authoritative caller record.

The `0.0.0` bootstrap is implemented but deliberately unpublishable. It was
extracted from the production-shaped outbound behavior in Support Desk after
Identity became the second concrete consumer.

## Guarantees

- no mail-owned store, collection, or partition;
- mandatory provider idempotency keys;
- bounded recorded attempts and submission generations that rotate keys only
  after authoritative failure and reuse them across ambiguous outcomes;
- separate UUID-fenced sending and reconciliation lanes;
- provider acceptance is not confirmed delivery;
- bounded exponential retry scheduling, dead-letter, and terminal-unknown
  outcomes;
- accessor-safe normalization at provider boundaries;
- full persisted-job, callback, candidate, and projection-key normalization;
- trusted post-I/O operational timestamps, with provider time retained only as
  evidence;
- authenticated late delivery can resolve `terminal_unknown` or an ambiguous
  same-generation `dead_letter`, while delivered state never regresses;
- automatic retention only for delivered work; dead-letter and
  terminal-unknown work require explicit acknowledgement.

## Deliberate exclusions

Provider SDKs, templates, branded rendering, webhook authentication and receipt
deduplication, inbound mail, campaigns, and deliverability/DNS configuration
belong to hosts or other components.

See [Architecture](docs/ARCHITECTURE.md), [Project Plan](docs/PROJECT_PLAN.md),
and [Releasing](docs/RELEASING.md).
