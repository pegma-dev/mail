# Release operations

`@pegma/mail` publishes only from a stable GitHub release for a signed annotated
tag already on protected `origin/main`. The bootstrap version `0.0.0` can never
publish.

## Before the first release

- integrate at least one real consumer and choose a non-zero version;
- configure the npm trusted publisher for `pegma-dev/mail`, workflow
  `publish.yml`, environment `npm-publish`;
- create the protected `npm-publish` GitHub environment;
- set `RELEASE_ALLOWED_SIGNERS` to reviewed SSH allowed-signers entries; and
- protect `v*` tags against movement and deletion.

No npm token fallback is permitted.

## Procedure

Update `packages/mail/package.json` and the lockfile through a reviewed pull
request. Run `npm run format:check`, `npm run check`, and `npm test` on Node 22
and 24.

After merge, create and push a signed annotated `vX.Y.Z` tag at the exact
`origin/main` commit, then run:

```sh
gh release create vX.Y.Z --verify-tag
```

The preparation job has no OIDC authority. It verifies the signer, tag,
release-event commit, main ancestry, complete gate, package inventory, and
exact dependencies. It packs once, verifies the file allowlist and npm hashes,
and imports the tarball in a clean consumer.

Only the final environment-scoped job receives `id-token: write`. It installs
no dependencies and publishes the exact prepared tarball with provenance.

## Registry safety

`npm run release:registry` requires the current version to be absent.
`npm run release:registry -- -- --manifest .release/package-manifest.json`
allows only two retry-safe outcomes: absent means publish, and an existing
byte-identical `dist.integrity` means skip. Different bytes or any registry
error other than `E404` stops the release.

Never unpublish and reuse a version.
