import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const sum = (e, id) => e.summary(e.rooms.get(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reasons = (e, id) => sum(e, id).blocked.flatMap((b) => b.reasons);

async function engineWith(t, adapters) {
  t.engine.shutdown();
  const e = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, ...adapters } });
  await e.init({ detect: false });
  return e;
}

/** Headless Codex in memory: each turn goes on until the test ends it (`stubborn`: also once stopped, a slow process). */
function slowCodex({ stubborn = false } = {}) {
  const calls = [];
  const codex = {
    ...ADAPTERS.codex,
    detect: async () => ({ installed: true }),
    currentLimits: () => null,
    run: (args) =>
      new Promise((resolve) => {
        const call = { prompt: args.prompt, access: args.access, end: (text = "Built.\nTORYO: REVIEW Slice 1: One | h.md", extra = {}) => resolve({ text, sessionId: "s1", ...extra }) };
        calls.push(call);
        // It started: from here it could change files.
        args.onStarted?.({ sessionId: "s1" });
        if (!stubborn) args.signal?.addEventListener("abort", () => resolve({ text: "", aborted: true }));
      }),
  };
  return { codex, calls };
}

/** The Codex app in memory: each turn it's handed goes on until the test ends it. */
function slowApp() {
  const calls = [];
  const app = {
    ...ADAPTERS.codexapp,
    detect: async () => ({ installed: true }),
    currentLimits: () => null,
    run: (args) =>
      new Promise((resolve) => {
        calls.push({ access: args.access, end: (text) => (args.onSubmitted?.(), resolve({ text, sessionId: "t1" })) });
        args.signal?.addEventListener("abort", () => args.signal.reason === "shutdown" && resolve({ text: "", aborted: true }));
        args.abandon?.addEventListener("abort", () => resolve({ text: "", aborted: true }));
      }),
  };
  return { app, calls };
}

// A planning room with Claude alone: its proposal (read-only, so before any build writes in the folder), then, once
// you accept the checkpoint, its author writing the plan (step 3).
const PLAN_RULES = [
  { agent: "claude", match: "step 1 of 4", reply: "My proposal.\nTORYO: PROPOSAL" },
  { agent: "claude", match: "step 3 of 4", workMs: 300, write: { path: "docs/plans/next.md", content: "# Next\n\n### Slice 1: One\n" }, reply: "Written.\nTORYO: REVIEW docs/plans/next.md" },
];
async function planAtCheckpoint(e, title = "Plan room") {
  const plan = e.createRoom({ projectId: "repo", mode: "plan", topic: "The next sprint", members: ["claude"], title, planPath: "docs/plans/next.md" });
  await waitFor(() => sum(e, plan.id).questions.some((q) => q.kind === "plan-checkpoint"), { label: "the checkpoint" });
  return plan;
}
const authorWrites = (e, plan) => e.acceptCheckpoint(plan.id, { questionId: sum(e, plan.id).questions[0].id, synthesizer: "claude" });

test("a plan's author writes in the gap between a build's turns: the build keeps its folder, is told which files changed, and goes on after", async () => {
  const t = await setup([...PLAN_RULES, { agent: "claude", match: "Your role: reviewer", reply: "Good.\nTORYO: APPROVED" }]);
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  try {
    const plan = await planAtCheckpoint(e);
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Long build", title: "Long build", settings: { gates: false, autoContinue: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    authorWrites(e, plan);
    // While the builder writes, the author waits, saying why.
    await sleep(100);
    assert.equal(sum(e, plan.id).status, "held");
    assert.deepEqual(reasons(e, plan.id), ["it waits for a quiet moment in this folder: Codex is writing in this folder for “Long build”"]);
    assert.ok(!t.calls().some((c) => /step 3 of 4/.test(c.prompt)));
    // A second builder stays refused throughout.
    assert.throws(() => e.createRoom({ projectId: "repo", mode: "build", members: ["claude"], task: "x" }), (err) => err.code === "folder-busy");
    // The builder's turn ends: the author writes before the build's review.
    calls[0].end();
    await waitFor(() => turns(e, build.id).some((x) => x.kind === "review" && x.state === "done"), { label: "the review, after" });
    const author = turns(e, plan.id).find((x) => x.kind === "plan-synthesis");
    const review = turns(e, build.id).find((x) => x.kind === "review");
    assert.ok(author.endedAt <= review.startedAt, "the author wrote first; the review started after");
    assert.deepEqual(author.files.map((f) => f.path), ["docs/plans/next.md"]);
    assert.ok(existsSync(join(t.repo, "docs/plans/next.md")));
    // The build was told, once, in a line its agents read before their next turn; and it kept its folder.
    const notes = e.roomView(build.id).events.filter((x) => x.writesFrom === author.id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, "Between this build's turns, Claude changed files in this folder for “Plan room”: docs/plans/next.md. Take them into account before going on.");
    assert.match(t.calls().filter((c) => /Your role: reviewer/.test(c.prompt)).at(-1).prompt, /Claude changed files in this folder for “Plan room”: docs\/plans\/next\.md/);
    assert.equal(sum(e, build.id).folder.holding, true);
    e.control(build.id, "stop");
    e.control(plan.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("writers wait for a review already reading; a writable chat too; and a review during which files changed approves nothing by itself", async () => {
  const t = await setup([
    { agent: "claude", match: "Your role: reviewer", workMs: 1500, reply: "Good.\nTORYO: APPROVED", times: 1 },
    { agent: "claude", reply: "Looked again: good.\nTORYO: APPROVED" },
  ]);
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  try {
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { gates: false, autoContinue: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    calls[0].end();
    // The review under way (its first snapshot taken), someone edits a file in the folder (an editor, outside Toryo).
    await waitFor(() => turns(e, build.id).find((x) => x.kind === "review")?.snapBefore, { label: "the review" });
    writeFileSync(join(t.repo, "edited-meanwhile.txt"), "x");
    // A chat allowed to change files, in another room: it waits for the review to end.
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat" });
    e.postMessage(chat.id, { text: "Tidy the README.", to: "codex", allowWrite: true, answering: false });
    await sleep(100);
    assert.deepEqual(reasons(e, chat.id), ["it waits for a quiet moment in this folder: Claude is reviewing in this folder for “Build”"]);
    assert.equal(calls.length, 1);
    await waitFor(() => calls.length === 2, { label: "the chat, once the review ended" });
    assert.equal(calls[1].access, "write");
    const review = turns(e, build.id).find((x) => x.kind === "review");
    assert.ok(review.endedAt, "the review had ended");
    calls[1].end("Tidied.\nTORYO: REPLY");
    // Files changed during that review: its approval approves nothing; you're asked, and Claude is to look again.
    assert.deepEqual(review.outOfDate, ["edited-meanwhile.txt"]);
    await waitFor(() => e.rooms.get(build.id).waiting?.kind === "review-owner", { label: "your call" });
    assert.match(e.rooms.get(build.id).waiting.question, /^Files changed while Claude was reviewing \(edited-meanwhile\.txt\), so its approval may not cover them\. Should Claude look again\?$/);
    assert.deepEqual(e.rooms.get(build.id).build.approved, []);
    e.answer(build.id, { questionId: e.rooms.get(build.id).waiting.eventId, accept: true });
    await waitFor(() => e.rooms.get(build.id).build.approved.length === 1, { label: "approved once it looked again" });
    e.control(build.id, "stop");
    for (const c of calls) c.end("");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("an author that can't run doesn't keep the build waiting; with everything paused and resumed, the author goes first; two writers never run at once", async () => {
  const t = await setup([...PLAN_RULES, { agent: "claude", match: "Your role: reviewer", reply: "Good.\nTORYO: APPROVED" }], { gates: [{ name: "Quick", command: "true", timeoutMin: 1 }] });
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  const writers = [];
  const watch = setInterval(() => writers.push([...e.running.values()].filter((r) => r.req.access === "write" || r.req.kind === "gates").length), 5);
  try {
    const plan = await planAtCheckpoint(e);
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { autoContinue: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    authorWrites(e, plan);
    // Claude (the author) held: it doesn't keep the folder for itself. The builder's turn ends; the checks go on.
    e.deskControl("hold", { target: "claude" });
    calls[0].end();
    await waitFor(() => e.roomView(build.id).events.some((x) => x.type === "gate"), { label: "the checks, the author being held" });
    assert.ok(!t.calls().some((c) => /step 3 of 4/.test(c.prompt)));
    // A chat allowed to write, ready too; then everything paused, Claude released, and resumed: the author goes
    // first (before the build's review), then the chat; never two writers at once.
    e.deskControl("pause");
    e.deskControl("release", { target: "claude" });
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat" });
    e.postMessage(chat.id, { text: "Tidy the README.", to: "codex", allowWrite: true, answering: false });
    e.deskControl("resume");
    await waitFor(() => turns(e, plan.id).some((x) => x.kind === "plan-synthesis" && x.state === "done"), { label: "the author" });
    await waitFor(() => calls.length === 2, { label: "the chat, after" });
    calls[1].end("Tidied.\nTORYO: REPLY");
    await waitFor(() => turns(e, build.id).some((x) => x.kind === "review" && x.state === "done"), { label: "the review" });
    const author = turns(e, plan.id).find((x) => x.kind === "plan-synthesis");
    const review = turns(e, build.id).find((x) => x.kind === "review");
    assert.ok(author.endedAt <= review.startedAt, "the author before the build's review");
    assert.ok(Math.max(...writers) <= 1, `writers at once: ${Math.max(...writers)}`);
    e.control(build.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    clearInterval(watch);
    e.shutdown();
    t.cleanup();
  }
});

test("a folder you're using gets nothing new from Toryo, also after a restart, until you release it; the command line and MCP say so", async () => {
  await withServer([{ agent: "codex", reply: "Hi.\nTORYO: REPLY" }], async ({ engine: e, client, home }) => {
    const said = await client.desk("use-folder", { project: "repo" });
    assert.match(said, /^You're using .+repo: Toryo starts nothing new in it until you release it\. Toryo can't see what you do there; it only keeps its own work out\.$/);
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat", text: "Hello.", to: "codex" });
    assert.deepEqual([sum(e, room.id).status, reasons(e, room.id)], ["held", ["you're using this folder"]]);
    assert.match(await client.statusText(), /You're using .+repo \(since .+\): toryo folder release repo/);
    const m = mcp(home);
    try {
      const released = await m.call("toryo_desk", { action: "release-folder", project: "repo" });
      assert.match(released.text, /^Released .+repo: Toryo's work there goes on\.$/);
    } finally {
      m.close();
    }
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "the reply" });
  });
  // Across a restart.
  const t = await setup([{ agent: "codex", reply: "Hi.\nTORYO: REPLY" }]);
  let e = t.engine;
  try {
    e.deskControl("use-folder", { project: "repo" });
    e.shutdown();
    e = await t.make();
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat", text: "Hello.", to: "codex" });
    await sleep(150);
    assert.deepEqual([turns(e, room.id).length, reasons(e, room.id)], [0, ["you're using this folder"]]);
    assert.throws(() => e.deskControl("release-folder", { project: "nope" }), /No project called “nope”/);
    e.deskControl("release-folder", { project: "repo" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "the reply" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("the note to the build is sent once, also when Toryo acts on the author's turn again after a restart; a Codex app turn kept keeps writers out", async () => {
  const t = await setup([...PLAN_RULES]);
  const { codex, calls } = slowCodex();
  let e = await engineWith(t, { codex });
  try {
    const plan = await planAtCheckpoint(e);
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { gates: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    e.control(build.id, "pause");
    authorWrites(e, plan);
    calls[0].end();
    await waitFor(() => turns(e, plan.id).some((x) => x.kind === "plan-synthesis" && x.state === "done"), { label: "the author" });
    const author = turns(e, plan.id).find((x) => x.kind === "plan-synthesis");
    const notes = () => e.roomView(build.id).events.filter((x) => x.writesFrom === author.id).length;
    assert.equal(notes(), 1);
    // As if Toryo had stopped just as the author's turn ended: on its next start it acts on that turn again.
    e.shutdown();
    const saved = e.store.loadRoom(plan.id);
    saved.pendingOutcome = { turnId: author.id };
    e.store.saveRoom(saved);
    e = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex } });
    await e.init({ detect: false });
    assert.ok(e.roomView(plan.id).events.some((x) => x.reconciled === author.id), "acted on again");
    assert.equal(notes(), 1, "still one note");
    // A Codex app turn kept by a room in this folder (the app may be writing): a writer waits for it.
    e.rooms.get(build.id).appTurn = { marker: "[Toryo t-app]", req: { agent: "codexapp", kind: "build", access: "write" }, uncertain: true };
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat" });
    e.postMessage(chat.id, { text: "Tidy the README.", to: "codex", allowWrite: true, answering: false });
    // (Kept, or being followed again by then: either way, the app may be writing.)
    assert.match(reasons(e, chat.id).join(), /^it waits for a quiet moment in this folder: (the Codex app may still be writing|Codex app is writing) in this folder for “Build”$/);
    e.rooms.get(build.id).appTurn = null;
    for (const r of [build, plan, chat]) e.control(r.id, "stop");
    for (const c of calls) c.end("");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("an author that becomes ready after the build's next step was queued still writes before it", async () => {
  const t = await setup([...PLAN_RULES, { agent: "claude", match: "Your role: reviewer", reply: "Good.\nTORYO: APPROVED" }], { gates: [{ name: "Quick", command: "true", timeoutMin: 1 }] });
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  try {
    const plan = await planAtCheckpoint(e);
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { autoContinue: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    // Everything paused: the build's checks are queued first, then the author.
    e.deskControl("pause");
    calls[0].end();
    await waitFor(() => e.rooms.get(build.id).queue.some((q) => q.kind === "gates"), { label: "the checks, queued" });
    await sleep(5);
    e.acceptCheckpoint(plan.id, { questionId: sum(e, plan.id).questions[0].id, synthesizer: "claude" });
    e.deskControl("resume");
    await waitFor(() => e.roomView(build.id).events.some((x) => x.type === "gate"), { label: "the checks" });
    const author = turns(e, plan.id).find((x) => x.kind === "plan-synthesis");
    const gate = e.roomView(build.id).events.find((x) => x.type === "gate");
    assert.ok(author?.endedAt && author.endedAt <= gate.startedAt, "the author wrote before the checks ran");
    e.control(build.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("readers and writers in a folder don't overlap, whichever comes first: a writer waits for a reply being written, a reply waits for a writer", async () => {
  const t = await setup([{ agent: "claude", workMs: 800, reply: "Read it.\nTORYO: REPLY" }]);
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  try {
    const reading = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], title: "Reading" });
    const writing = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Writing" });
    // A reply being written first: the writer waits for it.
    e.postMessage(reading.id, { text: "What does the README say?", to: "claude", answering: false });
    await waitFor(() => sum(e, reading.id).running.length === 1, { label: "the reply" });
    e.postMessage(writing.id, { text: "Tidy the README.", to: "codex", allowWrite: true, answering: false });
    assert.deepEqual(reasons(e, writing.id), ["it waits for a quiet moment in this folder: Claude is reading this folder for “Reading”"]);
    await waitFor(() => calls.length === 1, { label: "the writer, once the reply ended" });
    assert.equal(sum(e, reading.id).running.length, 0);
    // The writer first: a reply waits for it.
    e.postMessage(reading.id, { text: "And now?", to: "claude", answering: false });
    assert.deepEqual(reasons(e, reading.id), ["Codex is writing in this folder for “Writing”"]);
    await sleep(150);
    assert.equal(turns(e, reading.id).length, 1);
    calls[0].end("Tidied.\nTORYO: REPLY");
    await waitFor(() => turns(e, reading.id).filter((x) => x.state === "done").length === 2, { label: "the reply, after" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("anything handed to the Codex app counts as writing, even a question asked read-only: it waits for the builder", async () => {
  const t = await setup([]);
  const { codex, calls } = slowCodex();
  const { app, calls: appCalls } = slowApp();
  const e = await engineWith(t, { codex, codexapp: app });
  try {
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { gates: false, autoContinue: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    const ask = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], title: "Ask the app", appThread: "t9", settings: { snapshots: false } });
    e.postMessage(ask.id, { text: "What do you think of the plan?", to: "codexapp", answering: false });
    assert.deepEqual(reasons(e, ask.id), ["it waits for a quiet moment in this folder: Codex is writing in this folder for “Build”"]);
    await sleep(150);
    assert.equal(appCalls.length, 0);
    calls[0].end("Stopping here.\nTORYO: OWNER Go on?");
    await waitFor(() => appCalls.length === 1, { label: "the app, once the builder's turn ended" });
    assert.equal(appCalls[0].access, "read");
    appCalls[0].end("Looks fine.\nTORYO: REPLY");
    e.control(build.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("a deleted chat room's turn keeps its place in the folder until it has really ended", async () => {
  const t = await setup([]);
  const { codex, calls } = slowCodex({ stubborn: true });
  const e = await engineWith(t, { codex });
  try {
    const first = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "First", settings: { snapshots: false } });
    const second = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Second", settings: { snapshots: false } });
    e.postMessage(first.id, { text: "Tidy the README.", to: "codex", allowWrite: true, answering: false });
    await waitFor(() => calls.length === 1, { label: "the first writer" });
    e.postMessage(second.id, { text: "Tidy the docs.", to: "codex", allowWrite: true, answering: false });
    e.deleteRoom(first.id);
    await sleep(150);
    assert.equal(calls.length, 1, "its turn still runs: the second writer waits");
    assert.deepEqual(reasons(e, second.id), ["it waits for a quiet moment in this folder: Codex is writing in this folder for “First”"]);
    calls[0].end("");
    await waitFor(() => calls.length === 2, { label: "the second writer, once it ended" });
    calls[1].end("Done.\nTORYO: REPLY");
    await waitFor(() => e.running.size === 0, { label: "done" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("a status-only verdict counts from the start of the review it belongs to: files changed in between approve nothing", async () => {
  const t = await setup([
    { agent: "claude", match: "no TORYO status line", reply: "TORYO: APPROVED" },
    { agent: "claude", match: "Your role: reviewer", workMs: 400, reply: "Looks fine overall." },
  ]);
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  try {
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { gates: false, autoContinue: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    calls[0].end();
    await waitFor(() => sum(e, build.id).working.some((w) => w.kind === "review"), { label: "the review" });
    // A writable chat waits for the review; it writes between the review and its status-only follow-up.
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat" });
    e.postMessage(chat.id, { text: "Tidy the README.", to: "codex", allowWrite: true, answering: false });
    await waitFor(() => calls.length === 2, { label: "the chat, between them" });
    assert.ok(turns(e, build.id).find((x) => x.kind === "review").state === "done");
    assert.ok(!turns(e, build.id).some((x) => x.kind === "review-status"), "the status turn hasn't started");
    writeFileSync(join(t.repo, "between.txt"), "x");
    calls[1].end("Tidied.\nTORYO: REPLY");
    await waitFor(() => e.rooms.get(build.id).waiting?.kind === "review-owner", { label: "your call" });
    const status = turns(e, build.id).find((x) => x.kind === "review-status");
    assert.deepEqual([status.status, status.outOfDate], ["APPROVED", ["between.txt"]]);
    assert.match(e.rooms.get(build.id).waiting.question, /^Files changed while Claude was reviewing \(between\.txt\)/);
    assert.deepEqual(e.rooms.get(build.id).build.approved, []);
    e.control(build.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("the build gets every changed path, and a note even when which files changed isn't known: snapshots that failed, or recovery after a restart", async () => {
  // Snapshots that fail (nothing taken) in the writer's room only.
  class Failing extends Snapshots {
    async take(project, label) {
      return /chat/.test(label) && failing ? null : super.take(project, label);
    }
  }
  let failing = false;
  const t = await setup([{ agent: "claude", match: "Your role: reviewer", reply: "Good.\nTORYO: APPROVED" }]);
  const { codex, calls } = slowCodex();
  t.engine.shutdown();
  let e = new Engine({ store: new Store(t.home), snapshots: new Failing(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex } });
  await e.init({ detect: false });
  try {
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { gates: false, autoContinue: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    e.control(build.id, "pause");
    calls[0].end();
    await waitFor(() => !sum(e, build.id).running.length, { label: "between turns" });
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat" });
    // Twenty-one files: every one reaches the build's agents.
    e.postMessage(chat.id, { text: "Write the files.", to: "codex", allowWrite: true, answering: false });
    await waitFor(() => calls.length === 2, { label: "the writer" });
    for (let i = 1; i <= 21; i++) writeFileSync(join(t.repo, `file-${i}.txt`), "x");
    calls[1].end("Written.\nTORYO: REPLY");
    await waitFor(() => e.roomView(build.id).events.some((x) => x.writesFrom), { label: "the note" });
    const many = e.roomView(build.id).events.find((x) => x.writesFrom);
    assert.equal(many.files.length, 21);
    assert.match(many.text, /and 1 more \(all of them below\)/);
    // Then snapshots fail: the note says which files isn't known.
    failing = true;
    e.postMessage(chat.id, { text: "One more.", to: "codex", allowWrite: true, answering: false });
    await waitFor(() => calls.length === 3, { label: "the second write" });
    calls[2].end("Done.\nTORYO: REPLY");
    await waitFor(() => e.roomView(build.id).events.filter((x) => x.writesFrom).length === 2, { label: "the second note" });
    const unknown = e.roomView(build.id).events.filter((x) => x.writesFrom)[1];
    assert.equal(unknown.text, "Between this build's turns, Codex may have changed files in this folder for “Chat” (which ones isn't known: Toryo couldn't list that turn's changes). Take them into account before going on.");
    assert.equal(turns(e, chat.id).at(-1).filesKnown, false);
    // The build's reviewer, next: the whole list, file 21 included.
    e.control(build.id, "resume");
    await waitFor(() => t.calls().some((c) => /Your role: reviewer/.test(c.prompt)), { label: "the review" });
    const prompt = t.calls().find((c) => /Your role: reviewer/.test(c.prompt)).prompt;
    assert.match(prompt, /- file-21\.txt/);
    assert.match(prompt, /may have changed files in this folder for “Chat”/);
    // Recovery: as if Toryo had stopped just as that write ended, before its note: the note comes once, at the start,
    // to the build still holding the folder (waiting for you, here).
    await waitFor(() => e.rooms.get(build.id).waiting && e.running.size === 0, { label: "the build waiting for you" });
    assert.equal(sum(e, build.id).folder.holding, true);
    const lastWrite = turns(e, chat.id).at(-1);
    e.shutdown();
    const path = join(t.home, "rooms", build.id, "events.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").split("\n").filter((l) => !l.includes(`"writesFrom":"${lastWrite.id}"`)).join("\n"));
    const saved = e.store.loadRoom(chat.id);
    saved.pendingOutcome = { turnId: lastWrite.id };
    e.store.saveRoom(saved);
    e = new Engine({ store: new Store(t.home), snapshots: new Failing(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex } });
    await e.init({ detect: false });
    assert.equal(e.roomView(build.id).events.filter((x) => x.writesFrom === lastWrite.id).length, 1);
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("a folder you're using is released by its folder or its project's id, also after the project is renamed", async () => {
  await withServer([], async ({ engine: e, client, base }) => {
    await client.desk("use-folder", { project: "repo" });
    e.updateProject("repo", { name: "Renamed" });
    const [f] = e.deskView().folders;
    assert.deepEqual(f.projects, ["repo"]);
    assert.match(await client.statusText(), /You're using .+: toryo folder release repo/);
    // Home's Release names the folder; the command line, the project's id.
    assert.match(await client.desk("release-folder", { project: f.root }), /^Released /);
    await client.desk("use-folder", { project: "Renamed" });
    assert.match(await client.desk("release-folder", { project: "repo" }), /^Released /);
    assert.deepEqual(e.deskView().folders, []);
    // A project in a folder inside a repository: the folder you're using is the repository's, which isn't any
    // project's path; Home's Release (by the folder) still works.
    const nested = join(base, "nested");
    execFileSync("git", ["init", "-q", nested]);
    mkdirSync(join(nested, "sub"));
    const sub = e.addProject({ path: join(nested, "sub"), name: "Sub" });
    await client.desk("use-folder", { project: sub.id });
    const [g] = e.deskView().folders;
    assert.equal(g.root, realpathSync(nested));
    assert.match(await client.desk("release-folder", { project: g.root }), /^Released /);
  });
});

test("a review's approval carried past your question is out of date if files changed meanwhile: nothing approved, no finding settled", async () => {
  const t = await setup([
    { agent: "claude", match: "Answering your question", reply: "Yes, it is.\nTORYO: REPLY" },
    { agent: "claude", match: "Your role: reviewer", reply: "Fix the index.\nTORYO: CHANGES", times: 1 },
    { agent: "claude", match: "Your role: reviewer", workMs: 800, reply: "Good now.\nTORYO: APPROVED" },
  ]);
  const { codex, calls } = slowCodex();
  const e = await engineWith(t, { codex });
  try {
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { gates: false, autoContinue: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    calls[0].end();
    await waitFor(() => (e.rooms.get(build.id).ledger ?? []).length === 1 && calls.length === 2, { label: "a finding, and the fix" });
    calls[1].end();
    await waitFor(() => sum(e, build.id).working.some((w) => w.kind === "review"), { label: "the second review" });
    // While Claude reviews: you ask it something, and a writable chat in another room waits for the review.
    e.postMessage(build.id, { text: "Is the index right now?", to: "claude", answering: false });
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat" });
    e.postMessage(chat.id, { text: "Tidy the README.", to: "codex", allowWrite: true, answering: false });
    // The review approves; the chat writes before Claude's answer; the answer carries the approval on.
    await waitFor(() => calls.length === 3, { label: "the chat, after the review" });
    writeFileSync(join(t.repo, "meanwhile.txt"), "x");
    calls[2].end("Tidied.\nTORYO: REPLY");
    await waitFor(() => e.rooms.get(build.id).waiting?.kind === "review-owner", { label: "your call" });
    assert.ok(turns(e, build.id).some((x) => x.kind === "note-answer" && x.state === "done"), "Claude answered first");
    assert.match(e.rooms.get(build.id).waiting.question, /^Files changed while Claude was reviewing \(meanwhile\.txt\)/);
    assert.deepEqual(e.rooms.get(build.id).build.approved, []);
    assert.equal(e.rooms.get(build.id).ledger[0].state, "open", "the finding isn't settled");
    e.control(build.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("a writer whose changes aren't known says so whatever became of its turn (failed too), and so does a comparison that failed", async () => {
  // Snapshots that fail for the chat room's turns (`mode`): none taken, or taken but not compared.
  let mode = null;
  class Unreliable extends Snapshots {
    async take(project, label) {
      return mode === "take" && /chat/.test(label) ? null : super.take(project, label);
    }
    async changes(project, from, to, opts) {
      return mode === "diff" && opts?.strict ? null : super.changes(project, from, to, opts);
    }
  }
  const t = await setup([]);
  const { codex, calls } = slowCodex();
  t.engine.shutdown();
  let e = new Engine({ store: new Store(t.home), snapshots: new Unreliable(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex } });
  await e.init({ detect: false });
  try {
    const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { gates: false } });
    await waitFor(() => calls.length === 1, { label: "the builder" });
    e.control(build.id, "pause");
    calls[0].end();
    await waitFor(() => !sum(e, build.id).running.length, { label: "between turns" });
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat" });
    const notes = () => e.roomView(build.id).events.filter((x) => x.writesFrom);
    // A writer that fails, its changes not known (no snapshots): the build is told anyway.
    mode = "take";
    e.postMessage(chat.id, { text: "Write it.", to: "codex", allowWrite: true, answering: false });
    await waitFor(() => calls.length === 2, { label: "the writer" });
    calls[1].end("", { error: "It crashed." });
    await waitFor(() => turns(e, chat.id).some((x) => x.state === "failed") && notes().length === 1, { label: "failed, and the note" });
    const failed = turns(e, chat.id).find((x) => x.state === "failed");
    assert.deepEqual([failed.filesKnown, failed.reached], [false, true]);
    assert.match(notes()[0].text, /^Between this build's turns, Codex may have changed files in this folder for “Chat” \(which ones isn't known/);
    // (The failed turn is tried again once by itself: its changes aren't known either.)
    await waitFor(() => calls.length === 3, { label: "the retry" });
    calls[2].end("Written.\nTORYO: REPLY");
    await waitFor(() => notes().length === 2, { label: "the retry's note" });
    // A comparison that fails, between two snapshots taken: not known either, not "nothing changed".
    mode = "diff";
    e.postMessage(chat.id, { text: "One more.", to: "codex", allowWrite: true, answering: false });
    await waitFor(() => calls.length === 4, { label: "another write" });
    calls[3].end("Written.\nTORYO: REPLY");
    await waitFor(() => notes().length === 3, { label: "its note" });
    const done = turns(e, chat.id).at(-1);
    assert.deepEqual([done.state, done.filesKnown, Boolean(done.snapBefore && done.snapAfter)], ["done", false, true]);
    // Recovery: the failed writer's note, as if Toryo had stopped before writing it, comes once at the next start.
    mode = null;
    e.shutdown();
    const path = join(t.home, "rooms", build.id, "events.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").split("\n").filter((l) => !l.includes(`"writesFrom":"${failed.id}"`)).join("\n"));
    const saved = e.store.loadRoom(chat.id);
    saved.pendingOutcome = { turnId: failed.id };
    e.store.saveRoom(saved);
    e = new Engine({ store: new Store(t.home), snapshots: new Unreliable(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codex } });
    await e.init({ detect: false });
    assert.equal(e.roomView(build.id).events.filter((x) => x.writesFrom === failed.id).length, 1);
    // (Acting on that failed turn again tries it again: stopped here.)
    for (const r of [chat, build]) e.control(r.id, "stop");
    for (const c of calls) c.end("");
    await waitFor(() => e.running.size === 0, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("outside Git, a folder you're using around another project is released by that folder, in either order of the projects", async () => {
  for (const order of [["parent", "child"], ["child", "parent"]]) {
    const t = await setup([]);
    try {
      const e = t.engine;
      const parent = join(t.base, "plain");
      mkdirSync(join(parent, "child"), { recursive: true });
      const ids = {};
      for (const which of order) ids[which] = e.addProject({ path: which === "parent" ? parent : join(parent, "child"), name: `Plain ${which}` }).id;
      // The parent in use: it keeps Toryo out of the child too; its release names the parent.
      e.deskControl("use-folder", { project: ids.parent });
      let [f] = e.deskView().folders;
      assert.deepEqual([f.root, f.projects, [...f.covers].sort()], [realpathSync(parent), [ids.parent], [ids.child, ids.parent].sort()], order.join());
      assert.throws(() => e.deskControl("release-folder", { project: ids.child }), /You aren't using .+child\. You're using .+plain, which overlaps it: release that \(toryo folder release .+plain\)\./);
      assert.match(e.deskControl("release-folder", { project: f.root }).message, /^Released /);
      // The child in use: its own release.
      e.deskControl("use-folder", { project: ids.child });
      [f] = e.deskView().folders;
      assert.deepEqual([f.projects, [...f.covers].sort()], [[ids.child], [ids.child, ids.parent].sort()]);
      assert.match(e.deskControl("release-folder", { project: ids.child }).message, /^Released /);
      assert.deepEqual(e.deskView().folders, []);
    } finally {
      t.engine.shutdown();
      t.cleanup();
    }
  }
});

test("a review's verdict given later approves nothing when comparing with the review's start fails: status-only, and after your question", async () => {
  // status: nothing seen, the comparison failed. seen: the status turn itself saw a file change, the comparison failed.
  for (const later of ["status", "seen", "question"]) {
    // Comparisons from one snapshot (the review's start) fail; everything else works.
    class Broken extends Snapshots {
      failFrom = null;
      async changes(project, from, to, opts) {
        return opts?.strict && from === this.failFrom ? null : super.changes(project, from, to, opts);
      }
    }
    const t = await setup([
      { agent: "claude", match: "no TORYO status line", workMs: later === "seen" ? 800 : 0, reply: "TORYO: APPROVED" },
      { agent: "claude", match: "Answering your question", reply: "Yes.\nTORYO: REPLY" },
      { agent: "claude", match: "Your role: reviewer", reply: "Fix the index.\nTORYO: CHANGES", times: 1 },
      { agent: "claude", match: "Your role: reviewer", workMs: 800, reply: later === "question" ? "Good now.\nTORYO: APPROVED" : "Looks fine overall." },
    ]);
    const { codex, calls } = slowCodex();
    const snaps = new Broken(t.home);
    t.engine.shutdown();
    const e = new Engine({ store: new Store(t.home), snapshots: snaps, notifier: { send() {} }, adapters: { ...ADAPTERS, codex } });
    await e.init({ detect: false });
    try {
      const build = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build", title: "Build", settings: { gates: false, autoContinue: false } });
      await waitFor(() => calls.length === 1, { label: "the builder" });
      calls[0].end();
      await waitFor(() => (e.rooms.get(build.id).ledger ?? []).length === 1 && calls.length === 2, { label: "a finding, and the fix" });
      calls[1].end();
      await waitFor(() => turns(e, build.id).filter((x) => x.kind === "review").length === 2 && turns(e, build.id).at(-1).snapBefore, { label: "the second review, started" });
      snaps.failFrom = turns(e, build.id).at(-1).snapBefore;
      if (later === "question") e.postMessage(build.id, { text: "Is the index right now?", to: "claude", answering: false });
      if (later === "seen") {
        await waitFor(() => turns(e, build.id).some((x) => x.kind === "review-status" && x.state === "running" && x.snapBefore), { label: "the status turn" });
        writeFileSync(join(t.repo, "changed.txt"), "x");
      }
      await waitFor(() => e.rooms.get(build.id).waiting?.kind === "review-owner", { label: `${later}: your call` });
      const carrier = turns(e, build.id).find((x) => x.kind === (later === "question" ? "note-answer" : "review-status"));
      if (later === "seen") {
        // What it saw change itself is kept, though the comparison from the review's start failed.
        assert.deepEqual([carrier.state, carrier.outOfDate], ["done", ["changed.txt"]]);
        assert.match(e.rooms.get(build.id).waiting.question, /^Files changed while Claude was reviewing \(changed\.txt\)/);
      } else {
        assert.deepEqual([carrier.state, carrier.staleUnknown], ["done", true], later);
        assert.match(e.rooms.get(build.id).waiting.question, /^Toryo couldn't tell whether files changed since Claude's review began \(comparing its snapshots failed\)/);
      }
      assert.deepEqual(e.rooms.get(build.id).build.approved, [], later);
      assert.equal(e.rooms.get(build.id).ledger[0].state, "open", `${later}: the finding isn't settled`);
      e.control(build.id, "stop");
      await waitFor(() => e.running.size === 0, { label: "stopped" });
    } finally {
      e.shutdown();
      t.cleanup();
    }
  }
});
