#!/usr/bin/env node
import { createLogger, resolveConfig } from "./config.js";
import { spawnSync } from "node:child_process";
import { MuseHost, resolveBinary } from "./muse/host.js";
import { ModelCatalog } from "./muse/models.js";
import { startProxy } from "./proxy/server.js";

const USAGE = `open-muse — use your Muse Code subscription from OpenCode

Usage:
  open-muse doctor          Check that the muse CLI starts, is signed in, and list your models
  open-muse serve [--port N] Run the OpenAI-compatible proxy standalone (default port 4517)

Setup: add "open-muse" to the "plugin" list in ~/.config/opencode/opencode.json.`;

async function doctor(): Promise<number> {
  const config = resolveConfig();
  const log = createLogger(config);
  const host = new MuseHost(config, log);
  let ok = true;
  try {
    const init = await host.initializeResult();
    console.log(`✓ muse serve started (${init.serverInfo?.name ?? "muse"} ${init.serverInfo?.version ?? ""})`.trimEnd());
    console.log(`  muse home: ${init.museHome}`);

    try {
      const account = await host.request("account/read", {});
      console.log(`✓ account: ${JSON.stringify(account)}`);
    } catch {
      console.log("· account status not available from this muse build (that's fine)");
    }

    const models = await new ModelCatalog(host, config, log).refresh();
    console.log(`✓ ${models.length} model(s) available:`);
    for (const m of models) console.log(`  - ${config.providerId}/${m.id}${m.isDefault ? " (default)" : ""}`);

    if (process.platform === "win32") ok = checkWindowsSandbox(config.museBin) && ok;
  } catch (error) {
    ok = false;
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await host.close();
  }
  if (ok) console.log('\nReady. In OpenCode, pick a "muse/..." model (e.g. /models).');
  return ok ? 0 : 1;
}

/** Muse's tools run in an OS sandbox; on Windows it needs a one-time elevated setup or every command fails. */
function checkWindowsSandbox(museBin: string): boolean {
  const bin = resolveBinary(museBin);
  if (!bin) return false;
  const result = spawnSync(bin, ["sandbox", "windows", "check"], { encoding: "utf8", timeout: 30_000 });
  const status = /^status=(.*)$/m.exec(result.stdout ?? "")?.[1]?.trim();
  if (result.status === 0) {
    console.log(`✓ Windows sandbox ready${status ? ` (${status})` : ""}`);
    return true;
  }
  const reason = /^reason=(.*)$/m.exec(result.stdout ?? "")?.[1]?.trim();
  console.log(`✗ Windows sandbox not ready${reason ? `: ${reason}` : ""}`);
  console.log("  Muse can't run shell commands until it's set up. In a terminal, run once (asks for admin):");
  console.log("    muse sandbox windows setup");
  return false;
}

async function serve(args: string[]): Promise<number> {
  const portFlag = args.indexOf("--port");
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.OPEN_MUSE_PORT ?? 4517);
  const proxy = await startProxy(resolveConfig({ port }));
  console.log(`open-muse proxy listening on ${proxy.url}`);
  const stop = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise<number>(() => {});
}

const [command, ...rest] = process.argv.slice(2);
const run = command === "doctor" ? doctor() : command === "serve" ? serve(rest) : Promise.resolve((console.log(USAGE), command ? 1 : 0));
run.then((code) => process.exit(code));
