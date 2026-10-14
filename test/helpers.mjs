import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToryoClient } from "../src/client.mjs";
import { Engine } from "../src/engine.mjs";
import { createServer } from "../src/server.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
export const FAKE = join(here, "fake-agent.mjs");

/** A temporary Toryo home, a temporary git project, and an engine wired to the fake agents. */
export async function setup(rules, { gates = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), "toryo-test-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "# test repo\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  const scriptPath = join(base, "script.json");
  const log = join(base, "calls.jsonl");
  writeFileSync(scriptPath, JSON.stringify({ rules, log }));
  process.env.FAKE_SCRIPT = scriptPath;
  // Headless Codex reads plan usage from Codex's session logs: point it at an empty folder, never the real ones.
  process.env.CODEX_HOME = join(base, "codex-home");

  const store = new Store(home);
  store.saveConfig({
    version: 1,
    notify: { windows: false },
    agents: {
      codex: { command: [process.execPath, FAKE, "codex"], permissions: "sandboxed" },
      claude: { command: [process.execPath, FAKE, "claude"] },
    },
    projects: [{ id: "repo", name: "repo", path: repo, rules: "", decisions: "", gates, agents: {} }],
  });
  const notes = [];
  const make = async () => {
    const engine = new Engine({ store, snapshots: new Snapshots(home), notifier: { send: (t, b) => notes.push({ t, b }) } });
    await engine.init({ detect: false });
    return engine;
  };
  const engine = await make();
  return {
    base,
    home,
    repo,
    engine,
    notes,
    make,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export async function waitFor(fn, { timeout = 20_000, label = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export const turns = (engine, roomId) => engine.roomView(roomId).events.filter((e) => e.type === "turn");

/** The engine behind a real HTTP server on a free port, as the CLI finds it (server.json); `client` talks to it. */
export async function withServer(rules, fn) {
  const t = await setup(rules);
  const app = createServer({ engine: t.engine, webDir: join(root, "web"), port: 0 });
  const addr = await app.listen();
  writeFileSync(join(t.home, "server.json"), JSON.stringify({ port: addr.port, pid: process.pid }));
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-toryo": "1" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ ...t, post, client: new ToryoClient(t.home) });
  } finally {
    await app.close();
    t.cleanup();
  }
}

/** The MCP server over stdio, as Claude Code or Codex runs it: call(tool, args) gives the tool's reply. */
export function mcp(home) {
  const child = spawn(process.execPath, [join(root, "bin", "toryo.mjs"), "mcp"], { env: { ...process.env, TORYO_HOME: home } });
  const replies = new Map();
  let buf = "";
  let next = 1;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      replies.set(m.id, m);
      buf = buf.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  return {
    async call(name, args) {
      const id = next++;
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      await waitFor(() => replies.has(id), { label: `MCP ${name}` });
      const r = replies.get(id).result;
      return { text: r.content[0].text, error: Boolean(r.isError) };
    },
    close: () => child.kill(),
  };
}
