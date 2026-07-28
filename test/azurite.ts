import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TABLE_PORT = 10112;

let child: ChildProcess | undefined;
let workspace: string | undefined;

function accepting(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port: TABLE_PORT, host: "127.0.0.1" });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

export async function setup(): Promise<void> {
  const entry = join(
    process.cwd(),
    "node_modules",
    "azurite",
    "dist",
    "src",
    "table",
    "main.js",
  );
  if (!existsSync(entry)) {
    throw new Error(`Azurite table service is missing at ${entry}`);
  }
  workspace = await mkdtemp(join(tmpdir(), "pegma-mail-azurite-"));
  child = spawn(
    process.execPath,
    [
      entry,
      "--location",
      workspace,
      "--silent",
      "--tableHost",
      "127.0.0.1",
      "--tablePort",
      String(TABLE_PORT),
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await accepting()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Azurite did not start within 30 seconds");
}

export async function teardown(): Promise<void> {
  child?.kill();
  child = undefined;
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
}
