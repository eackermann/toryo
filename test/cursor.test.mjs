import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursor, cursorArgs, cursorUsage } from "../src/agents/cursor.mjs";

test("Cursor: a read-only turn relies on the read-only mount, not Ask mode, which a resumed chat would keep", () => {
  const base = { cwd: "/repo", chat: "chat-1", prompt: "Review this." };
  const mounted = cursorArgs({ ...base, access: "read", mounted: true });
  assert.equal(mounted.includes("--mode"), false);
  assert.equal(mounted.includes("--force"), false);
  // Without the mount, Ask mode is the only protection left.
  for (const m of [false, undefined]) {
    const unmounted = cursorArgs({ ...base, access: "read", mounted: m });
    assert.deepEqual(unmounted.slice(unmounted.indexOf("--mode"), unmounted.indexOf("--mode") + 2), ["--mode", "ask"]);
  }
  const write = cursorArgs({ ...base, access: "write", mounted: false, cfg: { model: "gpt-x", extraArgs: ["--extra"] } });
  assert.deepEqual(write, ["-p", "--output-format", "stream-json", "--workspace", "/repo", "--trust", "--resume", "chat-1", "--model", "gpt-x", "--force", "--extra", "Review this."]);
  assert.equal(write.includes("--mode"), false);
  assert.equal(cursor.tested, true);
});

test("Cursor: usage from its result event is reported, with cache writes counted as input", async () => {
  assert.deepEqual(cursorUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 }), { input: 150, cached: 900, output: 20 });
  assert.deepEqual(cursorUsage({ inputTokens: 7 }), { input: 7, cached: 0, output: 0 });
  assert.equal(cursorUsage(null), null);

  // Through a turn, with a stand-in for the CLI that records its arguments.
  const dir = mkdtempSync(join(tmpdir(), "toryo-cursor-"));
  try {
    const bin = join(dir, "agent");
    const argsLog = join(dir, "args.json");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "create-chat") { console.log("chat-42"); process.exit(0); }
require("fs").writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", session_id: "chat-42" });
out({ type: "assistant", message: { content: [{ type: "text", text: "Done.\\nTORYO: REVIEW x | y" }] } });
out({ type: "result", subtype: "success", is_error: false, result: "Done.\\nTORYO: REVIEW x | y", session_id: "chat-42", usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3000, cacheWriteTokens: 300 } });
`,
    );
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
    const result = await cursor.run({ cfg: { command: [process.execPath, bin] }, cwd: dir, prompt: "Build it.", sessionId: null, access: "write", turnDir: dir, readOnlyPaths: null });
    assert.equal(result.error, null);
    assert.equal(result.sessionId, "chat-42");
    assert.deepEqual(result.usage, { input: 1500, cached: 3000, output: 80 });
    const args = JSON.parse(readFileSync(argsLog, "utf8"));
    assert.ok(args.includes("--force"));
    assert.equal(args.includes("--mode"), false);
    assert.equal(args.at(-1), "Build it.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cursor: without a working read-only mount, a read turn uses Ask mode, and its next writing turn starts a new chat", async () => {
  // The arguments follow whether the mount really happens, not whether Toryo asked for it.
  assert.ok(cursorArgs({ cwd: "/r", chat: "c", access: "read", mounted: false, prompt: "p" }).includes("ask"));
  assert.equal(cursorArgs({ cwd: "/r", chat: "c", access: "read", mounted: true, prompt: "p" }).includes("--mode"), false);

  const dir = mkdtempSync(join(tmpdir(), "toryo-cursor-"));
  // Outside the project folder: if this machine can mount, the read turn's folder is read-only.
  const logDir = mkdtempSync(join(tmpdir(), "toryo-cursor-log-"));
  try {
    const bin = join(logDir, "agent");
    const log = join(logDir, "calls.jsonl");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "create-chat") { const n = (fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter(Boolean).length : 0); console.log("chat-" + n); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const chat = args[args.indexOf("--resume") + 1];
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok\\nTORYO: REPLY", session_id: chat }));
`,
    );
    chmodSync(bin, 0o755);
    writeFileSync(join(logDir, "package.json"), JSON.stringify({ type: "commonjs" }));
    const cfg = { command: [process.execPath, bin] };
    const read = await cursor.run({ cfg, cwd: dir, prompt: "Review.", sessionId: null, access: "read", turnDir: dir, readOnlyPaths: [dir], mountable: () => false });
    assert.equal(read.askMode, true);
    const write = await cursor.run({ cfg, cwd: dir, prompt: "Build.", sessionId: read.sessionId, access: "write", turnDir: dir, readOnlyPaths: null, mountable: () => false });
    assert.equal(write.askMode, undefined);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(calls[0].slice(calls[0].indexOf("--mode"), calls[0].indexOf("--mode") + 2), ["--mode", "ask"], "nonempty paths, but no mount: Ask mode");
    assert.ok(calls[1].includes("--force"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }

  // In a room: after an Ask-mode turn, the next turn that writes gets a new chat, briefed, instead of the Ask-mode one.
  const { setup, turns, waitFor } = await import("./helpers.mjs");
  const t = await setup([]);
  try {
    const { Engine } = await import("../src/engine.mjs");
    const { Store } = await import("../src/store.mjs");
    const { Snapshots } = await import("../src/snapshots.mjs");
    const { ADAPTERS } = await import("../src/agents/index.mjs");
    const seen = [];
    const fake = { ...ADAPTERS.cursor, detect: async () => ({ installed: true }), run: async ({ sessionId, access, prompt }) => {
      seen.push({ sessionId, access, prompt });
      return access === "write" ? { text: "Built.\nTORYO: OWNER Done?", sessionId: "chat-w" } : { text: "Reviewed.\nTORYO: REPLY", sessionId: "chat-r", askMode: true };
    } };
    const engine = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, cursor: fake } });
    await engine.init({ detect: false });
    const room = engine.createRoom({ projectId: "repo", mode: "chat", members: ["cursor"], text: "Look at it." });
    await waitFor(() => turns(engine, room.id).some((x) => x.state === "done"), { label: "read turn" });
    engine.postMessage(room.id, { text: "Now change it.", to: "cursor", allowWrite: true });
    await waitFor(() => seen.length === 2 && turns(engine, room.id).filter((x) => x.state === "done").length === 2, { label: "write turn" });
    assert.equal(seen[1].access, "write");
    assert.equal(seen[1].sessionId, null, "a new chat, not the Ask-mode one");
    assert.match(seen[1].prompt, /Ask mode/);
  } finally {
    t.cleanup();
  }
});
