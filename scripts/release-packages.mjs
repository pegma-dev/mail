import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
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
const REVIEWED_PACKAGE_MANAGER =
  "pnpm@10.34.5+sha512.a4ee05f2f73658255bd6a89859c065a45c28a57daefae2c893a168ee2b73168c37b91e83e57ea67654ad03f03031746430e8bce38e362e042605fb8abc80192e";
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const BOOTSTRAP_VERSION = "0.0.0";
const BOOTSTRAP_TAG = `v${BOOTSTRAP_VERSION}`;
const FIRST_RELEASE_VERSION = "0.1.0";
const RELEASE_MODE = "release";
const BOOTSTRAP_MODE = "bootstrap";
const INVOCATION_EXEC_PATH = process.env.npm_execpath;

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

export function isNormalReleaseVersion(version) {
  const match =
    typeof version === "string" ? STABLE_SEMVER.exec(version) : null;
  return match !== null && (match[1] !== "0" || match[2] !== "0");
}

function requireNormalReleaseVersion(version) {
  if (!isNormalReleaseVersion(version)) {
    fail(`normal releases require version ${FIRST_RELEASE_VERSION} or later`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
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

function isPnpmCli(path) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.includes("/pnpm/") ||
    normalized.endsWith("/pnpm") ||
    normalized.endsWith("/pnpm.cjs") ||
    normalized.endsWith("/pnpm.js")
  );
}

export function resolveNpmCli() {
  const configured = process.env.npm_execpath;
  if (
    configured !== undefined &&
    !isPnpmCli(configured) &&
    existsSync(configured)
  ) {
    return configured;
  }
  const candidates = [];
  const lookup = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [process.platform === "win32" ? "npm.cmd" : "npm"],
    { encoding: "utf8", shell: false },
  );
  if (lookup.status === 0) {
    for (const executable of lookup.stdout.split(/\r?\n/u).filter(Boolean)) {
      if (process.platform !== "win32") {
        candidates.push(realpathSync(executable));
      } else {
        candidates.push(
          join(dirname(executable), "node_modules", "npm", "bin", "npm-cli.js"),
        );
      }
    }
  }
  candidates.push(
    process.platform === "win32"
      ? join(
          dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        )
      : join(
          dirname(process.execPath),
          "..",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
  );
  const cli = [...new Set(candidates)]
    .filter((candidate) => existsSync(candidate))
    .find((candidate) => {
      const version = spawnSync(process.execPath, [candidate, "--version"], {
        encoding: "utf8",
        env: isolatedNpmEnvironment(),
        shell: false,
      });
      return (
        version.status === 0 && version.stdout.trim() === REVIEWED_NPM_VERSION
      );
    });
  if (cli === undefined) fail("could not resolve the npm CLI");
  return cli;
}

function runNpm(arguments_, options = {}) {
  return run(process.execPath, [resolveNpmCli(), ...arguments_], options);
}

function isolatedNpmEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toLowerCase();
    if (
      normalized.startsWith("npm_config_") ||
      normalized === "node_auth_token" ||
      normalized === "npm_token" ||
      normalized === "npm_auth_token" ||
      normalized === "npm_execpath" ||
      normalized === "npm_lifecycle_event" ||
      normalized === "npm_lifecycle_script" ||
      normalized === "npm_command" ||
      normalized === "node_options" ||
      normalized === "node_extra_ca_certs" ||
      normalized.endsWith("_proxy")
    ) {
      continue;
    }
    environment[key] = value;
  }
  return environment;
}

export function publicRegistryArguments(
  arguments_,
  registry = PUBLIC_NPM_REGISTRY,
) {
  return [
    ...arguments_,
    "--registry",
    registry,
    `--@pegma:registry=${registry}`,
  ];
}

function runPublicRegistryPnpm(arguments_, options = {}) {
  const { registry = PUBLIC_NPM_REGISTRY, ...runOptions } = options;
  const configDirectory = mkdtempSync(
    join(tmpdir(), "pegma-mail-pnpm-config-"),
  );
  const userConfig = join(configDirectory, "user.npmrc");
  const globalConfig = join(configDirectory, "global.npmrc");
  writeFileSync(
    userConfig,
    `registry=${registry}\n@pegma:registry=${registry}\n`,
    { mode: 0o600 },
  );
  writeFileSync(globalConfig, "", { mode: 0o600 });
  try {
    const pnpmExecPath = [process.env.npm_execpath, INVOCATION_EXEC_PATH].find(
      (candidate) =>
        candidate !== undefined &&
        isPnpmCli(candidate) &&
        existsSync(candidate),
    );
    const environment = {
      ...isolatedNpmEnvironment(),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
    };
    const cwd = runOptions.cwd ?? configDirectory;
    if (pnpmExecPath !== undefined) {
      return run(process.execPath, [pnpmExecPath, ...arguments_], {
        ...runOptions,
        cwd,
        env: environment,
      });
    }
    return run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", arguments_, {
      ...runOptions,
      cwd,
      env: environment,
      shell: process.platform === "win32",
    });
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
}

function runPublicRegistryNpm(arguments_, options = {}) {
  const { registry = PUBLIC_NPM_REGISTRY, ...runOptions } = options;
  const configDirectory = mkdtempSync(join(tmpdir(), "pegma-mail-npm-"));
  const userConfig = join(configDirectory, "user.npmrc");
  const globalConfig = join(configDirectory, "global.npmrc");
  const workingDirectory = join(configDirectory, "work");
  mkdirSync(workingDirectory);
  writeFileSync(userConfig, "", { mode: 0o600 });
  writeFileSync(globalConfig, "", { mode: 0o600 });
  try {
    return runNpm(
      publicRegistryArguments(
        [
          ...arguments_,
          "--userconfig",
          userConfig,
          "--globalconfig",
          globalConfig,
        ],
        registry,
      ),
      {
        ...runOptions,
        cwd: runOptions.cwd ?? workingDirectory,
        env: isolatedNpmEnvironment(),
      },
    );
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
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
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const YAML_DOUBLE_QUOTE_ESCAPES = {
  0: "\u0000",
  a: "\u0007",
  b: "\u0008",
  t: "\u0009",
  n: "\u000a",
  v: "\u000b",
  f: "\u000c",
  r: "\u000d",
  e: "\u001b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

export function decodeYamlScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const body = value.slice(1, -1);
    let decoded = "";
    for (let index = 0; index < body.length; index += 1) {
      const character = body[index];
      if (character !== "\\") {
        decoded += character;
        continue;
      }
      const next = body[index + 1];
      if (next === undefined) {
        fail("unterminated YAML double-quoted escape");
      }
      if (next === "x" && /^[0-9A-Fa-f]{2}/u.test(body.slice(index + 2))) {
        decoded += String.fromCharCode(
          Number.parseInt(body.slice(index + 2, index + 4), 16),
        );
        index += 3;
        continue;
      }
      if (next === "u" && /^[0-9A-Fa-f]{4}/u.test(body.slice(index + 2))) {
        decoded += String.fromCharCode(
          Number.parseInt(body.slice(index + 2, index + 6), 16),
        );
        index += 5;
        continue;
      }
      if (next === "U" && /^[0-9A-Fa-f]{8}/u.test(body.slice(index + 2))) {
        decoded += String.fromCodePoint(
          Number.parseInt(body.slice(index + 2, index + 10), 16),
        );
        index += 9;
        continue;
      }
      if (next === "\n") {
        index += 1;
        continue;
      }
      const escaped = YAML_DOUBLE_QUOTE_ESCAPES[next];
      if (escaped === undefined) {
        fail(`unsupported YAML double-quoted escape \\${next}`);
      }
      decoded += escaped;
      index += 1;
    }
    return decoded;
  }
  return value;
}

function parseSemver(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      version,
    );
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function parsePartialSemver(version) {
  const match =
    /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      version,
    );
  if (match === null) return null;
  const precision =
    match[3] !== undefined
      ? "patch"
      : match[2] !== undefined
        ? "minor"
        : "major";
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ?? null,
    precision,
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^(0|[1-9]\d*)$/u.test(leftPart);
    const rightNumeric = /^(0|[1-9]\d*)$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = Number(leftPart);
      const rightNumber = Number(rightPart);
      if (leftNumber !== rightNumber) {
        return leftNumber < rightNumber ? -1 : 1;
      }
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareSemver(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

function stripLockVersionSuffix(version) {
  const suffix = version.indexOf("(");
  return suffix === -1 ? version : version.slice(0, suffix);
}

function isExactPin(specifier) {
  return parseSemver(specifier) !== null;
}

function versionInHalfOpenRange(resolved, lower, upper) {
  if (resolved.prerelease !== null && lower.prerelease === null) {
    return false;
  }
  return (
    compareSemver(resolved, lower) >= 0 && compareSemver(resolved, upper) < 0
  );
}

function caretUpperBound(base) {
  if (base.precision === "major") {
    return { major: base.major + 1, minor: 0, patch: 0, prerelease: "0" };
  }
  if (base.precision === "minor") {
    if (base.major > 0) {
      return { major: base.major + 1, minor: 0, patch: 0, prerelease: "0" };
    }
    return { major: 0, minor: base.minor + 1, patch: 0, prerelease: "0" };
  }
  if (base.major > 0) {
    return { major: base.major + 1, minor: 0, patch: 0, prerelease: "0" };
  }
  if (base.minor > 0) {
    return { major: 0, minor: base.minor + 1, patch: 0, prerelease: "0" };
  }
  return { major: 0, minor: 0, patch: base.patch + 1, prerelease: "0" };
}

function tildeUpperBound(base) {
  if (base.precision === "major") {
    return { major: base.major + 1, minor: 0, patch: 0, prerelease: "0" };
  }
  return {
    major: base.major,
    minor: base.minor + 1,
    patch: 0,
    prerelease: "0",
  };
}

function versionSatisfiesRange(version, specifier) {
  const resolved = parseSemver(stripLockVersionSuffix(version));
  if (resolved === null) return false;
  if (specifier === "*" || specifier === "x" || specifier === "X") {
    return resolved.prerelease === null;
  }
  if (specifier.startsWith("^")) {
    const base = parsePartialSemver(specifier.slice(1));
    return (
      base !== null &&
      versionInHalfOpenRange(resolved, base, caretUpperBound(base))
    );
  }
  if (specifier.startsWith("~")) {
    const base = parsePartialSemver(specifier.slice(1));
    return (
      base !== null &&
      versionInHalfOpenRange(resolved, base, tildeUpperBound(base))
    );
  }
  return false;
}

export function resolvedVersionMatchesSpecifier(version, specifier) {
  if (isExactPin(specifier)) {
    return version === specifier || version.startsWith(`${specifier}(`);
  }
  return versionSatisfiesRange(version, specifier);
}

function pnpmLockImporterBody(lockfile, importer) {
  const importerHeader = new RegExp(
    `^  (?:'${escapeRegExp(importer)}'|${escapeRegExp(importer)}):\\n`,
    "m",
  );
  const header = importerHeader.exec(lockfile);
  if (header === null) return null;
  const start = header.index + header[0].length;
  const rest = lockfile.slice(start);
  const nextImporter = rest.search(/^  [^ \n]/m);
  return nextImporter === -1 ? rest : rest.slice(0, nextImporter);
}

export function pnpmLockImporterHasSection(lockfile, importer, section) {
  const body = pnpmLockImporterBody(lockfile, importer);
  if (body === null) return false;
  return new RegExp(`^    ${escapeRegExp(section)}:\\n`, "m").test(body);
}

function pnpmLockImporterSection(lockfile, importer, section) {
  const body = pnpmLockImporterBody(lockfile, importer);
  if (body === null) return null;
  const header = new RegExp(`^    ${escapeRegExp(section)}:\\n`, "m");
  const match = header.exec(body);
  if (match === null) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextSection = rest.search(/^    [^ \n]/m);
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

function pnpmLockDependency(
  lockfile,
  importer,
  name,
  section = "dependencies",
) {
  const sectionText = pnpmLockImporterSection(lockfile, importer, section);
  if (sectionText === null) return null;
  const key = name.startsWith("@") || name.includes("/") ? `'${name}'` : name;
  const entry = new RegExp(
    `^      ${escapeRegExp(key)}:\\n        specifier: ([^\\n]+)\\n        version: ([^\\n]+)`,
    "m",
  );
  const match = entry.exec(sectionText);
  if (match === null) return null;
  return {
    specifier: decodeYamlScalar(match[1]),
    version: decodeYamlScalar(match[2]),
  };
}

export function requirePnpmLockDependencies(
  lockfile,
  importer,
  dependencies,
  section = "dependencies",
) {
  for (const [name, specifier] of Object.entries(dependencies)) {
    const locked = pnpmLockDependency(lockfile, importer, name, section);
    if (locked === null) {
      fail(`${name} is missing from pnpm-lock.yaml`);
    }
    if (locked.specifier !== specifier) {
      fail(`${name} specifier is not synchronized with pnpm-lock.yaml`);
    }
    if (locked.version.length === 0) {
      fail(`${name} resolved version is missing from pnpm-lock.yaml`);
    }
    if (!resolvedVersionMatchesSpecifier(locked.version, specifier)) {
      fail(`${name} resolved version is not synchronized with pnpm-lock.yaml`);
    }
  }
}

export function requirePublicPackageLockDependencies(
  lockfile,
  importer,
  manifest,
) {
  requirePnpmLockDependencies(
    lockfile,
    importer,
    manifest.dependencies ?? {},
    "dependencies",
  );
  if (pnpmLockImporterHasSection(lockfile, importer, "peerDependencies")) {
    requirePnpmLockDependencies(
      lockfile,
      importer,
      manifest.peerDependencies ?? {},
      "peerDependencies",
    );
  }
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
    !/^[0-9a-f]{40}$/u.test(expectedReleaseCommit)
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
  if (
    releaseTag === undefined ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(releaseTag)
  ) {
    fail("a stable release tag is required");
  }
  requireNormalReleaseVersion(releaseTag.slice(1));
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
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");

  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== REVIEWED_PACKAGE_MANAGER
  ) {
    fail(`the private root must pin ${REVIEWED_PACKAGE_MANAGER}`);
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
    manifest.dependencies?.["@pegma/storage-core"] !== "0.4.0" ||
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
    !(
      manifest.scripts?.prepack?.includes("build") ||
      manifest.scripts?.prepack?.includes("tsc")
    )
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
  requirePublicPackageLockDependencies(
    lockfile,
    `packages/${PACKAGE.directory}`,
    manifest,
  );
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
    requireNormalReleaseVersion(manifest.version);
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

export async function verifyReleaseDirectory(directory, expectedTarball) {
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  if (
    entries.length !== 2 ||
    entries.some(
      (entry) =>
        entry.name.startsWith(".") ||
        !entry.isFile() ||
        (entry.name !== "package-manifest.json" &&
          !/^pegma-mail-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.tgz$/u.test(
            entry.name,
          )),
    )
  ) {
    fail("release output does not match the expected file inventory");
  }
  const names = entries.map(({ name }) => name).sort();
  const tarballs = names.filter((name) => name.endsWith(".tgz"));
  if (
    !names.includes("package-manifest.json") ||
    tarballs.length !== 1 ||
    (expectedTarball !== undefined && tarballs[0] !== expectedTarball)
  ) {
    fail("release output does not match the expected file inventory");
  }
  for (const name of names) {
    const metadata = await lstat(join(root, name));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail("release output must contain regular files only");
    }
  }
  return { tarball: tarballs[0] };
}

async function smokeTestTarball(tarball, manifest, registry) {
  const directory = await mkdtemp(join(tmpdir(), "mail-release-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"mail-release-smoke","private":true,"type":"module"}\n',
    );
    runPublicRegistryNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      { cwd: directory, capture: true, registry },
    );
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(manifest.name)})`,
      ],
      { cwd: directory, capture: true, env: isolatedNpmEnvironment() },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function cleanPackageBuildOutputs(packageDirectory) {
  await Promise.all([
    rm(join(packageDirectory, "dist"), { recursive: true, force: true }),
    rm(join(packageDirectory, "tsconfig.tsbuildinfo"), { force: true }),
  ]);
}

export async function prepareRelease(options = {}) {
  const { root, manifest, packageDirectory, releaseTag } =
    await validateRepository(options);
  const mode = options.bootstrap === true ? BOOTSTRAP_MODE : RELEASE_MODE;
  if (mode === RELEASE_MODE) {
    requireNormalReleaseVersion(manifest.version);
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
  runPublicRegistryPnpm(["audit", "--prod"], {
    cwd: root,
    registry: options.registry,
  });
  await cleanPackageBuildOutputs(packageDirectory);
  runPublicRegistryNpm(["--prefix", packageDirectory, "run", "build"], {
    registry: options.registry,
  });
  const packedResult = runPublicRegistryNpm(
    [
      "pack",
      packageDirectory,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      output,
    ],
    { capture: true, registry: options.registry },
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
  await smokeTestTarball(tarballPath, manifest, options.registry);
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
      sha256: hashes.sha256,
      sha512: hashes.sha512,
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
  await verifyReleaseDirectory(output, basename(tarballPath));
  return { manifestPath, manifest: prepared };
}

export async function prepareBootstrap(options = {}) {
  return prepareRelease({ ...options, bootstrap: true });
}

function queryRegistryIntegrity(name, version) {
  const spec = `${name}@${version}`;
  const result = runPublicRegistryNpm(
    ["view", spec, "dist.integrity", "--json"],
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
  const { manifest, releaseTag } = await validateRepository(options);
  requireNormalReleaseVersion(manifest.version);
  let prepared = null;
  if (options.manifest !== undefined) {
    prepared = await verifyPreparedManifest(resolve(options.manifest));
    if (
      prepared.package.name !== manifest.name ||
      prepared.package.version !== manifest.version ||
      (releaseTag !== undefined && prepared.releaseTag !== releaseTag)
    ) {
      fail("prepared release manifest does not match its verified source");
    }
  }
  const registry = queryRegistryIntegrity(manifest.name, manifest.version);
  if (prepared === null) {
    if (registry !== null) {
      fail(
        `${manifest.name}@${manifest.version} already exists in the registry`,
      );
    }
    return "absent";
  }
  return decidePublication(prepared.package.integrity, registry);
}

function validPreparedFiles(files) {
  if (!Array.isArray(files) || files.length !== PACKAGE_FILES.length) {
    return false;
  }
  const paths = [];
  for (const file of files) {
    if (
      !hasExactKeys(file, ["path", "size"]) ||
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
  const manifestPath = resolve(path);
  if (basename(manifestPath) !== "package-manifest.json") {
    fail("prepared manifest must use the expected filename");
  }
  const prepared = await readJson(path);
  const record = prepared.package;
  const releaseVersion =
    typeof record?.version === "string" &&
    isNormalReleaseVersion(record.version);
  const bootstrapVersion = record?.version === BOOTSTRAP_VERSION;
  const validTag =
    mode === RELEASE_MODE
      ? releaseVersion && prepared.releaseTag === `v${record.version}`
      : bootstrapVersion &&
        (prepared.releaseTag === null || prepared.releaseTag === BOOTSTRAP_TAG);
  if (
    !hasExactKeys(prepared, [
      "schemaVersion",
      "mode",
      "gitCommit",
      "releaseTag",
      "package",
    ]) ||
    prepared.schemaVersion !== 1 ||
    prepared.mode !== mode ||
    !/^[0-9a-f]{40}$/u.test(prepared.gitCommit) ||
    !hasExactKeys(record, [
      "name",
      "version",
      "tarball",
      "integrity",
      "shasum",
      "sha256",
      "sha512",
      "files",
    ]) ||
    !validTag ||
    record?.name !== PACKAGE.name ||
    typeof record.integrity !== "string" ||
    typeof record.shasum !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.sha256) ||
    !/^[0-9a-f]{128}$/u.test(record.sha512) ||
    !validPreparedFiles(record.files)
  ) {
    fail("prepared package manifest is invalid");
  }
  const expectedTarball = `pegma-mail-${record.version}.tgz`;
  if (record.tarball !== expectedTarball) {
    fail("prepared tarball name is invalid");
  }
  await verifyReleaseDirectory(dirname(manifestPath), expectedTarball);
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: rootDirectory(),
    capture: true,
  }).stdout.trim();
  if (!safeEqual(currentCommit, prepared.gitCommit)) {
    fail("prepared package manifest commit does not match the checkout");
  }
  const tarball = resolve(dirname(manifestPath), record.tarball);
  if (dirname(tarball) !== resolve(dirname(manifestPath))) {
    fail("prepared tarball must be beside the package manifest");
  }
  const hashes = hashTarball(await readFile(tarball));
  if (
    !safeEqual(hashes.integrity, record.integrity) ||
    !safeEqual(hashes.shasum, record.shasum) ||
    !safeEqual(hashes.sha256, record.sha256) ||
    !safeEqual(hashes.sha512, record.sha512)
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
  requireNormalReleaseVersion(prepared.package.version);
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (
    releaseTag !== prepared.releaseTag ||
    expectedCommit === undefined ||
    !/^[0-9a-f]{40}$/u.test(expectedCommit) ||
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
  runPublicRegistryNpm([
    "publish",
    resolve(dirname(manifestPath), record.tarball),
    "--access",
    "public",
    "--provenance",
    "--ignore-scripts",
  ]);
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
    const { manifest } = await validateRepository(options);
    requireNormalReleaseVersion(manifest.version);
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
