import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { setup, turns, waitFor } from "./helpers.mjs";

const T = { a: "0aaaaaaa-0000-0000-0000-00000000000a", b: "0bbbbbbb-0000-0000-0000-00000000000b", p: "0ppppppp-0000-0000-0000-00000000000p", s: "0sssssss-0000-0000-0000-00000000000s", x: "0xxxxxxx-0000-0000-0000-00000000000x" };

/**
 * A stand-in Codex app: one session log per thread, and a codex.exe whose `queue` logs the thread
 * and makes the "app" finish the turn at once, except in thread `s`, where the turn never ends.
 */
async function fakeApp(base) {
  const home = join(base, "codex-home");
  const day = join(home, "sessions", "2026", "10", "13");
  mkdirSync(day, { recursive: true });
  const rollout = (id) => join(day, `rollout-2026-10-13T00-00-00-${id}.jsonl`);
  const done = (text) => JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: text } });
  for (const [key, id] of Object.entries(T)) writeFileSync(rollout(id), done(`Last reply in thread ${key}.\nTORYO: REVIEW Slice ${key} | h.md`) + "\n");
  const log = join(base, "queued.log");
  const exe = join(base, "codex.exe");
  writeFileSync(
    exe,
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const thread = a[a.indexOf("--thread") + 1];
const msg = a[a.indexOf("--message") + 1];
fs.appendFileSync(${JSON.stringify(log)}, thread + "\\n");
const lines = [{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: msg }] } }];
if (thread !== ${JSON.stringify(T.s)}) lines.push({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Answered in " + thread + ".\\nTORYO: REPLY" } });
const file = fs.readdirSync(${JSON.stringify(day)}).find((n) => n.includes(thread));
fs.appendFileSync(${JSON.stringify(day)} + "/" + file, lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
`,
  );
  chmodSync(exe, 0o755);
  // The app's list of threads: each one opened in the test's project folder (Toryo sends only to a thread there).
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("create table threads (id text, name text, preview text, cwd text, updated_at_ms integer, archived integer, source text)");
  for (const id of Object.values(T)) db.prepare("insert into threads values (?, ?, '', ?, 0, 0, 'vscode')").run(id, id, join(base, "repo"));
  db.close();
  return { cfg: { exe, codexHome: home, openThread: "never", pollMs: 50 }, queued: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("each room keeps its own Codex app thread; a new default only affects new rooms", async () => {
  const t = await setup([]);
  try {
    const app = await fakeApp(t.base);
    const engine = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: { ...ADAPTERS.codexapp, detect: async () => ({ installed: true }) } } });
    await engine.init({ detect: false });
    engine.updateConfig({ agents: { codexapp: { ...app.cfg, thread: T.a } } });
    const replies = (id) => turns(engine, id).filter((x) => x.state === "done").length;

    const one = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], text: "First room.", to: "codexapp" });
    await waitFor(() => replies(one.id) === 1, { label: "room one replied" });
    engine.updateConfig({ agents: { codexapp: { thread: T.b } } });
    const two = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], text: "Second room.", to: "codexapp" });
    await waitFor(() => replies(two.id) === 1, { label: "room two replied" });
    engine.postMessage(one.id, { text: "Room one again.", to: "codexapp" });
    await waitFor(() => replies(one.id) === 2, { label: "room one again" });
    assert.deepEqual(app.queued(), [T.a, T.b, T.a]);
    assert.equal(engine.rooms.get(one.id).sessions.codexapp, T.a);
    assert.equal(engine.rooms.get(two.id).sessions.codexapp, T.b);
    assert.equal(engine.summary(engine.rooms.get(one.id)).appThread, T.a);

    // The project's default comes before the general one; a thread chosen for the room comes first.
    engine.updateProject("repo", { agents: { codexapp: { thread: T.p } } });
    assert.equal(engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"] }).appThread, T.p);
    const chosen = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: T.x });
    assert.equal(chosen.appThread, T.x);

    // Starting from a handed-over round reads the room's thread, not the default.
    const handed = engine.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", reviewFirst: true, task: "x", appThread: T.x });
    assert.match(turns(engine, handed.id)[0].text, /Last reply in thread x\./);
    engine.control(handed.id, "stop");

    // A thread the app is working in for one room can't be given to another, and a busy room keeps its thread.
    const busy = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], text: "Never ends.", to: "codexapp", appThread: T.s });
    await waitFor(() => app.queued().includes(T.s), { label: "turn in the busy thread" });
    assert.throws(() => engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: T.s }), /working in that thread/);
    assert.throws(() => engine.control(busy.id, "app-thread", { thread: T.a }), /Change its thread once it has finished/);
    // Sharing an idle room's thread is allowed, with a warning.
    const sharing = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: T.a });
    assert.ok(engine.roomView(sharing.id).events.some((e) => e.type === "system" && e.level === "warn" && /also uses this Codex app thread/.test(e.text)));
    engine.control(busy.id, "stop");
    engine.control(busy.id, "stop");
    await waitFor(() => engine.running.size === 0, { label: "let go" });
    engine.control(one.id, "app-thread", { thread: T.x });
    assert.equal(engine.rooms.get(one.id).sessions.codexapp, T.x);
  } finally {
    t.cleanup();
  }
});

test("a new session keeps a room's Codex app thread: the app isn't started fresh, and it's told once", async () => {
  const t = await setup([]);
  const app = await fakeApp(t.base);
  const engine = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: { ...ADAPTERS.codexapp, detect: async () => ({ installed: true }) } } });
  try {
    await engine.init({ detect: false });
    engine.updateConfig({ agents: { codexapp: { ...app.cfg, thread: T.a } } });
    const replies = (id) => turns(engine, id).filter((x) => x.state === "done").length;
    const room = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], text: "First sprint.", to: "codexapp" });
    await waitFor(() => replies(room.id) === 1, { label: "a reply" });
    engine.newSession(room.id, { ends: 1 });
    const marker = engine.roomView(room.id).events.find((x) => x.type === "session");
    assert.deepEqual([marker.fresh, marker.kept, engine.rooms.get(room.id).sessions.codexapp], [[], ["codexapp"], T.a]);
    for (const text of ["Next sprint.", "And again."]) {
      engine.postMessage(room.id, { text, to: "codexapp", answering: false });
      await waitFor(() => replies(room.id) === (text === "Next sprint." ? 2 : 3), { label: text });
    }
    assert.deepEqual(app.queued(), [T.a, T.a, T.a], "the same thread throughout");
    const [, second, third] = turns(engine, room.id).map((x) => engine.turnPrompt(room.id, x.id));
    assert.match(second, /## A new session\nThe owner started a new session in this room \(session 2\)\./);
    assert.doesNotMatch(second, /First sprint/);
    assert.doesNotMatch(third, /## A new session/, "said once");
  } finally {
    engine.shutdown();
    t.cleanup();
  }
});

test("a stop while a Codex app turn is being prepared sends nothing to the app", async () => {
  const t = await setup([]);
  try {
    let submitted = 0;
    const app = {
      ...ADAPTERS.codexapp,
      detect: async () => ({ installed: true }),
      run: async ({ onSubmitted }) => {
        submitted++;
        onSubmitted?.();
        return { text: "x\nTORYO: REVIEW S | h.md" };
      },
    };
    const snapshots = new Snapshots(t.home);
    const take = snapshots.take.bind(snapshots);
    snapshots.take = async (...a) => (await new Promise((r) => setTimeout(r, 400)), take(...a));
    const engine = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots, notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app } });
    await engine.init({ detect: false });
    const room = engine.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "x", appThread: T.a });
    await waitFor(() => turns(engine, room.id).length === 1, { label: "turn being prepared" });
    engine.control(room.id, "stop");
    await waitFor(() => engine.running.size === 0, { label: "turn over" });
    assert.equal(submitted, 0);
    assert.equal(turns(engine, room.id)[0].state, "interrupted");
  } finally {
    t.cleanup();
  }
});

test("a stopped Codex app turn is still followed after a restart, and holds back new work until it ends", async () => {
  const t = await setup([]);
  try {
    const calls = [];
    let finish = null;
    const app = {
      ...ADAPTERS.codexapp,
      detect: async () => ({ installed: true }),
      currentLimits: () => null,
      run: ({ attach, onSubmitted, signal, abandon }) =>
        new Promise((resolve) => {
          calls.push(attach ? "follow" : "send");
          if (!attach) onSubmitted?.();
          finish = (text) => resolve({ text, sessionId: T.a });
          // Like the real adapter: only shutdown or abandon stops following.
          const quit = () => resolve({ text: "", aborted: true });
          signal.addEventListener("abort", () => signal.reason === "shutdown" && quit());
          abandon.addEventListener("abort", quit);
        }),
    };
    const make = async () => {
      const e = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app } });
      await e.init({ detect: false });
      return e;
    };
    const first = await make();
    const room = first.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "A", appThread: T.a });
    await waitFor(() => finish, { label: "app turn sent" });
    first.control(room.id, "stop");
    first.shutdown();
    await waitFor(() => first.running.size === 0, { label: "first desk stopped" });

    finish = null;
    const second = await make();
    await waitFor(() => finish, { label: "followed again" });
    assert.deepEqual(calls, ["send", "follow"]);
    assert.equal(second.summary(second.rooms.get(room.id)).status, "stopping");
    // Stopped, but the app still has its turn and may be writing: the folder is still this room's.
    assert.throws(() => second.createRoom({ projectId: "repo", mode: "build", members: ["claude"], task: "Elsewhere", title: "Elsewhere" }), (err) => err.code === "folder-busy" && err.room.id === room.id);
    // A new build waits for the app's turn rather than sending another one over it.
    const follow = finish;
    finish = null;
    second.startBuild(room.id, { task: "B" });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(calls, ["send", "follow"]);
    follow("Finished A in the app.\nTORYO: REVIEW A | h.md");
    await waitFor(() => finish, { label: "B sent once A ended" });
    assert.deepEqual(calls, ["send", "follow", "send"]);
    assert.ok(!turns(second, room.id).some((x) => x.kind === "review"), "A's result drove nothing");
    second.control(room.id, "stop");
    second.control(room.id, "stop");
    await waitFor(() => second.running.size === 0, { label: "let go" });
    // Let go, with nothing left running: the folder is free.
    assert.equal(second.summary(second.rooms.get(room.id)).folder, null);
    const elsewhere = second.createRoom({ projectId: "repo", mode: "build", members: ["claude"], task: "Elsewhere", title: "Elsewhere", settings: { gates: false } });
    assert.equal(second.summary(second.rooms.get(elsewhere.id)).folder.holding, true);
    second.control(elsewhere.id, "stop");
    await waitFor(() => second.running.size === 0, { label: "stopped" });
  } finally {
    t.cleanup();
  }
});
