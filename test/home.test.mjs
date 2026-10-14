import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { setup, turns, waitFor, withServer } from "./helpers.mjs";

const idle = (e, id) => !e.summary(e.rooms.get(id)).running.length && !e.rooms.get(id).queue.length;

test("Home shows the work running in several rooms: who, where, what, since when, and its latest output", async () => {
  const t = await setup([
    { agent: "codex", match: "Build the export", progress: "npm test", workMs: 60_000, reply: "Built.\nTORYO: REVIEW Slice 1: Export" },
    { agent: "claude", match: "Plan the import", progress: "ls docs", workMs: 60_000, reply: "Proposal.\nTORYO: PROPOSAL" },
  ]);
  try {
    const e = t.engine;
    // The build in a folder of its own (a reply doesn't run beside a builder in its folder), with a quiet room there.
    const other = t.project("other");
    const build = e.createRoom({ projectId: other, mode: "build", task: "Build the export", title: "Export" });
    const quiet = e.createRoom({ projectId: other, mode: "chat", members: ["claude"], title: "Quiet" });
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], title: "Import", text: "Plan the import.", to: "claude" });
    await waitFor(() => e.home().working.length === 2 && e.home().working.every((w) => w.workingAt && w.activity), { label: "both working, with output" });
    const home = e.home();
    const byRoom = Object.fromEntries(home.working.map((w) => [w.room, w]));
    assert.deepEqual(
      [byRoom[build.id].agent, byRoom[build.id].role, byRoom[build.id].kind, byRoom[build.id].task, byRoom[build.id].phase],
      ["codex", "builder", "build", "Build the export", "working"],
    );
    assert.equal(byRoom[chat.id].agent, "claude");
    assert.equal(byRoom[build.id].project, "other");
    assert.ok(byRoom[build.id].folder.endsWith("other"));
    // Another room in the same folder: it says so.
    assert.deepEqual(byRoom[build.id].shared.map((x) => x.id), [quiet.id]);
    assert.deepEqual(byRoom[chat.id].shared, []);
    // Its times, kept apart: started (preparing), started working, last said something.
    for (const w of home.working) {
      assert.ok(Date.parse(w.startedAt) <= Date.parse(w.workingAt));
      assert.ok(Date.parse(w.lastOutputAt) >= Date.parse(w.workingAt));
      assert.ok(w.activity.length > 0);
    }
    assert.deepEqual(home.rooms.map((r) => r.id), [quiet.id], "every other room is working");
    assert.deepEqual(home.agents.find((a) => a.agent === "codex").working.map((w) => w.room), [build.id]);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("Home's questions come from every room, oldest first; other rooms say what keeps them; each Codex interface has its own row", async () => {
  const t = await setup([{ agent: "codex", reply: "Which one?\nTORYO: OWNER SQLite or Postgres?" }]);
  try {
    const e = t.engine;
    const first = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "First", text: "Ask me.", to: "codex" });
    await waitFor(() => idle(e, first.id) && e.home().questions.length === 1, { label: "first question" });
    const second = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Second", text: "Ask me too.", to: "codex" });
    await waitFor(() => idle(e, second.id) && e.home().questions.length === 2, { label: "second question" });
    const { questions, questionCount } = e.home();
    assert.equal(questionCount, 2);
    assert.deepEqual(questions.map((q) => q.roomTitle), ["First", "Second"], "oldest first");
    assert.equal(questions[0].question, "SQLite or Postgres?");
    assert.equal(questions[0].from, "codex");
    assert.ok(questions[0].id && questions[0].at);
    // A paused room, and one held by the desk.
    e.control(first.id, "pause");
    e.deskControl("hold", { target: "codex" });
    e.postMessage(second.id, { text: "And another.", to: "codex", answering: false });
    const rooms = Object.fromEntries(e.home().rooms.map((r) => [r.title, r]));
    assert.equal(rooms.First.paused, true);
    assert.equal(rooms.Second.held, true);
    assert.deepEqual(rooms.Second.blocked[0].reasons, ["you hold Codex (headless and the Codex app)"]);
    const agents = Object.fromEntries(e.home().agents.map((a) => [a.agent, a]));
    assert.deepEqual(agents.codex.blockers, ["you hold Codex (headless and the Codex app)"]);
    assert.equal(agents.codex.group, "openai");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("Recent merges the rooms' events with the desk's journal, newest first by when each finished, each once, page by page", async () => {
  const t = await setup([
    { agent: "codex", match: "Slow one", workMs: 900, reply: "Slow done.\nTORYO: REPLY" },
    { agent: "claude", match: "Quick one", reply: "Quick done.\nTORYO: OWNER Keep going?" },
  ]);
  try {
    const e = t.engine;
    // The slow turn starts first and ends last: Recent orders by the end.
    const slow = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Slow", text: "Slow one.", to: "codex" });
    await waitFor(() => e.summary(e.rooms.get(slow.id)).running.length, { label: "slow running" });
    const quick = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], title: "Quick", text: "Quick one.", to: "claude" });
    await waitFor(() => idle(e, slow.id) && idle(e, quick.id), { label: "both done" });
    e.deskControl("hold", { target: "claude" });
    const { items } = e.feed({ limit: 40 });
    assert.deepEqual(
      items.map((i) => [i.kind, i.roomTitle ?? null, i.agent ?? i.what ?? null]),
      // Claude's turn ended with a question: Recent says it once, as the question.
      [
        ["desk", null, "desk-hold"],
        ["turn", "Slow", "codex"],
        ["question", "Quick", null],
      ],
    );
    assert.equal(items[0].text, "You held Claude");
    // A turn patched from running to done is one item; the question asked during it is another.
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
    assert.equal(items.filter((i) => i.event === turns(e, slow.id)[0].id).length, 1);
    assert.ok(!items.some((i) => i.event === turns(e, quick.id)[0].id), "the turn that asked isn't said twice");
    // Your answer appears too, once, and the question stays one item.
    // (Claude is held, so its reply waits; your answer is in Recent at once.)
    e.answer(quick.id, { questionId: e.home().questions[0].id, text: "Yes." });
    const after = e.feed({ limit: 40 }).items;
    assert.equal(after.filter((i) => i.kind === "answer").length, 1);
    assert.equal(after.find((i) => i.kind === "answer").answered, "Keep going?");
    assert.equal(after.filter((i) => i.kind === "question").length, 1);
    // Page by page: no item twice, none missed, and a page already seen stays put when new items arrive.
    const one = e.feed({ limit: 2 });
    e.deskControl("release", { target: "claude" });
    const two = e.feed({ limit: 2, before: one.next });
    const rest = two.next ? e.feed({ limit: 40, before: two.next }) : { items: [], next: null };
    const all = [...one.items, ...two.items, ...rest.items].map((i) => i.id);
    assert.deepEqual(all, after.map((i) => i.id));
    assert.equal(rest.next, null);
    assert.equal(e.feed({ limit: 40 }).items[0].text, "You released Claude");
    await waitFor(() => idle(e, quick.id), { label: "Claude's reply, once released" });
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("Recent keeps failed checks, approvals and failed turns, and leaves out running turns and your plain notes", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md" },
      { agent: "codex", match: "checks failed|Fix", reply: "Fixed.\nTORYO: REVIEW Slice 1: One | h.md" },
      { agent: "claude", match: "Your role: reviewer|review", reply: "Good.\nTORYO: APPROVED" },
    ],
    { gates: [{ name: "Unit tests", command: "exit 1", timeoutMin: 1 }] },
  );
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "build", task: "One slice", title: "Checked" });
    await waitFor(() => e.feed({ limit: 40 }).items.some((i) => i.kind === "checks"), { label: "the checks failing" });
    const checks = e.feed({ limit: 40 }).items.find((i) => i.kind === "checks");
    assert.deepEqual(checks.failed, ["Unit tests"]);
    e.postMessage(room.id, { text: "Just a note.", to: "codex", answering: false });
    assert.ok(!e.feed({ limit: 40 }).items.some((i) => i.kind === "answer"), "a plain note isn't in Recent");
    assert.ok(e.feed({ limit: 40 }).items.every((i) => i.kind !== "turn" || i.state !== "running"));
    e.control(room.id, "stop");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("over HTTP: Home and Recent as the page fetches them, after a reconnect too", async () => {
  await withServer([{ agent: "codex", reply: "Which one?\nTORYO: OWNER SQLite or Postgres?" }], async (t) => {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "<img src=x onerror=alert(1)>", text: "Ask me.", to: "codex" });
    await waitFor(() => idle(e, room.id) && e.home().questions.length === 1, { label: "a question" });
    const { port } = JSON.parse((await import("node:fs")).readFileSync(`${t.home}/server.json`, "utf8"));
    const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-toryo": "1" } })).json();
    const home = await get("/api/home");
    assert.equal(home.questions[0].roomTitle, "<img src=x onerror=alert(1)>", "the title as it is: the page escapes it");
    assert.deepEqual(Object.keys(home).sort(), ["agents", "at", "desk", "openIds", "questionCount", "questions", "recent", "rooms", "usage", "working"]);
    assert.deepEqual(home.openIds, home.questions.map((q) => q.id));
    assert.ok(home.desk.guard, "the desk's controls and the guard");
    e.deskControl("hold", { target: "claude" });
    const page = await get("/api/feed?limit=1");
    assert.equal(page.items.length, 1);
    assert.ok(page.next, "there's more");
    const next = await get(`/api/feed?limit=40&before=${encodeURIComponent(page.next)}`);
    assert.ok(!next.items.some((i) => i.id === page.items[0].id));
  });
});

test("a working card names the slice and round as the room does: the second review round of Slice 1, then Slice 2 once Slice 1 is approved", async () => {
  const t = await setup([
    { agent: "codex", match: "continue straight into the next unfinished slice", workMs: 60_000, reply: "Next.\nTORYO: REVIEW Slice 2: Two | h.md" },
    { agent: "codex", match: "reviewed your last round", reply: "Fixed.\nTORYO: REVIEW Slice 1: One | h.md" },
    { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md" },
    { agent: "claude", match: "round 2 on this slice", workMs: 1500, reply: "Good now.\nTORYO: APPROVED" },
    { agent: "claude", match: "Your role: reviewer", reply: "One finding.\nTORYO: CHANGES" },
  ]);
  try {
    mkdirSync(join(t.repo, "docs", "plans"), { recursive: true });
    writeFileSync(join(t.repo, "docs", "plans", "p.md"), "# P\n\n### Slice 1: One\n\n### Slice 2: Two\n");
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "build", task: "The plan", planPath: "docs/plans/p.md", members: ["codex", "claude"], builder: "codex", reviewer: "claude" });
    const card = () => e.home().working.find((w) => w.room === room.id);
    await waitFor(() => card()?.agent === "claude" && card().round === 2, { label: "the second review" });
    assert.deepEqual([card().role, card().slice, card().round], ["reviewer", "Slice 1: One", 2]);
    // Slice 1 approved: the builder is on the next slice, round 1 (not Slice 1, which is done).
    await waitFor(() => card()?.agent === "codex" && card().kind === "build-next", { label: "the next slice" });
    assert.deepEqual([card().slice, card().round], ["Slice 2: Two", 1]);
    e.control(room.id, "stop");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a Codex app turn followed again after a restart keeps its times: handed over, taken up, from before the restart", async () => {
  const t = await setup([]);
  try {
    let pickup = false;
    let follow = null;
    const app = {
      ...ADAPTERS.codexapp,
      detect: async () => ({ installed: true }),
      currentLimits: () => null,
      run: ({ attach, onSubmitted, onStarted, signal, abandon }) =>
        new Promise((resolve) => {
          if (!attach) onSubmitted?.();
          // The app takes it up when told to (first run, or while it's followed again).
          if (pickup) onStarted?.({ sessionId: "0aaaaaaa-0000-0000-0000-00000000000a" });
          follow = { onStarted };
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
    const card = (e) => e.home().working.find((w) => w.agent === "codexapp");
    const restart = async (e) => {
      e.shutdown();
      await waitFor(() => e.running.size === 0, { label: "stopped" });
      await new Promise((r) => setTimeout(r, 30));
      follow = null;
      const next = await make();
      await waitFor(() => follow && card(next), { label: "followed again" });
      return next;
    };
    // Handed to the app, still in its queue: after a restart, it's still waiting, since it was handed over.
    let e = await make();
    const room = e.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "A", appThread: "0aaaaaaa-0000-0000-0000-00000000000a" });
    await waitFor(() => card(e)?.submittedAt, { label: "handed over" });
    const handed = card(e).submittedAt;
    e = await restart(e);
    assert.deepEqual([card(e).phase, card(e).submittedAt, card(e).workingAt], ["in-app", handed, null]);
    // The app takes it up while it's followed; after another restart, it's been working since then, not since the restart.
    follow.onStarted({ sessionId: "0aaaaaaa-0000-0000-0000-00000000000a" });
    const taken = card(e).workingAt;
    assert.ok(taken);
    await new Promise((r) => setTimeout(r, 50));
    e = await restart(e);
    assert.deepEqual([card(e).phase, card(e).submittedAt, card(e).workingAt], ["working", handed, taken]);
    e.control(room.id, "stop");
    e.control(room.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "let go" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("a Codex app turn the app took up while Toryo was stopped: working since then, as the app's log says, also after another restart", async () => {
  const t = await setup([]);
  try {
    let pickedUpAt = null;
    let followed = 0;
    const app = {
      ...ADAPTERS.codexapp,
      detect: async () => ({ installed: true }),
      currentLimits: () => null,
      run: ({ attach, onSubmitted, onStarted, signal, abandon }) =>
        new Promise((resolve) => {
          if (!attach) onSubmitted?.();
          // Followed again: the app's log shows it took the turn up at `pickedUpAt`, while Toryo was stopped.
          if (attach && pickedUpAt) onStarted?.({ sessionId: "0aaaaaaa-0000-0000-0000-00000000000a", at: pickedUpAt });
          if (attach) followed++;
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
    const card = (e) => e.home().working.find((w) => w.agent === "codexapp");
    const restart = async (e) => {
      e.shutdown();
      await waitFor(() => e.running.size === 0, { label: "stopped" });
      await new Promise((r) => setTimeout(r, 30));
      const before = followed;
      const next = await make();
      await waitFor(() => followed > before && card(next), { label: "followed again" });
      return next;
    };
    let e = await make();
    const room = e.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "A", appThread: "0aaaaaaa-0000-0000-0000-00000000000a" });
    await waitFor(() => card(e)?.submittedAt, { label: "handed over" });
    const handed = card(e).submittedAt;
    // While Toryo is stopped, the app takes it up.
    e.shutdown();
    await waitFor(() => e.running.size === 0, { label: "stopped" });
    await new Promise((r) => setTimeout(r, 40));
    pickedUpAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 40));
    e = await make();
    await waitFor(() => followed === 1 && card(e)?.workingAt, { label: "followed again" });
    assert.deepEqual([card(e).phase, card(e).submittedAt, card(e).workingAt], ["working", handed, pickedUpAt]);
    // Kept on the first turn: after another restart (the stand-in's log no longer says), still working since then.
    const took = pickedUpAt;
    pickedUpAt = null;
    e = await restart(e);
    assert.deepEqual([card(e).phase, card(e).submittedAt, card(e).workingAt], ["working", handed, took]);
    assert.equal(e.roomView(room.id).events.find((x) => x.type === "turn" && x.agent === "codexapp").pickedUpAt, took, "on the first turn");
    e.control(room.id, "stop");
    e.control(room.id, "stop");
    await waitFor(() => e.running.size === 0, { label: "let go" });
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("Home's cards for planning: a checkpoint names the author its form would choose and whether every question has a recommendation; a ready plan names who can check it", async () => {
  const t = await setup([
    { agent: "codex", match: "step 1 of 4", reply: "Codex proposal.\n- Q: Use SQLite? (Recommended: yes)\nTORYO: PROPOSAL" },
    { agent: "claude", match: "step 1 of 4", reply: "Claude proposal.\n- Q: Ship a CLI too?\nTORYO: PROPOSAL" },
    { match: "step 2 of 4", reply: "Critique.\nTORYO: CRITIQUE" },
    { agent: "codex", match: "step 3 of 4", write: { path: "docs/plans/p.md", content: "# P\n\n### Slice 1: One\n" }, reply: "Written.\nTORYO: REVIEW docs/plans/p.md" },
    { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
  ]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "plan", topic: "P", planPath: "docs/plans/p.md", members: ["codex", "claude"] });
    await waitFor(() => e.home().questions.some((q) => q.kind === "plan-checkpoint"), { label: "the checkpoint" });
    const cp = e.home().questions.find((q) => q.kind === "plan-checkpoint");
    // Claude's question has no recommendation: Home sends you to the form rather than accept for you.
    assert.deepEqual([cp.author, cp.complete, cp.questions.length], ["codex", false, 2]);
    e.synthesize(room.id, { questionId: cp.id, decisions: "- Ship a CLI too? → no" });
    await waitFor(() => e.home().questions.some((q) => q.kind === "plan-ready"), { label: "the plan ready" });
    const ready = e.home().questions.find((q) => q.kind === "plan-ready");
    assert.deepEqual([ready.author, ready.checkers, ready.planPath], ["codex", ["claude"], "docs/plans/p.md"]);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});
