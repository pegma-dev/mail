# Mail

`@pegma/mail` is Pegma's provider-neutral transactional-mail state machine and
worker.

It closes the lost-send gap without owning persistence: the caller projects a
mail job into its own collection and commits the returned transaction action
beside the state change that caused the message. The worker later pages the
caller collection through the storage adapter's authoritative cross-partition
scan and confirms every claim against the current record. There is no
separately persisted post-commit hint that a crash can lose.

`@pegma/mail@0.1.0` is the first advertised supported release. It uses the
storage adapter's authoritative scan contract, so discovery remains attached
to the caller row committed in the originating transaction. Version `0.0.0`
remains restricted to the one-time, manual-only npm package-name bootstrap;
the normal OIDC lane rejects every `0.0.x` version. The component was extracted
from production-shaped outbound behavior in Support Desk after Identity became
the second concrete consumer.

## Guarantees

- no mail-owned store, collection, or partition;
- no must-not-be-lost discovery outside the transaction that writes the
  authoritative caller row;
- mandatory provider idempotency keys;
- bounded recorded attempts and submission generations that rotate keys only
  after authoritative failure and reuse them across ambiguous outcomes;
- separate UUID-fenced sending and reconciliation lanes;
- provider acceptance is not confirmed delivery;
- bounded exponential retry scheduling, dead-letter, and terminal-unknown
  outcomes;
- accessor-safe normalization at provider boundaries;
- full persisted-job, callback, physical scan-key, and projection-key
  normalization;
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
[Release Notes](docs/RELEASE_NOTES.md), and
[Releasing](docs/RELEASING.md).
