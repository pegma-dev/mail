import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  validateBootstrapTag,
  validateRepository,
  verifyPreparedBootstrapManifest,
  verifyPreparedManifest,
} from "../scripts/release-packages.mjs";

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
          'const integrity = process.env["FAKE_NPM_INTEGRITY"];',
          'const registryIndex = process.argv.indexOf("--registry");',
          'if (process.argv[registryIndex + 1] !== "https://registry.npmjs.org/") {',
          '  process.stderr.write("public npm registry was not pinned\\n");',
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
      try {
        process.env["npm_execpath"] = fakeNpm;
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

  it("pins every manual bootstrap registry operation to npmjs", () => {
    const instructions = readFileSync(
      join(process.cwd(), "docs", "RELEASING.md"),
      "utf8",
    );
    expect(instructions).toContain(
      "npm ping --registry https://registry.npmjs.org/",
    );
    expect(instructions).toContain(
      "npm login --registry https://registry.npmjs.org/",
    );
    expect(instructions).toContain(
      "npm whoami --registry https://registry.npmjs.org/",
    );
    expect(instructions).toContain(
      "--tag bootstrap --registry https://registry.npmjs.org/",
    );
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
