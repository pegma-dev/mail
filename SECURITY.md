# Security Policy

Report vulnerabilities with
[GitHub private vulnerability reporting](https://github.com/pegma-dev/mail/security/advisories/new),
not a public issue.

Hosts remain responsible for provider credentials, webhook authentication and
deduplication, recipient/content-reference authorization, candidate durability,
provider idempotency support, DNS configuration, and operation of a durable
Storage Core backend.

Provider acceptance is deliberately not delivery. `terminal_unknown` means the
provider outcome could not be established and requires human attention.
Automatic replay of dead-letter or unknown work is outside the security model.
