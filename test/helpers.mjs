import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
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
