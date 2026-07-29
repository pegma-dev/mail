# Security Scan Report

Date: 2026-07-28
Scope: Repository-wide security review of the `@pegma/mail` component.

This file is appended to as the scan progresses. Each finding includes severity,
evidence, exploitability assessment, and file references.

---

## Findings Log

### Progress notes (as-you-go)

- **[OK] `packages/mail/src/index.ts` (main library)** — reviewed. Strong input
  validation throughout: all external inputs pass through `ownDataSnapshot`
  (own-data-property only, accessor rejection — blocks getter side channels and
  prototype pollution), control-character rejection on all text fields, strict
  canonical ISO timestamp validation, bounded lengths, linear-time regexes (no
  ReDoS candidates observed), claim tokens from `crypto.randomUUID()` (CSPRNG),
  and header name/value validation in `normalizePreparedMail` that blocks
  CRLF/header injection. No findings yet.
- **[OK] `scripts/release-packages.mjs`** — reviewed. No `shell: true` with
  user input (shell only used for `npm.cmd` on win32 with fixed argument
  lists), `spawnSync` with argument arrays, environment scrubbing of
  npm tokens for registry calls (`isolatedNpmEnvironment`), `timingSafeEqual`
  for hash/commit comparisons, signed-tag + origin/main-ancestry + clean-tree
  enforcement before publish, OIDC-only publish gate. No findings yet.
- **[OK] `.github/workflows/*.yml`** — reviewed. All actions pinned by full
  commit SHA, least-privilege `permissions` (`contents: read`; `id-token:
  write` only in the publish job), no `pull_request_target`, no script
  injection from event context (release tag used only as a `ref` string and in
  artifact names, not interpolated into shell), protected-environment gate
  (`environment: npm-publish`). No findings yet.
- **[OK] `test/azurite.ts`** — reviewed. Local emulator harness; binds to
  127.0.0.1, spawns node with fixed args, no secrets. No findings.

### FINDING 1 — Vulnerable transitive dependencies via `azurite` (dev-only)

- **Severity:** Low (dev/test toolchain only; `npm audit --omit=dev` reports **0**
  vulnerabilities for shipped/runtime dependencies)
- **Evidence:** `npm audit` reports 12 vulnerabilities (5 high, 7 moderate),
  all reachable only through the `azurite` devDependency:
  - `brace-expansion <=5.0.7` — **HIGH** — DoS via unbounded expansion
    (GHSA-mh99-v99m-4gvg), via `minimatch` → `glob` → `rimraf` (azurite dep).
  - `uuid <11.1.1` — **MODERATE** — missing buffer bounds check in v3/v5/v6
    (GHSA-w5hq-g745-h8pq), via `@azure/ms-rest-js` and `sequelize` (azurite deps).
  - `@opentelemetry/core` — **MODERATE** — unbounded memory allocation in W3C
    Baggage propagation, via `applicationinsights` (azurite dep).
- **File references:** `package.json` (devDependency `azurite@^3.36.0`),
  `package-lock.json`, consumed by `test/azurite.ts` and
  `packages/mail/src/azurite.test.ts`.
- **Exploitability:** Not exploitable through the published package —
  `@pegma/mail`'s `files` allowlist ships only `dist/**`, and runtime
  dependencies (`@pegma/spine`, `@pegma/storage-core`) are clean. Risk is
  confined to the CI/dev environment where Azurite runs locally; the
  `brace-expansion` DoS requires an attacker to influence glob patterns
  processed by azurite's `rimraf`, and the `uuid` bounds issue requires
  callers to pass a `buf` to v3/v5/v6 (azurite internal). No remote attacker
  path identified; CI runs the emulator on 127.0.0.1.
- **Recommendation:** Track upstream azurite releases; `npm audit fix --force`
  would downgrade azurite (breaking) and is not advisable. Consider
  `overrides` for `brace-expansion`/`uuid` if a compatible bump exists, or
  accept with documented justification since exposure is test-only.

### FINDING 2 — Hardcoded storage account key in test file

- **Severity:** Informational (not a real secret)
- **Evidence:** `packages/mail/src/azurite.test.ts:19-20` hardcodes
  `AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==`
  for `devstoreaccount1`.
- **File references:** `packages/mail/src/azurite.test.ts:18-26`.
- **Exploitability:** None. This is Microsoft's well-known, publicly documented
  Azurite/Azure Storage Emulator development key (published in official docs).
  It authenticates only to a local emulator on 127.0.0.1 and grants no access
  to any real Azure resource. The test file is also excluded from the published
  package (`tsconfig` excludes `src/**/*.test.ts`; `files` ships only `dist/**`).
  Flagged so secret scanners don't surprise future reviewers; no action needed
  beyond awareness.

- **[OK] `packages/mail/src/azurite.test.ts`** — reviewed (see Finding 2 for
  the emulator key note). `allowInsecureConnection: true` and `http://` are
  scoped to the 127.0.0.1 emulator only. Test-only file, excluded from the
  published package.
- **[OK] `packages/mail/src/index.test.ts`** (1,480 lines) — conformance
  tests; no secrets, no dangerous patterns (`crypto.randomUUID()` used for
  fixtures only).
- **[OK] `packages/mail/src/test-support.ts`** — test-only projection
  helpers; `JSON.parse` on test-owned payloads only; excluded from build.
- **[OK] `tests/release-packages.test.ts`** (1,218 lines) — notably contains
  *positive* security regression tests: verifies npm tokens
  (`NODE_AUTH_TOKEN`/`NPM_TOKEN`/`NPM_AUTH_TOKEN`) and hostile
  `npm_config_*` registry overrides do **not** leak into spawned release
  processes, and that a hostile registry cannot redirect publish traffic.
  All fixtures use `mkdtemp` under the OS temp dir; local test registries
  bind to 127.0.0.1.
- **[OK] Config & metadata** — `tsconfig*` strict mode on, tests excluded
  from package build; `.gitignore` covers `.env*`, `dist/`, `.release*`;
  `.gitattributes` normalizes LF; no committed `.npmrc`, no private keys,
  no tokens in git history (tracked files scanned); package manifest ships
  only `dist/**` with exact-pinned sibling deps.
- **[OK] `SECURITY.md`** — documents private vulnerability reporting and the
  host/component trust boundary explicitly.

### FINDING 3 — Recipient address is not format-validated

- **Severity:** Informational (defense-in-depth suggestion)
- **Evidence:** `normalizePreparedMail` validates `recipient` only as a
  non-empty string of at most 1,024 chars with no control characters
  (`packages/mail/src/index.ts:955-972`). It is not validated as an email
  address, so a preparation adapter could legitimately return a
  comma-separated list (`a@x.test, b@y.test`), causing a provider to fan a
  single job out to multiple recipients.
- **File references:** `packages/mail/src/index.ts:954-1025`
  (`normalizePreparedMail`), trust boundary documented in `SECURITY.md:7-10`.
- **Exploitability:** Requires the host's preparation port (trusted,
  host-owned code) to be buggy or compromised; there is no untrusted input
  path to this function. CRLF/header injection is already blocked by the
  control-character filter, and custom header names/values are strictly
  validated (`/^[A-Za-z0-9-]{1,64}$/`, no controls, ≤64 headers, ≤8 KiB
  values), so no SMTP-header injection is possible through this package.
- **Recommendation:** None required — `SECURITY.md` explicitly assigns
  recipient/content authorization to the host. If defense-in-depth is
  desired, a single-address format check could be added here, at the cost of
  constraining legitimate provider-specific address forms.

### Deep-logic review notes (no findings)

The following areas were specifically examined and found sound:

- **Claim/lease protocol:** fresh `crypto.randomUUID()` per claim; outcome
  recording requires exact worker ID + token match; separate send/reconcile
  lanes; expired-lease reclaim only. (`index.ts:1308-1353`)
- **Idempotency:** deterministic provider idempotency keys are
  URI-component-encoded per part, length- and charset-bounded, and
  round-trip-validated against partition/id/generation on every read, so a
  tampered or mismatched stored key fails closed (`mail_job_invalid` /
  normalization error) rather than sending under a wrong key.
  (`index.ts:410-440, 620-631, 1603-1618`)
- **Fail-safe defaults:** malformed preparation → `content_preparation_invalid`;
  malformed provider response → `provider_response_invalid`; malformed or
  throwing reconciliation → `unknown` → human-visible `terminal_unknown`.
  Nothing auto-replays or disappears. (`index.ts:1039-1049, 1471-1477`)
- **Prototype-pollution / getter resistance:** all untrusted object reads go
  through own-data-property snapshots; header map keys are charset-restricted
  (so `__proto__` is unreachable); frozen outputs. (`index.ts:482-542,
  984-1017`)
- **Regex safety:** all patterns are bounded/linear (no nested quantifiers);
  no ReDoS candidates.
- **Integer/overflow safety:** exponential backoff exponent capped at 19 and
  clamped to `MAX_RETRY_DELAY_MILLISECONDS`; schedule arithmetic guarded
  against `Date` range overflow (fails closed via `MailError`).
  (`index.ts:1561-1579, 1539-1547`)
- **Sweep safety:** deletions are version-conditional
  (`deleteIfUnchanged`), so a concurrent terminal transition (e.g., a late
  delivered callback racing the sweep) loses the race safely and sets
  `more: true`. (`index.ts:1934-1979`)
- **Timing side channels:** claim-token comparison is a plain string compare,
  but the token is server-side state co-located with the record it guards —
  there is no attacker-controlled oracle for it. Not a finding.

---

## Summary

| # | Finding | Severity | Exploitability |
|---|---------|----------|----------------|
| 1 | Vulnerable transitive dev dependencies via `azurite` (brace-expansion DoS, uuid bounds, OpenTelemetry baggage) | **Low** (dev-only; 0 runtime vulns) | No path through published package; CI/local test emulator only |
| 2 | Hardcoded Azurite development storage key in test | **Informational** | None — Microsoft's public well-known emulator key, local-only |
| 3 | Recipient not format-validated as an email address | **Informational** | Requires compromised host preparation port; injection already blocked |

**Overall assessment:** The repository is in strong security shape. The
published package (`@pegma/mail`) has zero known-vulnerable runtime
dependencies, a minimal ship list (`dist/**` only), defense-in-depth input
validation, fail-closed state transitions, and a heavily hardened,
OIDC-only, signed-tag release pipeline with least-privilege, SHA-pinned CI.
The only actionable item is Finding 1 (track upstream `azurite` fixes);
Findings 2 and 3 require no action.

_Scan completed: 2026-07-28. Files reviewed: all tracked source, tests,
scripts, workflows, configs, and docs (excluding `node_modules/` and
generated `dist/`)._

