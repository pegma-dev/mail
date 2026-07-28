import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKAGE_FILES,
  RELEASE_PACKAGES,
  checkBootstrapRegistry,
  checkRegistry,
  decidePublication,
  parseArguments,
  prepareBootstrap,
  prepareRelease,
  publicRegistryArguments,
  validateBootstrapTag,
  validateRepository,
  verifyPreparedBootstrapManifest,
  verifyPreparedManifest,
} from "../scripts/release-packages.mjs";

async function startTestRegistry(
  serverScript: string,
  directory: string,
  label: string,
  integrity: string,
) {
  const recordPath = join(directory, `${label}-request.json`);
  const child = spawn(process.execPath, [serverScript, recordPath, integrity], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`${label} registry exited early with ${String(code)}`));
    });
    child.stdout.once("data", (chunk: Buffer) => {
      const value = Number.parseInt(chunk.toString("utf8").trim(), 10);
      if (!Number.isSafeInteger(value)) {
        reject(new Error(`${label} registry returned an invalid port`));
        return;
      }
      resolve(value);
    });
  });
  return {
    child,
    recordPath,
    url: `http://127.0.0.1:${port}/`,
  };
}

describe("release package metadata", () => {
  it("keeps the exact public package inventory", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual(["@pegma/mail"]);
    expect(PACKAGE_FILES).toEqual([
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "dist/index.js",
      "dist/index.js.map",
      "package.json",
    ]);
  });

  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
    expect(parseArguments(["--require-bootstrap-tag"])).toEqual({
      requireBootstrapTag: true,
    });
  });

  it("gives every bootstrap shortcut its safe artifact default", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(rootManifest.scripts).toMatchObject({
      "bootstrap:pack":
        "node scripts/release-packages.mjs bootstrap-pack --output .bootstrap-release",
      "bootstrap:registry":
        "node scripts/release-packages.mjs bootstrap-registry --manifest .bootstrap-release/package-manifest.json",
      "bootstrap:verify":
        "node scripts/release-packages.mjs bootstrap-verify --manifest .bootstrap-release/package-manifest.json",
    });
  });

  it("validates package metadata, exact dependencies, and lockfile together", async () => {
    await expect(validateRepository()).resolves.toBeDefined();
  });

  it("rejects the 0.0.0 bootstrap version from a release path", async () => {
    await expect(
      validateRepository({
        releaseTag: "v0.0.0",
        requireReleaseTag: true,
        expectedReleaseCommit: "0".repeat(40),
      }),
    ).rejects.toThrow("cannot use OIDC release publishing");
    await expect(prepareRelease()).rejects.toThrow(
      "use explicit bootstrap:pack mode",
    );
    await expect(checkRegistry()).rejects.toThrow(
      "use explicit bootstrap:registry mode",
    );
  });

  it("requires the exact bootstrap source tag in strict mode", () => {
    expect(() =>
      validateBootstrapTag({
        releaseTag: "v0.0.1",
        expectedReleaseCommit: "0".repeat(40),
      }),
    ).toThrow("requires the exact v0.0.0 source tag");
  });

  it("requires the prepared artifact for every bootstrap registry decision", async () => {
    await expect(checkBootstrapRegistry()).rejects.toThrow(
      "require an exact prepared manifest",
    );
  });

  it("prepares and verifies only the exact bootstrap artifact", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "pegma-mail-bootstrap-test-"),
    );
    try {
      const prepared = await prepareBootstrap({ output: directory });
      const record = prepared.manifest as {
        package: { integrity: string };
      };
      expect(prepared.manifest).toMatchObject({
        schemaVersion: 1,
        mode: "bootstrap",
        releaseTag: null,
        package: {
          name: "@pegma/mail",
          version: "0.0.0",
          files: PACKAGE_FILES.map((path) => ({
            path,
            size: expect.any(Number),
          })),
        },
      });
      await expect(
        verifyPreparedBootstrapManifest(prepared.manifestPath),
      ).resolves.toMatchObject({
        mode: "bootstrap",
        package: { name: "@pegma/mail", version: "0.0.0" },
      });
      await expect(
        verifyPreparedManifest(prepared.manifestPath),
      ).rejects.toThrow("prepared package manifest is invalid");
      const fakeNpm = join(directory, "fake-npm.mjs");
      await writeFile(
        fakeNpm,
        [
          'import { readFileSync } from "node:fs";',
          'const integrity = process.env["FAKE_NPM_INTEGRITY"];',
          'const registryIndex = process.argv.indexOf("--registry");',
          'if (process.argv[registryIndex + 1] !== "https://registry.npmjs.org/") {',
          '  process.stderr.write("public npm registry was not pinned\\n");',
          "  process.exit(2);",
          "}",
          'if (!process.argv.includes("--@pegma:registry=https://registry.npmjs.org/")) {',
          '  process.stderr.write("Pegma scope registry was not pinned\\n");',
          "  process.exit(2);",
          "}",
          'for (const option of ["--userconfig", "--globalconfig"]) {',
          "  const index = process.argv.indexOf(option);",
          '  if (index === -1 || readFileSync(process.argv[index + 1], "utf8") !== "") {',
          '    process.stderr.write("npm configuration was not isolated\\n");',
          "    process.exit(2);",
          "  }",
          "}",
          "const leaked = Object.keys(process.env).some((key) => {",
          "  const normalized = key.toLowerCase();",
          '  return normalized.startsWith("npm_config_") ||',
          '    normalized === "node_auth_token" ||',
          '    normalized === "npm_token" ||',
          '    normalized === "npm_auth_token";',
          "});",
          "if (leaked) {",
          '  process.stderr.write("npm credentials or configuration leaked\\n");',
          "  process.exit(2);",
          "}",
          'if (integrity === "absent") {',
          '  process.stderr.write("npm error code E404\\n");',
          "  process.exit(1);",
          "}",
          "process.stdout.write(JSON.stringify(integrity));",
          "",
        ].join("\n"),
      );
      const originalNpmExecPath = process.env["npm_execpath"];
      const hostileEnvironment = [
        "npm_config_registry",
        "npm_config_@pegma:registry",
        "NODE_AUTH_TOKEN",
        "NPM_TOKEN",
        "NPM_AUTH_TOKEN",
      ];
      const originalHostileEnvironment = new Map(
        hostileEnvironment.map((key) => [key, process.env[key]]),
      );
      try {
        process.env["npm_execpath"] = fakeNpm;
        process.env["npm_config_registry"] = "https://hostile.invalid/";
        process.env["npm_config_@pegma:registry"] = "https://hostile.invalid/";
        process.env["NODE_AUTH_TOKEN"] = "must-not-leak";
        process.env["NPM_TOKEN"] = "must-not-leak";
        process.env["NPM_AUTH_TOKEN"] = "must-not-leak";
        process.env["FAKE_NPM_INTEGRITY"] = "absent";
        await expect(
          checkBootstrapRegistry({ manifest: prepared.manifestPath }),
        ).resolves.toBe("publish");
        process.env["FAKE_NPM_INTEGRITY"] = record.package.integrity;
        await expect(
          checkBootstrapRegistry({ manifest: prepared.manifestPath }),
        ).resolves.toBe("skip");
        process.env["FAKE_NPM_INTEGRITY"] = "sha512-different";
        await expect(
          checkBootstrapRegistry({ manifest: prepared.manifestPath }),
        ).rejects.toThrow("different tarball integrity");
      } finally {
        if (originalNpmExecPath === undefined) {
          delete process.env["npm_execpath"];
        } else {
          process.env["npm_execpath"] = originalNpmExecPath;
        }
        delete process.env["FAKE_NPM_INTEGRITY"];
        for (const [key, value] of originalHostileEnvironment) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([undefined, null, "not-an-object"])(
    "rejects a malformed prepared package record cleanly: %j",
    async (packageRecord) => {
      const directory = await mkdtemp(
        join(tmpdir(), "pegma-mail-manifest-test-"),
      );
      const path = join(directory, "package-manifest.json");
      try {
        await writeFile(
          path,
          JSON.stringify({
            schemaVersion: 1,
            mode: "release",
            gitCommit: "0".repeat(40),
            releaseTag: "v1.0.0",
            ...(packageRecord === undefined ? {} : { package: packageRecord }),
          }),
        );
        await expect(verifyPreparedManifest(path)).rejects.toThrow(
          "prepared package manifest is invalid",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps OIDC authority only in the minimal publisher job", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const publish = workflow.slice(workflow.indexOf("\n  publish:"));
    const prepare = workflow.slice(
      workflow.indexOf("  prepare:"),
      workflow.indexOf("\n  publish:"),
    );
    expect(prepare).not.toContain("id-token: write");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm install");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("bootstrap:");
  });

  it("installs the reviewed npm before every CI matrix gate", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("          - 22");
    expect(workflow).toContain("          - 24");
    const installNpm = workflow.indexOf(
      "run: npm install --global npm@11.18.0",
    );
    const installDependencies = workflow.indexOf("run: npm ci");
    expect(installNpm).toBeGreaterThan(-1);
    expect(installNpm).toBeLessThan(installDependencies);
  });

  it("pins every manual bootstrap registry operation to npmjs", () => {
    const instructions = readFileSync(
      join(process.cwd(), "docs", "RELEASING.md"),
      "utf8",
    );
    expect(instructions).toContain('bootstrap_userconfig="$(mktemp)"');
    expect(instructions).toContain('bootstrap_globalconfig="$(mktemp)"');
    expect(instructions).toContain(
      `trap 'rm -f "\${allowed_signers}" "\${bootstrap_userconfig}" "\${bootstrap_globalconfig}"' EXIT`,
    );
    expect(instructions).toContain('test -z "${NODE_AUTH_TOKEN:-}"');
    expect(instructions).toContain('test -z "${NPM_TOKEN:-}"');
    expect(instructions).toContain('test -z "${NPM_AUTH_TOKEN:-}"');
    expect(instructions).toContain('--userconfig "${bootstrap_userconfig}"');
    expect(instructions).toContain(
      '--globalconfig "${bootstrap_globalconfig}"',
    );
    expect(instructions).toContain("--registry https://registry.npmjs.org/");
    expect(instructions).toContain(
      "--@pegma:registry=https://registry.npmjs.org/",
    );
    expect(instructions).toContain("npm_public login");
    expect(instructions).toContain("npm_public whoami");
    expect(instructions).toContain(
      "npm_public publish ./.bootstrap-release/pegma-mail-0.0.0.tgz --access public --tag bootstrap",
    );
  });

  it("defeats npm 11.18 scoped-registry precedence with an explicit scope override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pegma-npm-registry-test-"));
    const serverScript = join(directory, "registry-server.mjs");
    await writeFile(
      serverScript,
      [
        'import { writeFileSync } from "node:fs";',
        'import { createServer } from "node:http";',
        "const [recordPath, integrity] = process.argv.slice(2);",
        "const server = createServer((request, response) => {",
        "  writeFileSync(",
        "    recordPath,",
        "    JSON.stringify({",
        "      authorization: request.headers.authorization ?? null,",
        "      url: request.url,",
        "    }),",
        "  );",
        '  response.setHeader("content-type", "application/json");',
        "  response.end(",
        "    JSON.stringify({",
        '      _id: "@pegma/mail",',
        '      name: "@pegma/mail",',
        '      "dist-tags": { latest: "0.0.0" },',
        "      versions: {",
        '        "0.0.0": {',
        '          name: "@pegma/mail",',
        '          version: "0.0.0",',
        "          dist: { integrity },",
        "        },",
        "      },",
        "    }),",
        "  );",
        "});",
        'server.listen(0, "127.0.0.1", () => {',
        "  const address = server.address();",
        '  if (address === null || typeof address === "string") process.exit(1);',
        "  process.stdout.write(`${String(address.port)}\\n`);",
        "});",
        "",
      ].join("\n"),
    );
    const safe = await startTestRegistry(
      serverScript,
      directory,
      "safe",
      "sha512-safe",
    );
    const hostile = await startTestRegistry(
      serverScript,
      directory,
      "hostile",
      "sha512-hostile",
    );
    try {
      const userConfig = join(directory, "hostile.npmrc");
      const globalConfig = join(directory, "global.npmrc");
      await writeFile(
        userConfig,
        [
          `@pegma:registry=${hostile.url}`,
          `//127.0.0.1:${new URL(hostile.url).port}/:_authToken=hostile-test-token`,
          "",
        ].join("\n"),
      );
      await writeFile(globalConfig, "");
      const npmExecPath =
        process.env["npm_execpath"] ??
        join(
          dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
      expect(existsSync(npmExecPath)).toBe(true);
      const version = spawnSync(process.execPath, [npmExecPath!, "--version"], {
        encoding: "utf8",
      });
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe("11.18.0");

      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => {
          const normalized = key.toLowerCase();
          return (
            !normalized.startsWith("npm_config_") &&
            normalized !== "node_auth_token" &&
            normalized !== "npm_token" &&
            normalized !== "npm_auth_token"
          );
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          npmExecPath!,
          ...publicRegistryArguments(
            [
              "view",
              "@pegma/mail@0.0.0",
              "dist.integrity",
              "--json",
              "--userconfig",
              userConfig,
              "--globalconfig",
              globalConfig,
            ],
            safe.url,
          ),
        ],
        { cwd: directory, encoding: "utf8", env: environment },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBe("sha512-safe");
      expect(existsSync(hostile.recordPath)).toBe(false);
      expect(JSON.parse(readFileSync(safe.recordPath, "utf8"))).toMatchObject({
        authorization: null,
        url: "/@pegma%2fmail",
      });
    } finally {
      for (const registry of [safe, hostile]) {
        if (registry.child.exitCode === null) registry.child.kill();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("registry exact-integrity decisions", () => {
  const integrity = "sha512-cHJlcGFyZWQtdGFyYmFsbA==";

  it("publishes an absent version", () => {
    expect(decidePublication(integrity, null)).toBe("publish");
  });

  it("skips only a byte-identical existing version", () => {
    expect(decidePublication(integrity, integrity)).toBe("skip");
  });

  it("rejects an existing version with different bytes", () => {
    expect(() => decidePublication(integrity, "sha512-b3RoZXI=")).toThrow(
      "different tarball integrity",
    );
  });
});
