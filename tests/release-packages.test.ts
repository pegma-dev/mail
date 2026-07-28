import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  decidePublication,
  parseArguments,
  validateRepository,
  verifyPreparedManifest,
} from "../scripts/release-packages.mjs";

describe("release package metadata", () => {
  it("keeps the exact public package inventory", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual(["@pegma/mail"]);
  });

  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
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
    ).rejects.toThrow("can never be published");
  });

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
