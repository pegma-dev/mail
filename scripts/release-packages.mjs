import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = { directory: "mail", name: "@pegma/mail" };
const REPOSITORY_URL = "git+https://github.com/pegma-dev/mail.git";
const REVIEWED_NPM_VERSION = "11.18.0";
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const BOOTSTRAP_VERSION = "0.0.0";
const BOOTSTRAP_TAG = `v${BOOTSTRAP_VERSION}`;
const RELEASE_MODE = "release";
const BOOTSTRAP_MODE = "bootstrap";

export const RELEASE_PACKAGES = [PACKAGE];
export const PACKAGE_FILES = [
  "LICENSE",
  "README.md",
  "dist/index.d.ts",
  "dist/index.d.ts.map",
  "dist/index.js",
  "dist/index.js.map",
  "package.json",
];

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

function runNpm(arguments_, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, {
        ...options,
        shell: process.platform === "win32",
      })
    : run(process.execPath, [npmExecPath, ...arguments_], options);
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function rootDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function hashTarball(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

function validateSignedTag(options, releaseTag) {
  const root = resolve(options.root ?? rootDirectory());
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit)
  ) {
    fail("an exact release event commit is required");
  }
  const tagRef = `refs/tags/${releaseTag}`;
  const type = run(gitCommand(), ["cat-file", "-t", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (type.status !== 0 || type.stdout.trim() !== "tag") {
    fail("the release ref must be an annotated tag object");
  }
  const headCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const tagCommit = run(gitCommand(), ["rev-parse", `${tagRef}^{commit}`], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(headCommit, tagCommit) ||
    !safeEqual(headCommit, expectedReleaseCommit)
  ) {
    fail(
      "the release checkout, signed tag target, and release event commit must match",
    );
  }
  const signature = run(gitCommand(), ["verify-tag", "--raw", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("the release tag signature is not valid for an approved signer");
  }
  const onMain = run(
    gitCommand(),
    ["merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"],
    { cwd: root, capture: true, allowFailure: true },
  );
  if (onMain.status !== 0) {
    fail("the release tag commit must be contained in origin/main");
  }
  return { headCommit, releaseTag };
}

export function validateReleaseTag(options = {}) {
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag === BOOTSTRAP_TAG) {
    fail("the bootstrap 0.0.0 version cannot use OIDC release publishing");
  }
  if (releaseTag === undefined || !/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
    fail("a stable release tag is required");
  }
  return validateSignedTag(options, releaseTag);
}

export function validateBootstrapTag(options = {}) {
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== BOOTSTRAP_TAG) {
    fail(`manual bootstrap requires the exact ${BOOTSTRAP_TAG} source tag`);
  }
  return validateSignedTag(options, releaseTag);
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? rootDirectory());
  const rootManifest = await readJson(join(root, "package.json"));
  const packageDirectory = join(root, "packages", PACKAGE.directory);
  const manifest = await readJson(join(packageDirectory, "package.json"));
  const packageTsconfig = await readJson(
    join(packageDirectory, "tsconfig.json"),
  );
  const lockfile = await readJson(join(root, "package-lock.json"));
  const lockEntry = lockfile.packages?.[`packages/${PACKAGE.directory}`];

  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== `npm@${REVIEWED_NPM_VERSION}`
  ) {
    fail(`the private root must pin npm@${REVIEWED_NPM_VERSION}`);
  }
  if (
    manifest.name !== PACKAGE.name ||
    !STABLE_SEMVER.test(manifest.version) ||
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.registry !== PUBLIC_NPM_REGISTRY ||
    manifest.engines?.node !== ">=22" ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== "packages/mail"
  ) {
    fail(`${PACKAGE.name} has invalid public package metadata`);
  }
  if (
    manifest.dependencies?.["@pegma/spine"] !== "0.1.1" ||
    manifest.dependencies?.["@pegma/storage-core"] !== "0.3.0" ||
    Object.keys(manifest.dependencies ?? {}).length !== 2
  ) {
    fail(
      `${PACKAGE.name} must have the two exact reviewed runtime dependencies`,
    );
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => !entry.startsWith("dist/")) ||
    !manifest.scripts?.prepack?.includes("build")
  ) {
    fail(`${PACKAGE.name} has an unsafe package allowlist or prepack`);
  }
  if (
    !Array.isArray(packageTsconfig.exclude) ||
    !packageTsconfig.exclude.includes("src/**/*.test.ts")
  ) {
    fail(`${PACKAGE.name} must exclude tests from its build`);
  }
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail(`${PACKAGE.name} exports must point into dist`);
  }
  await stat(join(packageDirectory, "README.md"));
  await stat(join(packageDirectory, "LICENSE"));
  if (lockEntry?.version !== manifest.version) {
    fail(`${PACKAGE.name} version is not synchronized with package-lock.json`);
  }
  const publicWorkspaces = [];
  for (const entry of await readdir(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const workspace = await readJson(
      join(root, "packages", entry.name, "package.json"),
    );
    if (workspace.private !== true) publicWorkspaces.push(workspace.name);
  }
  if (publicWorkspaces.length !== 1 || publicWorkspaces[0] !== PACKAGE.name) {
    fail("public workspace inventory does not match the reviewed release list");
  }
  if (options.requireClean) {
    const status = run(gitCommand(), ["status", "--porcelain"], {
      cwd: root,
      capture: true,
    }).stdout;
    if (status.trim() !== "")
      fail("release preparation requires a clean checkout");
  }
  if (options.requireMainAncestor) {
    const head = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    const onMain = run(
      gitCommand(),
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, capture: true, allowFailure: true },
    );
    if (onMain.status !== 0) {
      fail("release commit must be contained in origin/main");
    }
  }
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined && releaseTag !== `v${manifest.version}`) {
    fail(`release tag must be v${manifest.version}`);
  }
  const prerelease =
    options.releasePrerelease ?? process.env.RELEASE_PRERELEASE ?? false;
  if (prerelease === true || prerelease === "true") {
    fail("prereleases cannot publish packages");
  }
  if (options.bootstrap === true && manifest.version !== BOOTSTRAP_VERSION) {
    fail(
      `manual bootstrap mode only accepts ${PACKAGE.name}@${BOOTSTRAP_VERSION}`,
    );
  }
  if (options.requireBootstrapTag) {
    if (options.bootstrap !== true) {
      fail("the bootstrap source-tag check requires bootstrap mode");
    }
    validateBootstrapTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  if (options.requireReleaseTag) {
    if (manifest.version === BOOTSTRAP_VERSION) {
      fail("the bootstrap 0.0.0 version cannot use OIDC release publishing");
    }
    validateReleaseTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  return { root, manifest, packageDirectory, releaseTag };
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path).sort();
  if (
    paths.length !== PACKAGE_FILES.length ||
    paths.some((path, index) => path !== PACKAGE_FILES[index])
  ) {
    fail(
      `${manifest.name} tarball does not match the exact reviewed inventory`,
    );
  }
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//u, "");
    if (!paths.includes(path)) fail(`${manifest.name} is missing ${path}`);
  }
}

async function smokeTestTarball(tarball, manifest) {
  const directory = await mkdtemp(join(tmpdir(), "mail-release-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"mail-release-smoke","private":true,"type":"module"}\n',
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      { cwd: directory, capture: true },
    );
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(manifest.name)})`,
      ],
      { cwd: directory, capture: true },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareRelease(options = {}) {
  const { root, manifest, packageDirectory, releaseTag } =
    await validateRepository(options);
  const mode = options.bootstrap === true ? BOOTSTRAP_MODE : RELEASE_MODE;
  if (mode === RELEASE_MODE && manifest.version === BOOTSTRAP_VERSION) {
    fail("use explicit bootstrap:pack mode for @pegma/mail@0.0.0");
  }
  const gitCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const output = resolve(root, options.output ?? ".release");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) {
    fail(`release output directory must be empty: ${output}`);
  }
  runNpm(["audit", "--omit=dev"], { cwd: root });
  runNpm(["run", "build"], { cwd: root });
  const packedResult = runNpm(
    ["pack", packageDirectory, "--json", "--pack-destination", output],
    { cwd: root, capture: true },
  );
  const [packed] = JSON.parse(packedResult.stdout);
  if (
    packed?.name !== manifest.name ||
    packed?.version !== manifest.version ||
    typeof packed.filename !== "string" ||
    !Array.isArray(packed.files)
  ) {
    fail("npm pack returned invalid metadata");
  }
  verifyPackedFiles(manifest, packed.files);
  const tarballPath = join(output, basename(packed.filename));
  const hashes = hashTarball(await readFile(tarballPath));
  if (
    !safeEqual(hashes.integrity, packed.integrity) ||
    !safeEqual(hashes.shasum, packed.shasum)
  ) {
    fail("tarball hashes do not match npm pack metadata");
  }
  await smokeTestTarball(tarballPath, manifest);
  const prepared = {
    schemaVersion: 1,
    mode,
    gitCommit,
    releaseTag: releaseTag ?? null,
    package: {
      name: manifest.name,
      version: manifest.version,
      tarball: basename(tarballPath),
      integrity: hashes.integrity,
      shasum: hashes.shasum,
      files: packed.files
        .map(({ path, size }) => ({ path, size }))
        .sort(
          (left, right) =>
            PACKAGE_FILES.indexOf(left.path) -
            PACKAGE_FILES.indexOf(right.path),
        ),
    },
  };
  const manifestPath = join(output, "package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`);
  return { manifestPath, manifest: prepared };
}

export async function prepareBootstrap(options = {}) {
  return prepareRelease({ ...options, bootstrap: true });
}

function queryRegistryIntegrity(name, version) {
  const spec = `${name}@${version}`;
  const result = runNpm(
    [
      "view",
      spec,
      "dist.integrity",
      "--json",
      "--registry",
      PUBLIC_NPM_REGISTRY,
    ],
    {
      capture: true,
      allowFailure: true,
    },
  );
  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout);
    if (typeof integrity !== "string" || integrity.length === 0) {
      fail(`${spec} exists without dist.integrity`);
    }
    return integrity;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b/u.test(output)) return null;
  fail(`npm registry lookup failed for ${spec}:\n${output.trim()}`);
}

export function decidePublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === null) return "publish";
  if (safeEqual(localIntegrity, registryIntegrity)) return "skip";
  fail("the registry version exists with different tarball integrity");
}

function requireTrustedPublishingNpm() {
  const version = runNpm(["--version"], { capture: true }).stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (match === null) fail(`could not parse npm version ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (
    major < 11 ||
    (major === 11 && minor < 5) ||
    (major === 11 && minor === 5 && patch < 1)
  ) {
    fail("trusted publishing requires npm 11.5.1 or newer");
  }
}

export async function checkRegistry(options = {}) {
  const { manifest } = await validateRepository(options);
  if (manifest.version === BOOTSTRAP_VERSION) {
    fail("use explicit bootstrap:registry mode for @pegma/mail@0.0.0");
  }
  const registry = queryRegistryIntegrity(manifest.name, manifest.version);
  if (options.manifest === undefined) {
    if (registry !== null) {
      fail(
        `${manifest.name}@${manifest.version} already exists in the registry`,
      );
    }
    return "absent";
  }
  const prepared = await verifyPreparedManifest(resolve(options.manifest));
  return decidePublication(prepared.package.integrity, registry);
}

function validPreparedFiles(files) {
  if (!Array.isArray(files) || files.length !== PACKAGE_FILES.length) {
    return false;
  }
  const paths = [];
  for (const file of files) {
    if (
      file === null ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      return false;
    }
    paths.push(file.path);
  }
  paths.sort();
  return paths.every((path, index) => path === PACKAGE_FILES[index]);
}

async function verifyPrepared(path, mode) {
  const prepared = await readJson(path);
  const record = prepared.package;
  const releaseVersion =
    typeof record?.version === "string" &&
    STABLE_SEMVER.test(record.version) &&
    record.version !== BOOTSTRAP_VERSION;
  const bootstrapVersion = record?.version === BOOTSTRAP_VERSION;
  const validTag =
    mode === RELEASE_MODE
      ? releaseVersion && prepared.releaseTag === `v${record.version}`
      : bootstrapVersion &&
        (prepared.releaseTag === null || prepared.releaseTag === BOOTSTRAP_TAG);
  if (
    prepared.schemaVersion !== 1 ||
    prepared.mode !== mode ||
    !/^[0-9a-f]{40,64}$/u.test(prepared.gitCommit) ||
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !validTag ||
    record?.name !== PACKAGE.name ||
    typeof record.integrity !== "string" ||
    typeof record.shasum !== "string" ||
    !validPreparedFiles(record.files)
  ) {
    fail("prepared package manifest is invalid");
  }
  const expectedTarball = `pegma-mail-${record.version}.tgz`;
  if (record.tarball !== expectedTarball) {
    fail("prepared tarball name is invalid");
  }
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: rootDirectory(),
    capture: true,
  }).stdout.trim();
  if (!safeEqual(currentCommit, prepared.gitCommit)) {
    fail("prepared package manifest commit does not match the checkout");
  }
  const tarball = resolve(dirname(path), record.tarball);
  if (dirname(tarball) !== resolve(dirname(path))) {
    fail("prepared tarball must be beside the package manifest");
  }
  const hashes = hashTarball(await readFile(tarball));
  if (
    !safeEqual(hashes.integrity, record.integrity) ||
    !safeEqual(hashes.shasum, record.shasum)
  ) {
    fail("prepared tarball has changed");
  }
  return prepared;
}

export function verifyPreparedManifest(path) {
  return verifyPrepared(path, RELEASE_MODE);
}

export function verifyPreparedBootstrapManifest(path) {
  return verifyPrepared(path, BOOTSTRAP_MODE);
}

export async function verifyBootstrapPreparation(options = {}) {
  const { manifest } = await validateRepository({
    ...options,
    bootstrap: true,
  });
  if (options.manifest === undefined) {
    fail("bootstrap verification requires an exact prepared manifest");
  }
  const prepared = await verifyPreparedBootstrapManifest(
    resolve(options.manifest),
  );
  if (
    prepared.package.version !== manifest.version ||
    (options.requireBootstrapTag && prepared.releaseTag !== BOOTSTRAP_TAG)
  ) {
    fail("prepared bootstrap manifest does not match its verified source");
  }
  return prepared;
}

export async function checkBootstrapRegistry(options = {}) {
  const { manifest } = await validateRepository({
    ...options,
    bootstrap: true,
  });
  if (options.manifest === undefined) {
    fail("bootstrap registry checks require an exact prepared manifest");
  }
  const prepared = await verifyBootstrapPreparation(options);
  const registry = queryRegistryIntegrity(manifest.name, manifest.version);
  return decidePublication(prepared.package.integrity, registry);
}

export async function publishPreparedRelease(options = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "release"
  ) {
    fail("release:publish is restricted to a GitHub release workflow");
  }
  requireTrustedPublishingNpm();
  const manifestPath = resolve(
    options.manifest ?? ".release/package-manifest.json",
  );
  const prepared = await verifyPreparedManifest(manifestPath);
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (
    releaseTag !== prepared.releaseTag ||
    expectedCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedCommit) ||
    !safeEqual(expectedCommit, prepared.gitCommit)
  ) {
    fail("prepared package must match the release event tag and commit");
  }
  const record = prepared.package;
  const decision = decidePublication(
    record.integrity,
    queryRegistryIntegrity(record.name, record.version),
  );
  if (decision === "skip") return;
  runNpm(
    [
      "publish",
      resolve(dirname(manifestPath), record.tarball),
      "--access",
      "public",
      "--provenance",
      "--registry",
      PUBLIC_NPM_REGISTRY,
    ],
    { cwd: dirname(manifestPath) },
  );
  const published = queryRegistryIntegrity(record.name, record.version);
  if (published === null || !safeEqual(published, record.integrity)) {
    fail("registry did not expose the exact prepared tarball integrity");
  }
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--require-main-ancestor") {
      options.requireMainAncestor = true;
      continue;
    }
    if (argument === "--require-clean") {
      options.requireClean = true;
      continue;
    }
    if (argument === "--require-release-tag") {
      options.requireReleaseTag = true;
      continue;
    }
    if (argument === "--require-bootstrap-tag") {
      options.requireBootstrapTag = true;
      continue;
    }
    const key =
      argument === "--root"
        ? "root"
        : argument === "--output"
          ? "output"
          : argument === "--manifest"
            ? "manifest"
            : argument === "--expected-release-commit"
              ? "expectedReleaseCommit"
              : null;
    if (key === null || arguments_[index + 1] === undefined) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "check") {
    await validateRepository(options);
    process.stdout.write("Release metadata is valid.\n");
    return;
  }
  if (command === "bootstrap-pack") {
    const { manifestPath } = await prepareBootstrap(options);
    process.stdout.write(`Prepared bootstrap package at ${manifestPath}.\n`);
    return;
  }
  if (command === "bootstrap-verify") {
    await verifyBootstrapPreparation(options);
    process.stdout.write("Prepared bootstrap package is valid.\n");
    return;
  }
  if (command === "bootstrap-registry") {
    const result = await checkBootstrapRegistry(options);
    process.stdout.write(`Bootstrap registry decision: ${result}.\n`);
    return;
  }
  if (command === "pack") {
    const { manifestPath } = await prepareRelease(options);
    process.stdout.write(`Prepared release package at ${manifestPath}.\n`);
    return;
  }
  if (command === "registry") {
    const result = await checkRegistry(options);
    process.stdout.write(`Registry decision: ${result}.\n`);
    return;
  }
  if (command === "publish") {
    await publishPreparedRelease(options);
    return;
  }
  fail(
    "usage: release-packages.mjs <check|pack|registry|publish|bootstrap-pack|bootstrap-verify|bootstrap-registry> [options]",
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
