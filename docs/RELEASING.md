# Release operations

There are exactly two publication paths:

1. a one-time manual bootstrap of `@pegma/mail@0.0.0`, needed before npm has a
   package on which trusted publishing can be configured; and
2. every advertised release, beginning with `0.1.0`, through the
   environment-protected GitHub OIDC workflow.

The bootstrap tooling never invokes `npm publish`. Every normal release
command, prepared manifest check, and OIDC workflow stage rejects the entire
`0.0.x` range and requires `0.1.0` or later.

## Common source requirements

Every published artifact comes from a protected, signed, annotated `vX.Y.Z`
tag whose commit is already contained in `origin/main`. Configure:

- the protected `npm-publish` GitHub environment;
- `RELEASE_ALLOWED_SIGNERS` with reviewed SSH allowed-signers entries; and
- tag protection against moving or deleting `v*`.

Run `npm run format:check`, `npm run check`, and `npm test` on Node 22 and 24.
The packer also checks the exact two runtime dependencies, runs
`npm audit --omit=dev`, requires the exact seven-file package inventory,
verifies npm's SHA-1 and SHA-512 values, and imports the tarball from a clean
consumer.

Never unpublish and reuse a version.

## One-time `0.0.0` package-name bootstrap

Use an interactive npm maintainer session with required 2FA. Do not add a token
to this repository, GitHub, an environment variable, or a shell history.

After the bootstrap change is merged, create and push protected signed
annotated tag `v0.0.0` at that exact `origin/main` commit. Do not create a
GitHub release for this tag: a release event would invoke the OIDC workflow,
which intentionally rejects every `0.0.x` version.

Check out the exact tag, fetch protected main, install the reviewed npm, and
prepare an empty output directory. Export the same reviewed allowed-signers
content used by the workflow as `RELEASE_ALLOWED_SIGNERS`:

```sh
git checkout --detach refs/tags/v0.0.0
git fetch --no-tags origin main:refs/remotes/origin/main
npm install --global npm@11.18.0 --registry https://registry.npmjs.org/
export RELEASE_TAG=v0.0.0
export RELEASE_COMMIT="$(git rev-parse HEAD)"
test -n "${RELEASE_ALLOWED_SIGNERS}"
test -z "${NODE_AUTH_TOKEN:-}"
test -z "${NPM_TOKEN:-}"
test -z "${NPM_AUTH_TOKEN:-}"
umask 077
allowed_signers="$(mktemp)"
bootstrap_userconfig="$(mktemp)"
bootstrap_globalconfig="$(mktemp)"
trap 'rm -f "${allowed_signers}" "${bootstrap_userconfig}" "${bootstrap_globalconfig}"' EXIT
npm_public() {
  npm \
    --userconfig "${bootstrap_userconfig}" \
    --globalconfig "${bootstrap_globalconfig}" \
    --registry https://registry.npmjs.org/ \
    --@pegma:registry=https://registry.npmjs.org/ \
    "$@"
}
test "$(npm_public config get registry)" = "https://registry.npmjs.org/"
test "$(npm_public config get @pegma:registry)" = "https://registry.npmjs.org/"
printf '%s\n' "${RELEASE_ALLOWED_SIGNERS}" > "${allowed_signers}"
git config --local gpg.format ssh
git config --local gpg.ssh.allowedSignersFile "${allowed_signers}"
npm_public ci
npm_public run format:check
npm_public run check
npm_public test
npm_public run bootstrap:pack -- -- --require-clean --require-main-ancestor --require-bootstrap-tag --expected-release-commit "${RELEASE_COMMIT}" --output .bootstrap-release
npm_public run bootstrap:verify -- -- --require-main-ancestor --require-bootstrap-tag --expected-release-commit "${RELEASE_COMMIT}" --manifest .bootstrap-release/package-manifest.json
npm_public run bootstrap:registry -- -- --require-main-ancestor --require-bootstrap-tag --expected-release-commit "${RELEASE_COMMIT}" --manifest .bootstrap-release/package-manifest.json
```

The registry decision must be `publish`. Manually publish only the exact
verified tarball, under the non-advertised bootstrap tag:

```sh
npm_public ping
npm_public login
npm_public whoami
npm_public publish ./.bootstrap-release/pegma-mail-0.0.0.tgz --access public --tag bootstrap
```

Do not publish the directory, rebuild, rename the tarball, or substitute
another path or registry. The bootstrap registry check is hard-pinned to the
same public npm registry with empty temporary npm configuration and explicit
default and `@pegma` scope overrides. The private `bootstrap_userconfig`
contains the interactive credential only until the shell's exit trap removes
it. Rerun the same `bootstrap:registry` command; it must report `skip`, proving
that npm exposes byte-identical `dist.integrity`. An interrupted retry is
therefore safe: absent means publish the exact tarball, byte-identical means
stop successfully, and different bytes stop as an error.

## Configure npm trust immediately

Once the package exists, create the one allowed GitHub Actions trust
relationship:

```sh
npm_public trust github @pegma/mail --file publish.yml --repo pegma-dev/mail --env npm-publish --allow-publish --yes
npm_public trust list @pegma/mail
```

The configuration must identify organization `pegma-dev`, repository `mail`,
workflow filename `publish.yml`, environment `npm-publish`, and allow
`npm publish`. The equivalent npmjs.com path is Package settings → Trusted
publishing. npm does not validate the configuration until a publish attempt,
so review every field exactly. Then set publishing access to require 2FA and
disallow traditional tokens.

See npm's official
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
documentation.

## Correct `latest` immediately with `0.1.0`

The first publication of a new package may force `latest=0.0.0` even though
the command requested `--tag bootstrap`. Check:

```sh
npm_public dist-tag ls @pegma/mail
```

If `latest` points to `0.0.0`, an attempt to remove it may fail with HTTP 400
because npm will not leave the package without its only/default install tag.
That is not a reason to unpublish, republish, or loop on tag removal. Merge the
reviewed `0.1.0` version and lockfile change immediately, create its protected
signed annotated tag, and publish it through the normal OIDC procedure below.
The stable publish assigns `latest=0.1.0`, correcting the advertised version.
Do not announce an unqualified install until that correction is visible in
`npm_public dist-tag ls @pegma/mail`.

## Normal OIDC releases (`0.1.0` and later)

Update `packages/mail/package.json` and the lockfile through a reviewed pull
request. After merge, create and push a protected signed annotated `vX.Y.Z`
tag at the exact `origin/main` commit, then run:

```sh
gh release create vX.Y.Z --verify-tag
```

The workflow runs `release:check` before preparation, and the packer, prepared
manifest verifier, registry decision, and minimal publisher independently
enforce the same `>=0.1.0` boundary.

The preparation job has no OIDC authority. It verifies the signer, tag,
release-event commit, main ancestry, complete gate, package inventory,
dependencies, audit, npm hashes, and clean-consumer import. It packs once.

Only the final environment-scoped job receives `id-token: write`. It installs
no dependencies and publishes the exact prepared tarball with provenance.

## Registry safety

`npm run release:registry` requires the current stable version to be absent.
`npm run release:registry -- -- --manifest .release/package-manifest.json`
allows only two retry-safe outcomes: absent means publish, and an existing
byte-identical `dist.integrity` means skip. Different bytes or any registry
error other than `E404` stops the release.
