# Mail

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Transactional mail for [Pegma](https://pegma.dev) components: provider
ports, an outbox pattern that **owns no store**, and a delivery worker with
bounded retries and dead-lettering.

> [!IMPORTANT]
> Mail is in planning and deliberately dormant. It is created by
> EXTRACTION — the support desk builds transactional mail in-repo first,
> and the shared part moves here when a second consumer
> (`@pegma/identity`) needs it. See
> [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

## The defining refusal

A verification email that can be lost between the state change and the
send is the failure this component exists to close — so the outbox row
must commit **in the caller's own transaction**. Storage-core transactions
are scoped to one collection and one partition; therefore this package
owns **no collection, no partition, no store**. Like
[`@pegma/audit`](https://github.com/pegma-dev/audit), it hands the caller a
`TransactionAction` to include in its own `transact`, and its delivery
worker operates over the caller's collections. A mail package with its own
outbox would be architecturally incapable of the atomicity it advertised.

The rest follows: at-least-once toward the provider with mandatory
idempotency keys, lease-based claiming via `update` deciders, bounded
retries, and dead jobs kept as durable human-visible rows — never silent
drops, never infinite retry storms. Inbound mail, bulk/marketing sending,
rich templating, and deliverability magic are all out of scope on purpose.

## License

MIT © RetireGolden, LLC
