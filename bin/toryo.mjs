#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectAgents } from "../src/agents/index.mjs";
import { ToryoClient } from "../src/client.mjs";
import { Engine } from "../src/engine.mjs";
import { runMcpServer } from "../src/mcp.mjs";
import { Notifier } from "../src/notify.mjs";
import { loadPage } from "../src/page.mjs";
import { createServer } from "../src/server.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { toryoHome, isWsl, pidAlive } from "../src/util.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && ["to", "port", "host", "project", "plan", "room", "builder", "reviewer", "handoff-file", "slice", "thread", "question"].includes(args[i - 1].slice(2))));
const command = positional[0];

const HELP = `Toryo: a relay desk for coding agents.

Run the desk
  toryo                       start on http://localhost:4777
  toryo --open                start and open it in your browser
  toryo --port 4800           use another port
  toryo --lan                 also listen on your network, protected by an access token
  toryo quit                  stop the desk (running turns are offered again next time)

From any terminal (or an agent) while Toryo runs
  toryo status                rooms, who is working, questions waiting for you
  toryo show [room] [--full]  a room's latest messages (room: id or part of its title)
  toryo say [--room R] [--to codex|claude|everyone] [--now] [--ask|--tell] "message"
  toryo answer [--room R] [--question ID] "text"    or    toryo answer [--question ID] --accept
                                with several questions open (in that room, or in any room without --room),
                                --question picks one; status lists their ids
  toryo pause|resume|stop [room]
  toryo start chat|plan|build "text" [--plan docs/plans/x.md] [--project name]
  toryo start build "text" --review-first [--builder codexapp] [--reviewer claude] [--handoff-file f.md] [--slice name]
                                the builder already finished a round: the reviewer goes first
                                with the Codex app in the crew, --thread <id> picks its thread for this room
  toryo mcp                   MCP server for Claude Code / Codex (phone access through their apps)
  toryo doctor                which agent CLIs Toryo can find

Data lives in ${toryoHome()} (set TORYO_HOME to move it).`;

if (command === "help" || flag("help", false)) {
  console.log(HELP);
  process.exit(0);
}

const client = new ToryoClient();
const roomArg = () => (typeof flag("room", null) === "string" ? flag("room", null) : null);
try {
  switch (command) {
    case "quit": {
      const { pid, port } = client.server();
      const alive = pidAlive;
      if (!pid || !alive(pid)) {
        console.log(`Toryo isn't running on port ${port}.`);
        process.exit(0);
      }
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 20_000;
      while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      console.log(alive(pid) ? `Toryo (pid ${pid}) is still stopping.` : "Toryo stopped.");
      process.exit(0);
    }
    case "doctor": {
      const store = new Store(toryoHome());
      const config = store.loadConfig();
      const agents = await detectAgents(config?.agents ?? {});
      for (const [id, a] of Object.entries(agents))
        console.log(`${id.padEnd(7)} ${a.installed ? "✓" : "✗"} ${a.path ?? ""} ${a.version ?? ""}${a.installed ? "" : `  → ${a.hint ?? a.error ?? ""}`}${a.tested === false ? "  (adapter untested)" : ""}`);
      console.log(`\nprojects: ${(config?.projects ?? []).map((p) => `${p.name} (${p.path})`).join(", ") || "none yet"}`);
      process.exit(0);
    }
    case "status":
      console.log(await client.statusText());
      process.exit(0);
    case "show":
      console.log(await client.roomText(positional[1] ?? roomArg(), { last: 12, full: Boolean(flag("full", false)) }));
      process.exit(0);
    case "say":
      console.log(await client.say(roomArg(), positional.slice(1).join(" "), { to: typeof flag("to", "auto") === "string" ? flag("to", "auto") : "auto", now: Boolean(flag("now", false)), intent: flag("ask", false) ? "ask" : flag("tell", false) ? "tell" : undefined }));
      process.exit(0);
    case "answer":
      console.log(await client.answer(roomArg(), positional.slice(1).join(" "), { accept: Boolean(flag("accept", false)), question: typeof flag("question", null) === "string" ? flag("question", null) : undefined }));
      process.exit(0);
    case "pause":
    case "resume":
    case "stop":
      console.log(await client.control(positional[1] ?? roomArg(), command));
      process.exit(0);
    case "start": {
      const mode = positional[1];
      if (!["chat", "plan", "build"].includes(mode)) throw new Error("Usage: toryo start chat|plan|build \"text\"");
      const handoffFile = flag("handoff-file", undefined);
      console.log(
        await client.start({
          mode,
          text: positional.slice(2).join(" "),
          planPath: flag("plan", undefined),
          project: flag("project", undefined),
          builder: flag("builder", undefined),
          reviewer: flag("reviewer", undefined),
          reviewFirst: Boolean(flag("review-first", false)),
          handoff: handoffFile ? readFileSync(handoffFile, "utf8") : undefined,
          slice: flag("slice", undefined),
          appThread: flag("thread", undefined),
        }),
      );
      process.exit(0);
    }
    case "mcp":
      runMcpServer(client);
      break;
    case undefined:
      await serve();
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function serve() {
  const home = toryoHome();
  // WSL_INTEROP names the starting terminal's link to Windows, which dies with that terminal.
  // The distro's own link lasts, so a long-running desk uses that for notifications and the Codex app.
  if (isWsl() && process.env.WSL_INTEROP && existsSync("/run/WSL/1_interop")) delete process.env.WSL_INTEROP;
  const port = Number(flag("port", process.env.TORYO_PORT ?? process.env.FOREMAN_PORT ?? 4777));
  const lan = Boolean(flag("lan", false));
  const host = lan ? "0.0.0.0" : String(flag("host", "127.0.0.1"));
  const token = lan ? process.env.TORYO_TOKEN || process.env.FOREMAN_TOKEN || randomBytes(16).toString("hex") : null;

  // One desk per data folder. A second start opens the running desk rather than loading the rooms twice.
  // The probe carries the desk's token, so a desk started with --lan counts too.
  const running = new ToryoClient(home).server();
  if (running.pid && running.pid !== process.pid && pidAlive(running.pid)) {
    const alive = await fetch(`http://127.0.0.1:${running.port}/api/state`, {
      headers: running.token ? { "x-toryo-token": running.token } : {},
      signal: AbortSignal.timeout(3_000),
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (alive) {
      const url = `http://localhost:${running.port}/${running.token ? `?token=${running.token}` : ""}`;
      console.log(`Toryo is already running: ${url}`);
      if (flag("open", false)) openBrowser(url);
      return;
    }
  }
  // The page is read once, now, and served from memory: it always matches this server, and a broken page
  // stops the start before any room is touched. (TORYO_WEB_DIR is for testing another copy.)
  let page;
  try {
    page = loadPage(process.env.TORYO_WEB_DIR || join(root, "web"));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const store = new Store(home);
  // Whatever the probe saw, only one desk may load these rooms: take the folder's lock before recovering anything.
  const lock = await store.lockDesk();
  if (!lock.ok) {
    console.error(`Another Toryo${lock.pid ? ` (pid ${lock.pid})` : ""} is using ${home}. Stop it with: toryo quit`);
    process.exit(1);
  }
  const portFree = await new Promise((resolve) => {
    const probe = createNetServer().once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
  if (!portFree) {
    lock.release();
    console.error(`Port ${port} is busy. Is another Toryo running? Try: toryo --port ${port + 1}`);
    process.exit(1);
  }

  const engine = new Engine({ store, snapshots: new Snapshots(home), notifier: new Notifier(() => engine.config) });
  await engine.init();
  const app = createServer({ engine, page, host, port, token });
  try {
    await app.listen();
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      lock.release();
      console.error(`Port ${port} is busy. Is Toryo already running? Try: toryo --port ${port + 1}`);
      process.exit(1);
    }
    throw error;
  }
  writeFileSync(join(home, "server.json"), JSON.stringify({ port, pid: process.pid, token, startedAt: new Date().toISOString() }));
  const url = `http://localhost:${port}/${token ? `?token=${token}` : ""}`;
  console.log(`Toryo is running: ${url}`);
  console.log(`Data: ${home}`);
  const found = Object.entries(engine.agentStatus).filter(([, a]) => a.installed).map(([id]) => id);
  console.log(`Agents found: ${found.join(", ") || "none"}`);
  if (lan) console.log(`On your network: http://<this machine's address>:${port}/?token=${token}`);
  if (flag("open", false)) openBrowser(url);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\nStopping Toryo. Running turns are interrupted and offered again next time.");
    engine.shutdown();
    try {
      rmSync(join(home, "server.json"), { force: true });
    } catch {
      /* ignore */
    }
    // Give agent processes time to stop (SIGINT, then SIGTERM after 5 s, SIGKILL after 12 s).
    const deadline = Date.now() + 14_000;
    while (engine.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 1_000))]);
    lock.release();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function openBrowser(target) {
  const [cmd, cmdArgs] = isWsl()
    ? ["cmd.exe", ["/c", "start", "", target.replace(/&/g, "^&")]]
    : process.platform === "darwin"
      ? ["open", [target]]
      : ["xdg-open", [target]];
  try {
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* the URL is printed above */
  }
}
