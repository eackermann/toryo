import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { setup, turns, waitFor } from "./helpers.mjs";

const summary = (engine, id) => engine.summary(engine.rooms.get(id));
const kinds = (engine, id) => turns(engine, id).map((x) => `${x.agent}:${x.kind}:${x.status}`);
const CODEX = "you hold Codex (headless and the Codex app)";

test("holding Codex lets its turns finish in two rooms, starts no new Codex turn, and Claude carries on; releasing it wakes both", async () => {
  const t = await setup([
    // At work (started) for a while, so the hold comes while both turns are really under way.
    { agent: "codex", match: "Your role: builder", workMs: 1000, reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "codex", match: "approved", reply: "Next.\nTORYO: OWNER Which one?" },
  ]);
  try {
    const a = t.engine.createRoom({ projectId: "repo", mode: "build", task: "A" });
    // In a folder of its own: one builder per folder.
    const b = t.engine.createRoom({ projectId: t.project("other"), mode: "build", task: "B" });
    // Really started (the agent has the prompt), not still being prepared: a hold then would send it back unsent.
    const working = (id) => t.engine.roomView(id).live.some((l) => l.agent === "codex" && l.phase === "working");
    await waitFor(() => working(a.id) && working(b.id), { label: "both building" });
    const { message } = t.engine.deskControl("hold", { target: "codex" });
    assert.match(message, /Holding Codex \(headless and the Codex app\): Codex and Codex app finish the turns they're on/);
    for (const r of [a, b]) await waitFor(() => summary(t.engine, r.id).status === "held", { label: "held after review" });
    for (const r of [a, b]) {
      assert.deepEqual(kinds(t.engine, r.id), ["codex:build:REVIEW", "claude:review:APPROVED"], "the turn finished and Claude reviewed");
      assert.deepEqual(summary(t.engine, r.id).blocked, [{ agent: "codex", kind: "build-next", reasons: [CODEX] }]);
      assert.equal(t.engine.roomView(r.id).events.filter((e) => e.type === "system" && e.text.startsWith("Waiting: you hold Codex")).length, 1);
    }
    assert.equal(t.calls().filter((c) => c.kind === "codex").length, 2);
    t.engine.deskControl("release", { target: "codex" });
    for (const r of [a, b]) await waitFor(() => t.engine.rooms.get(r.id).waiting, { label: "next slice after release" });
    for (const r of [a, b]) assert.deepEqual(kinds(t.engine, r.id), ["codex:build:REVIEW", "claude:review:APPROVED", "codex:build-next:OWNER"]);
  } finally {
    t.cleanup();
  }
});

test("Pause everything: running checks finish, queued checks wait, new rooms and answers to questions wait, then all go on resume", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "ASK-ME", reply: "Before I start.\nTORYO: OWNER Tabs or spaces?" },
      { agent: "codex", match: "The owner answered", reply: "Using tabs.\nTORYO: OWNER Anything else?" },
      { agent: "codex", match: "SLOW-BUILD", delayMs: 700, reply: "Built D.\nTORYO: REVIEW S1 | h.md" },
      { agent: "codex", match: "Your role: builder", reply: "Built A.\nTORYO: REVIEW S1 | h.md" },
      { agent: "claude", match: "Your role: reviewer", reply: "Fine.\nTORYO: OWNER Ship it?" },
      { agent: "claude", reply: "Hello.\nTORYO: REPLY" },
    ],
    { gates: [{ name: "Slow check", command: "sleep 0.5; true" }] },
  );
  try {
    // Each build in a folder of its own: one builder per folder.
    const c = t.engine.createRoom({ projectId: t.project("asking"), mode: "build", task: "ASK-ME" });
    await waitFor(() => t.engine.rooms.get(c.id).waiting, { label: "builder's question" });
    const a = t.engine.createRoom({ projectId: "repo", mode: "build", task: "build it" });
    const d = t.engine.createRoom({ projectId: t.project("slow"), mode: "build", task: "SLOW-BUILD" });
    await waitFor(() => summary(t.engine, a.id).working.some((w) => w.kind === "gates"), { label: "A's checks running" });
    t.engine.deskControl("pause");
    // A's checks finish; its review waits. D's builder finishes; its checks wait.
    await waitFor(() => summary(t.engine, a.id).status === "held", { label: "A held" });
    assert.ok(t.engine.roomView(a.id).events.some((e) => e.type === "gate"), "the running checks finished");
    assert.deepEqual(summary(t.engine, a.id).blocked, [{ agent: "claude", kind: "review", reasons: ["everything is paused"] }]);
    await waitFor(() => summary(t.engine, d.id).status === "held", { label: "D held" });
    assert.deepEqual(summary(t.engine, d.id).blocked, [{ agent: "toryo", kind: "gates", reasons: ["everything is paused"] }]);
    // A new room, and an answer to a question, wait too.
    const b = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Hi" });
    assert.equal(summary(t.engine, b.id).status, "held");
    t.engine.answer(c.id, { text: "Tabs." });
    assert.equal(summary(t.engine, c.id).status, "held");
    assert.equal(turns(t.engine, b.id).length, 0);

    const { message } = t.engine.deskControl("resume");
    assert.match(message, /Everything resumed\. Rooms you paused yourself stay paused/);
    await waitFor(() => t.engine.rooms.get(a.id).waiting && t.engine.rooms.get(c.id).waiting && t.engine.rooms.get(d.id).waiting && turns(t.engine, b.id).some((x) => x.state === "done"), { label: "all carried on" });
    assert.deepEqual(kinds(t.engine, c.id), ["codex:build:OWNER", "codex:build-answer:OWNER"]);
    assert.deepEqual(kinds(t.engine, a.id), ["codex:build:REVIEW", "claude:review:OWNER"]);
  } finally {
    t.cleanup();
  }
});

test("hold scopes: Codex covers both Codex interfaces; the Codex app or headless Codex can be held alone; each releases on its own", async () => {
  const t = await setup([]);
  try {
    const e = t.engine;
    const held = (agent) => e.blockersFor({ agent }).length > 0;
    e.deskControl("hold", { target: "codexapp" });
    assert.deepEqual([held("codex"), held("codexapp"), held("claude")], [false, true, false]);
    e.deskControl("hold", { target: "codex" });
    assert.deepEqual([held("codex"), held("codexapp")], [true, true]);
    // Releasing the family hold leaves the app's own hold.
    const { message } = e.deskControl("release", { target: "codex" });
    assert.match(message, /Released Codex \(headless and the Codex app\)\. Still held: the Codex app\./);
    assert.deepEqual([held("codex"), held("codexapp")], [false, true]);
    e.deskControl("release", { target: "codexapp" });
    e.deskControl("hold", { target: "codex", headless: true });
    assert.deepEqual([held("codex"), held("codexapp")], [true, false]);
    assert.deepEqual(e.deskView().holds.map((h) => [h.key, h.label]), [["codex:headless", "headless Codex"]]);
    assert.throws(() => e.deskControl("hold", { target: "claude", headless: true }), /Only Codex can be held headless-only/);
    assert.throws(() => e.deskControl("release", { target: "claude" }), /Claude isn't held/);
    assert.throws(() => e.deskControl("hold", { target: "nobody" }), /no agent called “nobody”/);
    // Toryo's own checks aren't held by an agent hold, only by Pause everything.
    e.deskControl("hold", { target: "claude" });
    assert.deepEqual(e.blockersFor({ agent: "toryo", kind: "gates" }), []);
    e.deskControl("pause");
    assert.deepEqual(e.blockersFor({ agent: "toryo", kind: "gates" }), ["everything is paused"]);
  } finally {
    t.cleanup();
  }
});

test("desk controls and a room's own Pause don't undo each other", async () => {
  const t = await setup([{ agent: "claude", reply: "Hello.\nTORYO: REPLY" }]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"] });
    e.control(room.id, "pause");
    e.deskControl("hold", { target: "claude" });
    e.postMessage(room.id, { text: "Hi", to: "claude" });
    e.deskControl("pause");
    e.deskControl("resume");
    e.deskControl("release", { target: "claude" });
    assert.equal(summary(e, room.id).status, "paused", "releasing the desk didn't resume the room");
    e.deskControl("hold", { target: "claude" });
    e.control(room.id, "resume");
    assert.equal(summary(e, room.id).status, "held", "resuming the room didn't release Claude");
    assert.equal(turns(e, room.id).length, 0);
    e.deskControl("release", { target: "claude" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "reply" });
  } finally {
    t.cleanup();
  }
});

test("holds and Pause everything survive a restart, and are in force before any room starts", async () => {
  const t = await setup([{ agent: "claude", reply: "Hello.\nTORYO: REPLY" }]);
  try {
    t.engine.deskControl("hold", { target: "codex" });
    t.engine.deskControl("pause");
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Hi" });
    t.engine.shutdown();
    const again = await t.make();
    assert.ok(again.deskView().paused);
    assert.deepEqual(again.deskView().holds.map((h) => h.key), ["codex"]);
    assert.equal(summary(again, room.id).status, "held");
    assert.equal(turns(again, room.id).length, 0);
    again.deskControl("resume");
    await waitFor(() => turns(again, room.id).some((x) => x.state === "done"), { label: "reply after resume" });
    again.shutdown();
  } finally {
    t.cleanup();
  }
});

test("a desk file Toryo can't read, or one from a newer Toryo, stops anything new and is never overwritten", async () => {
  for (const [content, why] of [
    ["{not json", /can't read/],
    [JSON.stringify({ version: 9, holds: {} }), /a newer Toryo wrote it \(version 9\)/],
    [JSON.stringify({ version: 1, holds: { nobody: { at: "2026-10-13T08:00:00.000Z" } } }), /the hold “nobody” isn't valid/],
  ]) {
    const t = await setup([{ agent: "claude", reply: "Hello.\nTORYO: REPLY" }]);
    try {
      t.engine.shutdown();
      const path = join(t.home, "desk.json");
      writeFileSync(path, content);
      const e = await t.make();
      assert.equal(e.deskView().problem.kind, "unreadable");
      assert.match(e.deskView().problem.text, why);
      const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Hi" });
      assert.equal(summary(e, room.id).status, "held");
      assert.deepEqual(summary(e, room.id).blocked[0].reasons, ["Toryo can't read its desk controls"]);
      assert.throws(() => e.deskControl("resume"), /Nothing new starts until that's fixed/);
      assert.equal(readFileSync(path, "utf8"), content, "the file is left as it was");
      // Resetting sets it aside and starts with no controls.
      const { message } = e.deskControl("reset");
      assert.match(message, /the old file is at .*desk\.json\.unreadable-/);
      assert.ok(readdirSync(t.home).some((f) => f.startsWith("desk.json.unreadable-")));
      // A fresh desk, as a new one starts: version 2, with the usage guard on at its defaults.
      const fresh = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(fresh.version, 2);
      assert.deepEqual(fresh.guard.policies, {});
      assert.equal(fresh.guard.notice.pending, true);
      await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "reply after reset" });
      e.shutdown();
    } finally {
      t.cleanup();
    }
  }
});

test("a control Toryo couldn't save: a new restriction applies anyway and holds everything until saved; a release doesn't happen", async () => {
  const t = await setup([{ agent: "codex", reply: "Hi.\nTORYO: REPLY" }, { agent: "claude", reply: "Hello.\nTORYO: REPLY" }]);
  try {
    const e = t.engine;
    const write = e.store.writeJson.bind(e.store);
    let failing = true;
    e.store.writeJson = (file, value) => {
      if (failing && file.endsWith("desk.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return write(file, value);
    };
    assert.throws(() => e.deskControl("hold", { target: "claude" }), (err) => err.status === 500 && /couldn't save that \(ENOSPC\)\. It applies anyway/.test(err.message));
    assert.deepEqual(e.deskView().holds.map((h) => h.key), ["claude"]);
    assert.equal(e.deskView().problem.kind, "unsaved");
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], text: "Hi" });
    assert.deepEqual(summary(e, room.id).blocked[0].reasons, ["Toryo couldn't save your desk controls"], "nothing new starts, not even Codex");
    failing = false;
    e.deskControl("save");
    assert.equal(e.deskView().problem, null);
    assert.deepEqual(JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8")).holds.claude.agents, ["claude"]);
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "Codex goes once saved" });
    // A release that can't be saved doesn't release.
    failing = true;
    assert.throws(() => e.deskControl("release", { target: "claude" }), /Nothing changed/);
    assert.deepEqual(e.deskView().holds.map((h) => h.key), ["claude"]);
    assert.equal(e.deskView().problem, null, "what's saved still matches");
  } finally {
    t.cleanup();
  }
});

/** An engine whose agents run in-process and record the order they start in (snapshots off, so starting is synchronous). */
async function orderedEngine(t, order) {
  const fake = (id) => ({ ...ADAPTERS[id], detect: async () => ({ installed: true }), run: async ({ prompt }) => (order.push(prompt.match(/ROOM-(\w)/)?.[1] ?? "?"), { text: "ok\nTORYO: REPLY", sessionId: `${id}-s` }) });
  const engine = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex: fake("codex"), claude: fake("claude") } });
  await engine.init({ detect: false });
  return engine;
}

test("released work starts in every room, oldest first, whatever order the rooms were made in", async () => {
  const t = await setup([]);
  try {
    t.engine.shutdown();
    const order = [];
    const e = await orderedEngine(t, order);
    const rooms = Object.fromEntries(["X", "Y", "Z"].map((n) => [n, e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], settings: { snapshots: false } })]));
    e.deskControl("pause");
    for (const n of ["Z", "X", "Y"]) e.postMessage(rooms[n].id, { text: `ROOM-${n}`, to: "codex" });
    assert.deepEqual(order, []);
    e.deskControl("resume");
    assert.deepEqual(order, ["Z", "X", "Y"]);
    await waitFor(() => Object.values(rooms).every((r) => turns(e, r.id).every((x) => x.state !== "running")), { label: "turns finished" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("a release while a held agent's turn is ending starts its next turn exactly once", async () => {
  const t = await setup([]);
  try {
    t.engine.shutdown();
    const order = [];
    let release = null;
    const fake = { ...ADAPTERS.codex, detect: async () => ({ installed: true }), run: () => new Promise((resolve) => (order.push("run"), (release = () => resolve({ text: "ok\nTORYO: REPLY", sessionId: "s" })))) };
    const e = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex: fake } });
    await e.init({ detect: false });
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], settings: { snapshots: false }, text: "First." });
    await waitFor(() => order.length === 1, { label: "first turn" });
    e.deskControl("hold", { target: "codex" });
    e.postMessage(room.id, { text: "Second.", to: "codex" });
    // Release the hold in the same moment the first turn ends, from inside the engine's own event.
    e.on("event", ({ event }) => event.type === "turn" && event.state === "done" && e.deskView().holds.length && e.deskControl("release", { target: "codex" }));
    release();
    await waitFor(() => order.length === 2 && !e.rooms.get(room.id).queue.length, { label: "second turn" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(order.length, 2, "started once");
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("the desk's controls are on the API, saved before the answer", async () => {
  const t = await setup([]);
  try {
    const { createServer } = await import("../src/server.mjs");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const app = createServer({ engine: t.engine, webDir: join(dirname(fileURLToPath(import.meta.url)), "..", "web"), port: 0 });
    const { port } = await app.listen();
    try {
      const post = (body) => fetch(`http://127.0.0.1:${port}/api/desk`, { method: "POST", headers: { "content-type": "application/json", "x-toryo": "1" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
      const held = await post({ action: "hold", target: "codex", headless: true });
      assert.equal(held.status, 200);
      assert.match(held.body.message, /Holding headless Codex/);
      assert.deepEqual(JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8")).holds["codex:headless"].agents, ["codex"]);
      const bad = await post({ action: "release", target: "claude" });
      assert.equal(bad.status, 400);
      const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
      assert.deepEqual(state.desk.holds.map((h) => h.key), ["codex:headless"]);
    } finally {
      await app.close();
    }
    assert.ok(existsSync(join(t.home, "desk.json")));
  } finally {
    t.cleanup();
  }
});

test("a reset that can't be saved changes nothing: the unreadable file stays, nothing starts, and a restart still holds", async () => {
  const t = await setup([{ agent: "claude", reply: "Hello.\nTORYO: REPLY" }]);
  try {
    t.engine.shutdown();
    const path = join(t.home, "desk.json");
    writeFileSync(path, "{not json");
    const e = await t.make();
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Hi" });
    const write = e.store.writeJson.bind(e.store);
    e.store.writeJson = (file, value) => {
      if (file.includes("desk.json")) throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
      return write(file, value);
    };
    assert.throws(() => e.deskControl("reset"), (err) => err.status === 500 && /couldn't reset the desk controls \(EROFS\)\. Nothing changed/.test(err.message));
    assert.equal(e.deskView().problem.kind, "unreadable");
    assert.equal(readFileSync(path, "utf8"), "{not json");
    assert.deepEqual(readdirSync(t.home).filter((f) => f.startsWith("desk.json.")), [], "nothing set aside or left behind");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(turns(e, room.id).length, 0, "nothing started");
    e.store.writeJson = write;
    e.shutdown();
    // After a restart the file is still the unreadable one, and still holds everything.
    const again = await t.make();
    assert.equal(again.deskView().problem.kind, "unreadable");
    assert.equal(summary(again, room.id).status, "held");
    // A reset that can save works.
    again.deskControl("reset");
    await waitFor(() => turns(again, room.id).some((x) => x.state === "done"), { label: "reply after reset" });
    again.shutdown();
  } finally {
    t.cleanup();
  }
});

test("across rooms, requests start oldest first one at a time: A1, B1, A2", async () => {
  const t = await setup([]);
  try {
    t.engine.shutdown();
    const order = [];
    // The note addressed to this agent says which request this is (others in the room are only for its information).
    const fake = (id) => ({ ...ADAPTERS[id], detect: async () => ({ installed: true }), run: async ({ prompt }) => (order.push(prompt.match(/The owner \((?:to you|to everyone)[^)]*\)[^\n]*\nROOM-(\w+)/)?.[1]), { text: "ok\nTORYO: REPLY", sessionId: `${id}-s` }) });
    const e = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex: fake("codex"), claude: fake("claude") } });
    await e.init({ detect: false });
    const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude"], settings: { snapshots: false } });
    const b = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], settings: { snapshots: false } });
    e.deskControl("pause");
    e.postMessage(a.id, { text: "ROOM-A1", to: "codex" });
    e.postMessage(b.id, { text: "ROOM-B1", to: "codex" });
    e.postMessage(a.id, { text: "ROOM-A2", to: "claude" });
    e.deskControl("resume");
    assert.deepEqual(order, ["A1", "B1", "A2"]);
    await waitFor(() => [a, b].every((r) => turns(e, r.id).every((x) => x.state !== "running")), { label: "turns finished" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("when a shared Codex app thread frees up, the older request from another room goes before this room's newer one", async () => {
  const t = await setup([]);
  try {
    t.engine.shutdown();
    const order = [];
    const pending = [];
    const app = {
      ...ADAPTERS.codexapp,
      detect: async () => ({ installed: true }),
      currentLimits: () => null,
      run: ({ prompt }) => new Promise((resolve) => (order.push([...prompt.matchAll(/ROOM-(\w+)/g)].at(-1)?.[1]), pending.push(() => resolve({ text: "ok\nTORYO: REPLY", sessionId: "t1" })))),
    };
    const e = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app } });
    await e.init({ detect: false });
    const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
    const b = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "t1", settings: { snapshots: false } });
    e.postMessage(a.id, { text: "ROOM-A1", to: "codexapp" });
    assert.deepEqual(order, ["A1"]);
    e.postMessage(b.id, { text: "ROOM-B1", to: "codexapp" });
    e.postMessage(a.id, { text: "ROOM-A2", to: "codexapp" });
    assert.deepEqual(order, ["A1"], "the thread is busy");
    pending.shift()();
    await waitFor(() => order.length === 2, { label: "next app turn" });
    assert.deepEqual(order, ["A1", "B1"]);
    pending.shift()();
    await waitFor(() => order.length === 3, { label: "last app turn" });
    assert.deepEqual(order, ["A1", "B1", "A2"]);
    pending.shift()();
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("work queued behind a held step shows as held too, with the reason it waits", async () => {
  const t = await setup([
    { agent: "codex", reply: "Done.\nTORYO: REPLY" },
    { agent: "claude", reply: "Done.\nTORYO: REPLY" },
  ]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude"] });
    e.deskControl("hold", { target: "codex" });
    // File changes allowed: one at a time, Codex's first.
    e.postMessage(room.id, { text: "Both of you, change it.", to: "everyone", allowWrite: true });
    const s = summary(e, room.id);
    assert.equal(s.status, "held");
    assert.deepEqual(s.blocked, [
      { agent: "codex", kind: "chat", reasons: [CODEX] },
      { agent: "claude", kind: "chat", reasons: [`it comes after Codex's turn, which waits (${CODEX})`] },
    ]);
    assert.equal(turns(e, room.id).length, 0);
    e.deskControl("release", { target: "codex" });
    await waitFor(() => turns(e, room.id).filter((x) => x.state === "done").length === 2, { label: "both ran" });
    assert.deepEqual(turns(e, room.id).map((x) => x.agent), ["codex", "claude"]);
  } finally {
    t.cleanup();
  }
});

test("a reset whose final replace or copy fails leaves the unreadable file in place, so a restart still holds", async () => {
  for (const fail of ["rename", "copyFile"]) {
    const t = await setup([{ agent: "claude", reply: "Hello.\nTORYO: REPLY" }]);
    try {
      t.engine.shutdown();
      const path = join(t.home, "desk.json");
      writeFileSync(path, "{not json");
      const e = await t.make();
      const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Hi" });
      const real = e.store[fail].bind(e.store);
      e.store[fail] = (from, to) => {
        if (String(to).includes("desk.json")) throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
        return real(from, to);
      };
      assert.throws(() => e.deskControl("reset"), /Nothing changed/, fail);
      assert.equal(readFileSync(path, "utf8"), "{not json", `${fail}: the old file is still there`);
      assert.deepEqual(readdirSync(t.home).filter((f) => f.startsWith("desk.json.")), [], `${fail}: no copy or temporary file left`);
      assert.equal(e.deskView().problem.kind, "unreadable");
      e.store[fail] = real;
      e.shutdown();
      const again = await t.make();
      assert.equal(again.deskView().problem.kind, "unreadable", `${fail}: still unreadable after a restart`);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(turns(again, room.id).length, 0, `${fail}: nothing started after the restart`);
      again.shutdown();
    } finally {
      t.cleanup();
    }
  }
});

test("a notes turn queues as new work: another room's older request on the shared app thread goes first", async () => {
  const t = await setup([]);
  try {
    t.engine.shutdown();
    const order = [];
    const pending = [];
    const label = (prompt) => (/Building: your notes/.test(prompt) ? "A-notes" : /TASK-A/.test(prompt) ? "A1" : /TASK-B/.test(prompt) ? "B1" : "other");
    const app = {
      ...ADAPTERS.codexapp,
      detect: async () => ({ installed: true }),
      currentLimits: () => null,
      run: ({ prompt }) => new Promise((resolve) => (order.push(label(prompt)), pending.push((text) => resolve({ text, sessionId: "t1" })))),
    };
    const e = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app } });
    await e.init({ detect: false });
    const a = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp", "claude"], appThread: "t1", settings: { snapshots: false } });
    // The same app thread, but a folder of its own: one builder per folder.
    const b = e.createRoom({ projectId: t.project("other", e), mode: "chat", members: ["codexapp", "claude"], appThread: "t1", settings: { snapshots: false } });
    e.control(a.id, "start-build", { task: "TASK-A", builder: "codexapp", reviewer: "claude" });
    assert.deepEqual(order, ["A1"]);
    e.control(b.id, "start-build", { task: "TASK-B", builder: "codexapp", reviewer: "claude" });
    e.postMessage(a.id, { text: "Also add a changelog line.", to: "codexapp" });
    pending.shift()("Built A.\nTORYO: REVIEW S1 | h.md");
    await waitFor(() => order.length === 2, { label: "the next app turn" });
    assert.deepEqual(order, ["A1", "B1"], "B's older request goes before A's notes turn");
    pending.shift()("Built B.\nTORYO: OWNER Which?");
    await waitFor(() => order.length === 3, { label: "A's notes turn" });
    assert.deepEqual(order, ["A1", "B1", "A-notes"]);
    pending.shift()("N1: done.\nTORYO: OWNER Which?");
    await waitFor(() => e.rooms.get(a.id).waiting, { label: "A done" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("releasing a hold, or queueing work, from inside a room's Waiting notice is acted on at once", async () => {
  const t = await setup([
    { agent: "codex", reply: "Hi from Codex.\nTORYO: REPLY" },
    { agent: "claude", reply: "Hi from Claude.\nTORYO: REPLY" },
  ]);
  try {
    const e = t.engine;
    const other = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"] });
    e.deskControl("hold", { target: "codex" });
    let heard = 0;
    e.on("event", ({ event }) => {
      if (event.type !== "system" || !event.text.startsWith("Waiting: you hold Codex") || heard++) return;
      e.postMessage(other.id, { text: "Queued from the notice.", to: "claude" });
      e.deskControl("release", { target: "codex" });
    });
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], text: "Hello" });
    assert.equal(heard, 1);
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done") && turns(e, other.id).some((x) => x.state === "done"), { label: "both ran" });
    assert.equal(e.rooms.get(room.id).queue.length, 0);
  } finally {
    t.cleanup();
  }
});
