import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const sum = (e, id) => e.summary(e.rooms.get(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { snapshots: false, gates: false };

/** A desk with some agents in memory, on the test's folders and settings. */
async function engineWith(t, adapters, snapshots = new Snapshots(t.home)) {
  t.engine.shutdown();
  const e = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots, notifier: { send() {} }, adapters: { ...ADAPTERS, ...adapters } });
  await e.init({ detect: false });
  return e;
}

/** Headless Codex in memory: a turn goes on until the test ends it, stopped or not (a process slow to stop). */
function slowCodex() {
  const calls = [];
  const codex = {
    ...ADAPTERS.codex,
    detect: async () => ({ installed: true }),
    currentLimits: () => null,
    run: (args) => new Promise((resolve) => calls.push({ prompt: args.prompt, end: (text = "Built.\nTORYO: REVIEW Slice 1: One | h.md") => resolve({ text, sessionId: "s1" }) })),
  };
  return { codex, calls };
}

/** The Codex app in memory: a turn sent is kept by the app once `submit` is called; following it goes on until `end`. */
function slowApp() {
  const calls = [];
  const app = {
    ...ADAPTERS.codexapp,
    detect: async () => ({ installed: true }),
    currentLimits: () => null,
    run: (args) =>
      new Promise((resolve) => {
        calls.push({ how: args.attach ? "follow" : "send", submit: () => args.onSubmitted?.(), end: (text) => resolve({ text, sessionId: "t1" }) });
        args.signal?.addEventListener("abort", () => args.signal.reason === "shutdown" && resolve({ text: "", aborted: true }));
        args.abandon?.addEventListener("abort", () => resolve({ text: "", aborted: true }));
      }),
  };
  return { app, calls };
}
const building = (t, what) => t.calls().some((c) => c.kind === "codex" && c.prompt.includes(what));
const busy = (fn, title) =>
  assert.throws(fn, (err) => {
    assert.deepEqual([err.status, err.code, err.room?.title], [409, "folder-busy", title]);
    assert.match(err.message, new RegExp(`^“${title}” is building in this folder \\(.+\\), so this build can't start now\\. You can have it wait: it starts when “${title}” is done or stopped\\.( Or give it its own worktree, a separate copy of the folder, where it can start now\\.)?$`));
    // Its own worktree is offered where the folder can have one (in Git).
    assert.equal(/its own worktree/.test(err.message), !/toryo-other-/.test(err.message));
    return true;
  });

test("a second build in a folder is refused, naming the room building there; one that waits starts when that room is done", async () => {
  const t = await setup([
    { agent: "codex", match: "First build", hang: true },
    { agent: "codex", reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md" },
    { agent: "claude", reply: "Good.\nTORYO: APPROVED" },
  ]);
  try {
    const e = t.engine;
    const first = e.createRoom({ projectId: "repo", mode: "build", task: "First build", title: "First" });
    await waitFor(() => building(t, "First build"), { label: "the first builder" });
    const rooms = e.rooms.size;
    busy(() => e.createRoom({ projectId: "repo", mode: "build", task: "Second build", title: "Second" }), "First");
    assert.equal(e.rooms.size, rooms, "nothing was created");
    // A room that's chatting can't start building there either; chatting is fine.
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude"], title: "Chat" });
    busy(() => e.control(chat.id, "start-build", { task: "Second build" }), "First");
    assert.equal(e.rooms.get(chat.id).mode, "chat");
    // Waiting: the room exists, its build waits, and both rooms say so.
    const second = e.createRoom({ projectId: "repo", mode: "build", task: "Second build", title: "Second", wait: true });
    assert.equal(sum(e, second.id).status, "held");
    assert.deepEqual(sum(e, second.id).blocked.flatMap((b) => b.reasons), ["“First” is building in this folder"]);
    assert.deepEqual(sum(e, second.id).folder.waitsFor, { id: first.id, title: "First" });
    assert.deepEqual([sum(e, first.id).folder.holding, sum(e, first.id).folder.waiting], [true, [{ id: second.id, title: "Second" }]]);
    assert.ok(e.roomView(second.id).events.some((x) => x.type === "system" && x.text === "Waiting: “First” is building in this folder. It goes on when that ends."));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!building(t, "Second build"), "its builder hasn't started");
    // The first room stops: once its builder has ended, the second takes the folder and builds.
    e.control(first.id, "stop");
    await waitFor(() => building(t, "Second build"), { label: "the second builder" });
    assert.deepEqual([sum(e, second.id).folder.holding, sum(e, first.id).folder], [true, null]);
    busy(() => e.control(first.id, "start-build", { task: "Again" }), "Second");
    e.control(second.id, "stop");
    await waitFor(() => !sum(e, second.id).running.length, { label: "stopped" });
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("the folder stays the build's through its checks and reviews, a pause, a hold and a restart; it's freed when the build is done", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Later build", reply: "Built later.\nTORYO: REVIEW Slice 1: Later | h.md" },
      { agent: "codex", match: "approved", reply: "All done.\nTORYO: DONE" },
      { agent: "codex", reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md" },
      { agent: "claude", match: "final", reply: "Final review: fine.\nTORYO: APPROVED" },
      { agent: "claude", reply: "Good.\nTORYO: APPROVED" },
    ],
    { gates: [{ name: "Check", command: "sleep 0.3", timeoutMin: 1 }] },
  );
  let e = t.engine;
  try {
    const first = e.createRoom({ projectId: "repo", mode: "build", task: "One slice", title: "First", settings: { autoContinue: false } });
    const second = e.createRoom({ projectId: "repo", mode: "build", task: "Later build", title: "Later", wait: true });
    const held = () => sum(e, second.id).folder.waitsFor?.title === "First" && !building(t, "Later build");
    // Building, the checks, the review: the second room waits throughout.
    const seen = new Set();
    await waitFor(() => {
      for (const w of sum(e, first.id).working) seen.add(w.kind);
      assert.ok(held(), "still waiting");
      return e.rooms.get(first.id).waiting?.kind === "slice-approved";
    }, { label: "the slice approved" });
    assert.ok(["build", "gates", "review"].every((k) => seen.has(k)), [...seen].join(", "));
    // Paused, held, after a restart: still the first room's.
    e.control(first.id, "pause");
    e.deskControl("hold", { target: "codex" });
    assert.ok(held());
    e.shutdown();
    e = await t.make();
    assert.ok(held(), "after a restart");
    assert.equal(sum(e, first.id).folder.holding, true);
    e.deskControl("release", { target: "codex" });
    e.control(first.id, "resume");
    // Done (the final review approves): the folder is free, and the waiting room builds.
    e.answer(first.id, { questionId: e.rooms.get(first.id).waiting.eventId, accept: true });
    await waitFor(() => e.rooms.get(first.id).done, { label: "the first build done", timeout: 15_000 });
    await waitFor(() => building(t, "Later build"), { label: "the later build" });
    e.control(second.id, "stop");
    await waitFor(() => !sum(e, second.id).running.length, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("one folder however it's named: another project for the same repository, a link to it, a folder inside it; other folders and linked worktrees are their own", async () => {
  const t = await setup([{ agent: "codex", hang: true }]);
  const outside = mkdtempSync(join(tmpdir(), "toryo-other-"));
  try {
    const e = t.engine;
    const git = (...a) => execFileSync("git", ["-C", t.repo, ...a], { stdio: "ignore" });
    mkdirSync(join(t.repo, "sub"));
    symlinkSync(t.repo, join(t.base, "linked"));
    git("worktree", "add", "-q", "-b", "side", join(t.base, "side"));
    execFileSync("git", ["init", "-q", join(outside, "other")]);
    writeFileSync(join(outside, "plain.txt"), "x");
    // Projects as a hand-edited config can name them.
    const add = (id, path) => e.config.projects.push({ id, name: id, path, rules: "", decisions: "", gates: [], agents: {} });
    add("alias", t.repo);
    add("linked", join(t.base, "linked"));
    add("sub", join(t.repo, "sub"));
    add("side", join(t.base, "side"));
    add("other", join(outside, "other"));
    add("plain", outside);
    add("plainsub", join(outside, "other"));
    e.createRoom({ projectId: "repo", mode: "build", task: "Main build", title: "Main" });
    for (const id of ["alias", "linked", "sub"]) busy(() => e.createRoom({ projectId: id, mode: "build", task: "x", title: id }), "Main");
    for (const id of ["side", "other"]) assert.equal(sum(e, e.createRoom({ projectId: id, mode: "build", task: "x", title: id }).id).folder.holding, true, id);
    // Outside Git, a folder and one inside it are one.
    busy(() => e.createRoom({ projectId: "plain", mode: "build", task: "x", title: "plain" }), "other");
    for (const r of e.rooms.values()) e.control(r.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    t.engine.shutdown();
    rmSync(outside, { recursive: true, force: true });
    t.cleanup();
  }
});

test("a build from before folders were claimed claims its own at a restart, from when it started: the earlier of two goes on; at the same moment, one of them, the same everywhere", async () => {
  for (const same of [false, true]) {
    const t = await setup([{ agent: "codex", match: "Newer", hang: true }, { agent: "codex", match: "Older", hang: true }]);
    let e = t.engine;
    try {
      const older = e.createRoom({ projectId: "repo", mode: "build", task: "Older build", title: "Older" });
      const newer = e.createRoom({ projectId: "repo", mode: "build", task: "Newer build", title: "Newer", wait: true });
      await waitFor(() => building(t, "Older build"), { label: "the older builder" });
      e.shutdown();
      // As saved by the version before: no claims, both building.
      for (const r of [older, newer]) {
        const saved = t.engine.store.loadRoom(r.id);
        delete saved.folderClaim;
        saved.build.startedAt = r === older || same ? "2026-10-01T09:00:00.000Z" : "2026-10-02T09:00:00.000Z";
        t.engine.store.saveRoom(saved);
      }
      e = await t.make();
      // The earlier claim wins; claims made at the same moment go by the rooms' ids.
      const [win, lose] = same ? [older, newer].sort((a, b) => (a.id < b.id ? -1 : 1)) : [older, newer];
      const task = (r) => (r === older ? "Older build" : "Newer build");
      assert.deepEqual([sum(e, win.id).folder.holding, sum(e, lose.id).folder?.holding ?? false], [true, false], `same: ${same}`);
      e.control(older.id, "resume");
      e.control(newer.id, "resume");
      assert.equal(sum(e, lose.id).folder.waitsFor?.title, win.title);
      const before = t.calls().filter((c) => c.prompt.includes(task(win))).length;
      await waitFor(() => t.calls().filter((c) => c.prompt.includes(task(win))).length === before + 1, { label: `${win.title} resumed` });
      await sleep(200);
      assert.ok(!t.calls().some((c) => c.prompt.includes(task(lose)) && c.prompt.includes("resumed")), `${lose.title} waits`);
      assert.equal(e.running.size, 1, "one builder in the folder");
      for (const r of [older, newer]) e.control(r.id, "stop");
      await waitFor(() => e.running.size === 0, { label: "stopped" });
    } finally {
      e.shutdown();
      t.cleanup();
    }
  }
});

test("a claim that lapsed is gone for good: a stopped room resumed, or written to, waits for the room that took the folder since, also while that one has nothing running", async () => {
  const t = await setup([
    { agent: "codex", match: "First build", hang: true },
    // The second builder asks you something: its build goes on, with nothing running.
    { agent: "codex", match: "Second build", reply: "Which way?\nTORYO: OWNER Tabs or spaces?" },
    { agent: "codex", reply: "On it.\nTORYO: REVIEW Slice 1: One | h.md" },
  ]);
  const e = t.engine;
  try {
    const first = e.createRoom({ projectId: "repo", mode: "build", task: "First build", title: "First", settings: quiet });
    await waitFor(() => building(t, "First build"), { label: "the first builder" });
    e.control(first.id, "stop");
    await waitFor(() => !sum(e, first.id).running.length, { label: "stopped" });
    const second = e.createRoom({ projectId: "repo", mode: "build", task: "Second build", title: "Second", settings: quiet });
    await waitFor(() => e.rooms.get(second.id).waiting, { label: "the second builder's question" });
    assert.equal(sum(e, second.id).running.length, 0);
    const codex = () => t.calls().filter((c) => c.kind === "codex").length;
    const n = codex();
    // Resumed: its old claim is gone, so it waits for the second.
    e.control(first.id, "resume");
    assert.deepEqual([sum(e, first.id).status, sum(e, first.id).folder.waitsFor?.title, sum(e, second.id).folder.holding], ["held", "Second", true]);
    // Stopped again, then written to (which resumes it): the same.
    e.control(first.id, "stop");
    e.postMessage(first.id, { text: "Carry on.", to: "codex", answering: false });
    assert.deepEqual([sum(e, first.id).status, sum(e, first.id).folder.waitsFor?.title], ["held", "Second"]);
    await sleep(200);
    assert.equal(codex(), n, "no second builder in the folder");
    for (const r of [first, second]) e.control(r.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("a deleted room keeps its folder until its turn has really ended", async () => {
  const t = await setup([]);
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  try {
    const first = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "First build", title: "First", settings: quiet });
    await waitFor(() => calls.length === 1, { label: "the first builder" });
    const second = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Second build", title: "Second", wait: true, settings: quiet });
    e.deleteRoom(first.id);
    await sleep(150);
    assert.equal(calls.length, 1, "the first's turn is still going: the second waits");
    assert.equal(sum(e, second.id).folder.waitsFor?.title, "First");
    calls[0].end();
    await waitFor(() => calls.length === 2, { label: "the second builder, once it ended" });
    assert.equal(sum(e, second.id).folder.holding, true);
    e.control(second.id, "stop");
    calls[1].end("");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("a room moved on to chat or planning while its build turn still runs keeps its folder until that turn ends", async () => {
  const t = await setup([{ agent: "claude", reply: "A proposal.\nTORYO: PROPOSAL" }]);
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  try {
    for (const how of ["chat", "plan"]) {
      const projectId = t.project(`moved-${how}`, e);
      const first = e.createRoom({ projectId, mode: "build", members: ["codex", "claude"], task: "First build", title: `First (${how})`, settings: quiet });
      await waitFor(() => calls.length && !calls.at(-1).done, { label: "the first builder" });
      const turn = calls.at(-1);
      const second = e.createRoom({ projectId, mode: "build", members: ["codex", "claude"], task: "Second build", title: `Second (${how})`, wait: true, settings: quiet });
      if (how === "chat") e.control(first.id, "chat-mode");
      else e.startPlan(first.id, { topic: "The next part", participants: ["claude"] });
      const n = calls.length;
      await sleep(150);
      assert.equal(calls.length, n, `${how}: the second waits while the first's build turn runs`);
      assert.equal(sum(e, second.id).folder.waitsFor?.title, `First (${how})`);
      turn.end();
      turn.done = true;
      await waitFor(() => calls.length === n + 1, { label: `${how}: the second builder` });
      calls.at(-1).done = true;
      e.control(second.id, "stop");
      calls.at(-1).end("");
      e.control(first.id, "stop");
      await waitFor(() => e.running.size === 0, { label: "stopped" });
    }
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("at a restart, a room whose Codex app turn is outstanding keeps its folder over an older claim, and following that turn goes on", async () => {
  const t = await setup([{ agent: "codex", reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md" }]);
  const { app, calls } = slowApp();
  let e = await engineWith(t, { codexapp: app });
  try {
    const appBuild = e.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "App build", title: "App build", appThread: "t1", settings: quiet });
    await waitFor(() => calls.length === 1, { label: "sent to the app" });
    calls[0].submit();
    assert.ok(e.rooms.get(appBuild.id).appTurn);
    const older = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Headless build", title: "Older", wait: true, settings: quiet });
    e.shutdown();
    // Its claim made older than the app room's (a claim from before, or a clock that moved).
    const saved = e.store.loadRoom(older.id);
    saved.folderClaim = { root: realpathSync(t.repo), git: true, at: "2026-01-01T00:00:00.000Z" };
    e.store.saveRoom(saved);
    e = new Engine({ folderDefault: "shared", store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app } });
    await e.init({ detect: false });
    await waitFor(() => calls.some((c) => c.how === "follow"), { label: "following the app's turn again" });
    await sleep(200);
    assert.ok(!t.calls().some((c) => c.kind === "codex"), "the headless builder waits");
    assert.deepEqual([sum(e, appBuild.id).folder.holding, sum(e, older.id).folder.waitsFor?.title], [true, "App build"]);
    for (const r of [appBuild, older]) e.control(r.id, "stop");
    e.control(appBuild.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "let go" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("two build starts at once over HTTP: one is admitted; the command line and MCP refuse the other the same way, and can wait", async () => {
  await withServer([{ agent: "codex", hang: true }], async ({ engine: e, client, home, post }) => {
    const start = (title) => post("/api/rooms", { projectId: "repo", mode: "build", task: `${title} build`, title });
    const both = await Promise.all([start("One"), start("Two")]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    const won = both.find((r) => r.status === 200).body.title;
    const lost = both.find((r) => r.status === 409).body;
    assert.deepEqual([lost.code, lost.room.title], ["folder-busy", won]);
    const hint = " To have it wait, run it again with --wait (wait: true in MCP).";
    await assert.rejects(client.start({ mode: "build", text: "Three build", title: "Three" }), (err) => err.message === `${lost.error.replace(/“(One|Two)”/g, `“${won}”`)}${hint}`);
    const m = mcp(home);
    try {
      const said = await m.call("toryo_start", { mode: "build", text: "Four build", title: "Four" });
      assert.deepEqual([said.error, said.text.endsWith(hint)], [true, true]);
      const waited = await m.call("toryo_start", { mode: "build", text: "Four build", title: "Four", wait: true });
      assert.match(waited.text, new RegExp(`^Started “Four” \\(build, id \\w+\\) in repo\\. It waits for its folder: “${won}” is building in it\\.$`));
    } finally {
      m.close();
    }
    const status = await client.statusText();
    assert.match(status, new RegExp(`• ${won} \\[build, running · Codex working\\][^\\n]*\\n    building in .+; waiting for this folder: “Four”`));
    assert.match(status, new RegExp(`• Four \\[build, held\\][^\\n]*\\n    waits for its folder: “${won}” is building in it`));
    for (const r of e.rooms.values()) e.control(r.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  });
});

test("a Codex app submission that ended uncertain is kept at once: the room can't be deleted, even while its turn is still being recorded, and its folder stays held", async () => {
  const t = await setup([{ agent: "claude", hang: true }]);
  // The snapshot after a turn, held back until the test lets it go: the moment between the app's answer and its record.
  let release;
  const held = new Promise((r) => (release = r));
  class SlowSnapshots extends Snapshots {
    async take(project, label) {
      if (/^after /.test(label)) await held;
      return super.take(project, label);
    }
  }
  const calls = [];
  const app = {
    ...ADAPTERS.codexapp,
    detect: async () => ({ installed: true }),
    currentLimits: () => null,
    run: (args) =>
      new Promise((resolve) => {
        calls.push(args.attach ? "follow" : "send");
        // Being handed over, with no answer yet (nothing kept so far).
        if (/Sending build/.test(args.prompt)) {
          args.onSubmitting?.();
          args.abandon?.addEventListener("abort", () => resolve({ text: "", aborted: true }));
          args.signal?.addEventListener("abort", () => args.signal.reason === "shutdown" && resolve({ text: "", aborted: true }));
          return;
        }
        if (args.attach) {
          args.abandon?.addEventListener("abort", () => resolve({ text: "", aborted: true }));
          args.signal?.addEventListener("abort", () => args.signal.reason === "shutdown" && resolve({ text: "", aborted: true }));
          return;
        }
        // Handed over, then no answer: Toryo can't tell whether the app has it.
        args.onSubmitting?.();
        resolve({ text: "", sessionId: "t1", uncertain: true, error: "codex queue didn't finish (ETIMEDOUT), so Toryo can't tell whether the Codex app has the message." });
      }),
  };
  const e = await engineWith(t, { codexapp: app }, new SlowSnapshots(t.home));
  try {
    const appBuild = e.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "App build", title: "App build", appThread: "t1", settings: { gates: false } });
    const later = e.createRoom({ projectId: "repo", mode: "build", members: ["claude"], task: "Later build", title: "Later", wait: true, settings: quiet });
    await waitFor(() => calls.length === 1 && e.rooms.get(appBuild.id).appTurn, { label: "the uncertain hand-over, kept" });
    // Its record still waits for the snapshot: the turn is kept already, and the room can't be deleted.
    assert.equal(e.rooms.get(appBuild.id).appTurn.uncertain, true);
    assert.equal(sum(e, appBuild.id).running.length, 1, "still being recorded");
    assert.throws(() => e.deleteRoom(appBuild.id), (err) => err.status === 409 && /The Codex app still has a turn from this room/.test(err.message));
    release();
    await waitFor(() => calls.includes("follow"), { label: "watched for" });
    await sleep(150);
    // The folder is still the app room's: the later build waits, and deleting is still refused.
    assert.deepEqual([sum(e, later.id).folder.waitsFor?.title, sum(e, later.id).running.length], ["App build", 0]);
    assert.throws(() => e.deleteRoom(appBuild.id), (err) => err.status === 409);
    // Let go (Stop, then Stop again): resolved by you, the folder is free and the later build goes.
    e.control(appBuild.id, "stop");
    e.control(appBuild.id, "stop");
    await waitFor(() => sum(e, later.id).running.length === 1, { label: "the later build" });
    e.control(later.id, "stop");
    // A hand-over still going on, before anything is kept: refused too.
    const sending = e.createRoom({ projectId: t.project("sending", e), mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "Sending build", title: "Sending", appThread: "t2", settings: quiet });
    await waitFor(() => e.rooms.get(sending.id).queue.length === 0 && sum(e, sending.id).running.length === 1 && calls.filter((c) => c === "send").length === 2, { label: "being handed over" });
    assert.equal(e.rooms.get(sending.id).appTurn ?? null, null);
    assert.throws(() => e.deleteRoom(sending.id), (err) => err.status === 409 && /The Codex app still has a turn from this room/.test(err.message));
    e.control(sending.id, "stop");
    e.control(sending.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    release();
    e.shutdown();
    t.cleanup();
  }
});
