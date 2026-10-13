import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS } from "../src/agents/index.mjs";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { setup, turns, waitFor } from "./helpers.mjs";

const summary = (engine, id) => engine.summary(engine.rooms.get(id));
const kinds = (engine, id) => turns(engine, id).map((x) => `${x.agent}:${x.kind}:${x.status}`);

test("a question sent to the builder mid-turn is answered in its next building turn, then the relay carries on to review", async () => {
  const t = await setup([
    { agent: "codex", match: "Building: your notes", reply: "N1: answered — tabs it is.\nNothing else changes.\nTORYO: REPLY" },
    { agent: "codex", match: "Your role: builder", delayMs: 500, reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", match: "Your role: reviewer", reply: "Looks fine.\nTORYO: OWNER Ship it?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => summary(t.engine, room.id).running.includes("codex"), { label: "builder working" });
    const { event: note } = t.engine.postMessage(room.id, { text: "Tabs or spaces? Use tabs.", to: "codex" });
    assert.equal(note.intent, "ask");
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "review done" });
    assert.deepEqual(kinds(t.engine, room.id), ["codex:build:REVIEW", "codex:build-notes:REPLY", "claude:review:OWNER"]);
    const calls = t.calls();
    assert.match(calls[1].prompt, /## Building: your notes/);
    assert.match(calls[1].prompt, /The owner \(to you\) · note N1, ask\nTabs or spaces\? Use tabs\./);
    assert.match(calls[1].prompt, /N1 \(ask\): “Tabs or spaces\? Use tabs\.”/);
    assert.match(calls[1].prompt, /answer it right after its line/);
    assert.doesNotMatch(calls[1].prompt, /To you:/);
    // The reviewer gets the round and the builder's answer.
    assert.match(calls[2].prompt, /Built\./);
    assert.match(calls[2].prompt, /tabs it is/);
    // The note shows what became of it, and where.
    const notesTurn = turns(t.engine, room.id)[1];
    const shown = t.engine.roomView(room.id).events.find((e) => e.id === note.id);
    assert.equal(shown.readBy.codex, notesTurn.id);
    assert.deepEqual(shown.outcomes.codex, { status: "answered", detail: "tabs it is.", turnId: notesTurn.id });
  } finally {
    t.cleanup();
  }
});

test("an instruction sent mid-turn is built in before review, with no reply turn; a question to the reviewer gets a short answer and its verdict stands", async () => {
  const t = await setup([
    { agent: "codex", match: "Building: your notes", write: { path: "note.txt", content: "done" }, reply: "N1: done — added note.txt\nAdded it.\nTORYO: REVIEW S1 with the note | h.md" },
    { agent: "codex", match: "Your role: builder", delayMs: 500, reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    // The answer's own status is ignored: answering a question doesn't change the verdict.
    { agent: "claude", match: "Answering your question", reply: "Because the cache key misses the user id.\nTORYO: APPROVED" },
    { agent: "claude", match: "Your role: reviewer", delayMs: 500, reply: "One finding: the cache.\nTORYO: CHANGES" },
    { agent: "codex", match: "reviewed your last round", reply: "Fixed.\nTORYO: OWNER Anything else?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => summary(t.engine, room.id).running.includes("codex"), { label: "builder working" });
    const { event: tell } = t.engine.postMessage(room.id, { text: "Please also add note.txt.", to: "codex" });
    assert.equal(tell.intent, "tell");
    await waitFor(() => summary(t.engine, room.id).running.includes("claude"), { label: "reviewer working" });
    const { event: ask } = t.engine.postMessage(room.id, { text: "Why is the cache finding blocking?", to: "claude" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "builder's question" });
    assert.deepEqual(kinds(t.engine, room.id), ["codex:build:REVIEW", "codex:build-notes:REVIEW", "claude:review:CHANGES", "claude:note-answer:APPROVED", "codex:build-fix:OWNER"]);
    assert.equal(t.engine.rooms.get(room.id).build.slice, "S1 with the note");
    const answer = t.calls().find((c) => c.kind === "claude" && /Answering your question/.test(c.prompt));
    assert.ok(answer.args.includes("--disallowedTools"), "the answer is a read-only turn");
    const events = t.engine.roomView(room.id).events;
    assert.equal(events.find((e) => e.id === tell.id).outcomes.codex.status, "done");
    assert.equal(events.find((e) => e.id === tell.id).outcomes.codex.detail, "added note.txt");
    assert.equal(events.find((e) => e.id === ask.id).outcomes.claude.status, "answered");
  } finally {
    t.cleanup();
  }
});

test("an instruction to the reviewer mid-review adds no turn: it goes with the reviewer's next turn", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", match: "round 2 on this slice", reply: "Docs checked too. Fine.\nTORYO: OWNER Ship it?" },
    { agent: "claude", match: "Your role: reviewer", delayMs: 500, reply: "One finding.\nTORYO: CHANGES" },
    { agent: "codex", match: "reviewed your last round", reply: "Fixed.\nTORYO: REVIEW S1 | h.md" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => summary(t.engine, room.id).running.includes("claude"), { label: "reviewer working" });
    t.engine.postMessage(room.id, { text: "Also check the docs.", to: "claude" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "second review done" });
    assert.deepEqual(kinds(t.engine, room.id), ["codex:build:REVIEW", "claude:review:CHANGES", "codex:build-fix:REVIEW", "claude:review:OWNER"]);
    const second = t.calls().filter((c) => c.kind === "claude")[1];
    assert.match(second.prompt, /note N1, tell\nAlso check the docs\./);
  } finally {
    t.cleanup();
  }
});

test("a question to an agent that isn't building is answered at once, beside the work; you can mark a note Ask or Tell yourself", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", delayMs: 800, reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", match: "Answering your question", reply: "It looks sound so far.\nTORYO: REPLY" },
    { agent: "claude", match: "Your role: reviewer", reply: "Fine.\nTORYO: OWNER Ship it?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => summary(t.engine, room.id).running.includes("codex"), { label: "builder working" });
    const { event: ask } = t.engine.postMessage(room.id, { text: "What do you think of the plan so far", to: "claude" });
    assert.equal(ask.intent, "ask");
    await waitFor(() => turns(t.engine, room.id).some((x) => x.kind === "note-answer" && x.state === "done"), { label: "answered" });
    assert.ok(summary(t.engine, room.id).running.includes("codex"), "the builder kept building meanwhile");
    // Marked Tell despite the question mark: no answer turn, it rides along.
    const { event: tell } = t.engine.postMessage(room.id, { text: "Is the README next? Just note it.", to: "claude", intent: "tell" });
    assert.equal(tell.intent, "tell");
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "review done" });
    assert.deepEqual(kinds(t.engine, room.id), ["codex:build:REVIEW", "claude:note-answer:REPLY", "claude:review:OWNER"]);
    assert.equal(t.engine.roomView(room.id).events.find((e) => e.id === ask.id).outcomes.claude.status, "answered");
  } finally {
    t.cleanup();
  }
});

test("a question asked in chat makes the room wait for you, even while another agent works", async () => {
  const t = await setup([
    { agent: "codex", reply: "Which database?\nTORYO: OWNER SQLite or Postgres?" },
    { agent: "claude", delayMs: 600, reply: "Thinking it over.\nTORYO: REPLY" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", text: "Plan the storage.", to: "everyone" });
    await waitFor(() => summary(t.engine, room.id).waitingCount === 1, { label: "Codex asked" });
    let s = summary(t.engine, room.id);
    assert.equal(s.status, "waiting");
    assert.deepEqual(s.working.map((w) => w.agent), ["claude"]);
    assert.equal(s.waiting.from, "codex");
    await waitFor(() => !summary(t.engine, room.id).working.length, { label: "Claude done" });
    s = summary(t.engine, room.id);
    assert.equal(s.status, "waiting", "an unanswered chat question keeps the room waiting");
    // A plain reply goes to the agent that asked, and answers it.
    const sent = t.engine.postMessage(room.id, { text: "SQLite." });
    assert.deepEqual(sent.routed.agents, ["codex"]);
    assert.equal(summary(t.engine, room.id).waitingCount, 0);
    await waitFor(() => !t.engine.running.size && !t.engine.rooms.get(room.id).queue.length, { label: "reply done" });
  } finally {
    t.cleanup();
  }
});

/** An engine whose Codex app is `app`, sharing the test's data folder. */
async function appEngine(t, app, { snapshots } = {}) {
  const engine = new Engine({ store: new Store(t.home), snapshots: snapshots ?? new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: { ...ADAPTERS.codexapp, detect: async () => ({ installed: true }), currentLimits: () => null, ...app } } });
  await engine.init({ detect: false });
  return engine;
}

test("the Codex app gets the house rules in a new room, and again with the room's history in a new thread", async () => {
  const t = await setup([]);
  try {
    const prompts = [];
    // In a build the app asks you something, so the room waits (and the app is idle) between turns.
    const engine = await appEngine(t, { run: async ({ prompt }) => (prompts.push(prompt), { text: `Reply ${prompts.length}.\n${/Your role: builder|The owner answered/.test(prompt) ? "TORYO: OWNER Which way?" : "TORYO: REPLY"}` }) });
    engine.updateProject("repo", { rules: "HOUSE-RULE-XYZ: never commit." });
    const room = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], text: "First question.", to: "codexapp", appThread: "thread-1" });
    await waitFor(() => prompts.length === 1, { label: "first turn" });
    assert.match(prompts[0], /HOUSE-RULE-XYZ/);
    assert.match(prompts[0], /Decisions: when the owner decides something/);
    await waitFor(() => !engine.running.size, { label: "first turn over" });
    engine.postMessage(room.id, { text: "Second question.", to: "codexapp" });
    await waitFor(() => prompts.length === 2, { label: "second turn" });
    assert.doesNotMatch(prompts[1], /HOUSE-RULE-XYZ/, "the same thread has it already");
    await waitFor(() => !engine.running.size, { label: "second turn over" });
    engine.control(room.id, "app-thread", { thread: "thread-2" });
    engine.postMessage(room.id, { text: "Third question.", to: "codexapp" });
    await waitFor(() => prompts.length === 3, { label: "turn in the new thread" });
    assert.match(prompts[2], /HOUSE-RULE-XYZ/);
    assert.match(prompts[2], /First question\./);
    assert.match(prompts[2], /### You \(Codex app\), earlier in this room\nReply 1\./);

    // A builder moving to a new thread gets its briefing again.
    const build = engine.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "Build the thing", appThread: "thread-3" });
    await waitFor(() => engine.rooms.get(build.id).waiting, { label: "kickoff asked" });
    engine.control(build.id, "app-thread", { thread: "thread-4" });
    engine.answer(build.id, { text: "This way." });
    await waitFor(() => prompts.length === 5, { label: "turn in the new thread" });
    assert.match(prompts[4], /## Your role: builder[\s\S]*Task: Build the thing/);
    await waitFor(() => !engine.running.size, { label: "all turns over" });
  } finally {
    t.cleanup();
  }
});

test("when following the app's turn fails, the turn stays kept: nothing else goes into that thread until it ends or you let go", async () => {
  const t = await setup([]);
  try {
    const calls = [];
    let finish = null;
    const app = {
      run: ({ attach, onSubmitted, sessionId, abandon }) => {
        calls.push(`${attach ? "follow" : "send"}:${sessionId}`);
        if (calls.length === 1) {
          onSubmitted?.();
          return Promise.reject(new Error("log unreadable"));
        }
        return new Promise((resolve) => {
          if (!attach) onSubmitted?.();
          finish = (text) => resolve({ text, sessionId });
          abandon.addEventListener("abort", () => resolve({ text: "", aborted: true }));
        });
      },
    };
    let engine = await appEngine(t, app);
    const b = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "shared" });
    const a = engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], text: "Do A.", to: "codexapp", appThread: "shared" });
    await waitFor(() => engine.rooms.get(a.id).waiting?.kind === "app-lost", { label: "lost track" });
    assert.ok(engine.rooms.get(a.id).appTurn);
    // No other room can take the thread now, and one that shares it waits.
    assert.throws(() => engine.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: "shared" }), /working in that thread/);
    engine.postMessage(b.id, { text: "Do B.", to: "codexapp" });
    // A new run in room A neither sends nor drops the question.
    engine.startPlan(a.id, { topic: "Something else" });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(calls, ["send:shared"]);
    assert.equal(engine.rooms.get(a.id).waiting?.kind, "app-lost");

    // Still kept after a restart.
    engine.shutdown();
    engine = await appEngine(t, app);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(calls, ["send:shared"]);
    assert.ok(engine.rooms.get(a.id).appTurn?.lost);

    // Following it again (never sending again), even in a stopped room; when it ends, room B goes.
    engine.control(a.id, "stop");
    assert.equal(engine.rooms.get(a.id).waiting?.kind, "app-lost", "a first stop keeps the question");
    engine.answer(a.id, { accept: true, questionId: engine.rooms.get(a.id).waiting.eventId });
    await waitFor(() => calls.length === 2, { label: "followed again" });
    assert.equal(calls[1], "follow:shared");
    finish("A done.\nTORYO: REPLY");
    await waitFor(() => calls.length === 3, { label: "B sent" });
    assert.equal(calls[2], "send:shared");
    assert.equal(engine.rooms.get(a.id).appTurn, null);
    engine.control(b.id, "app-release");
    await waitFor(() => !engine.running.size, { label: "let go" });
  } finally {
    t.cleanup();
  }
});

test("a first Stop while Toryo reconnects to the app's turn keeps following it", async () => {
  const t = await setup([]);
  try {
    const calls = [];
    let finish = null;
    const app = {
      run: ({ attach, onSubmitted, signal, abandon }) =>
        new Promise((resolve) => {
          calls.push(attach ? "follow" : "send");
          if (!attach) onSubmitted?.();
          finish = (text) => resolve({ text });
          signal.addEventListener("abort", () => signal.reason === "shutdown" && resolve({ text: "", aborted: true }));
          abandon.addEventListener("abort", () => resolve({ text: "", aborted: true }));
        }),
    };
    const first = await appEngine(t, app);
    const room = first.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "x", appThread: "t1" });
    await waitFor(() => finish, { label: "sent" });
    first.shutdown();
    await waitFor(() => !first.running.size, { label: "first desk stopped" });

    // The reconnect's snapshot is slow; Stop arrives while it's being taken.
    finish = null;
    const snapshots = new Snapshots(t.home);
    const take = snapshots.take.bind(snapshots);
    snapshots.take = async (...a) => (await new Promise((r) => setTimeout(r, 400)), take(...a));
    const second = await appEngine(t, app, { snapshots });
    await waitFor(() => second.running.size === 1, { label: "reconnecting" });
    second.control(room.id, "stop");
    await waitFor(() => finish, { label: "followed despite the stop" });
    assert.deepEqual(calls, ["send", "follow"]);
    second.control(room.id, "resume");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(calls, ["send", "follow"], "resuming doesn't send another message while the app's turn runs");
    second.control(room.id, "stop");
    second.control(room.id, "stop");
    await waitFor(() => !second.running.size, { label: "let go" });
  } finally {
    t.cleanup();
  }
});

test("a note written while the app builds is built in after a restart too, before the review", async () => {
  const t = await setup([{ agent: "claude", match: "Your role: reviewer", reply: "Fine.\nTORYO: OWNER Ship it?" }]);
  try {
    const calls = [];
    let finish = null;
    const app = {
      run: ({ attach, onSubmitted, signal, abandon, prompt }) =>
        new Promise((resolve) => {
          calls.push({ how: attach ? "follow" : "send", prompt });
          if (!attach) onSubmitted?.();
          // The answer to the note comes at once; the build itself waits to be finished.
          if (/Building: your notes/.test(prompt)) return resolve({ text: "N1: done — kept the old API.\nTORYO: REPLY" });
          finish = (text) => resolve({ text });
          signal.addEventListener("abort", () => signal.reason === "shutdown" && resolve({ text: "", aborted: true }));
          abandon.addEventListener("abort", () => resolve({ text: "", aborted: true }));
        }),
    };
    const first = await appEngine(t, app);
    const room = first.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "x", appThread: "t1" });
    await waitFor(() => finish, { label: "app building" });
    first.postMessage(room.id, { text: "Keep the old API working too.", to: "codexapp" });
    first.shutdown();
    await waitFor(() => !first.running.size, { label: "first desk stopped" });

    finish = null;
    const second = await appEngine(t, app);
    await waitFor(() => finish, { label: "followed again" });
    finish("Built.\nTORYO: REVIEW S1 | h.md");
    await waitFor(() => second.rooms.get(room.id).waiting, { label: "review done" });
    assert.deepEqual(calls.map((c) => c.how), ["send", "follow", "send"]);
    assert.match(calls[2].prompt, /Keep the old API working too\./);
    assert.deepEqual(turns(second, room.id).map((x) => `${x.agent}:${x.kind}:${x.status ?? x.state}`), ["codexapp:build:interrupted", "codexapp:build:REVIEW", "codexapp:build-notes:REPLY", "claude:review:OWNER"]);
  } finally {
    t.cleanup();
  }
});

test("after an upgrade, an app room that may have missed the house rules gets them on its next turn", async () => {
  const t = await setup([]);
  try {
    const prompts = [];
    const app = { run: async ({ prompt }) => (prompts.push(prompt), { text: "ok\nTORYO: REPLY" }) };
    const first = await appEngine(t, app);
    first.updateProject("repo", { rules: "HOUSE-RULE-XYZ: never commit." });
    const room = first.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], text: "Hello.", to: "codexapp", appThread: "t1" });
    await waitFor(() => prompts.length === 1 && !first.running.size, { label: "first turn" });
    // The room as the previous version saved it: a thread from the start, no record of introductions.
    const saved = t.engine.store.loadRoom(room.id);
    delete saved.introduced;
    t.engine.store.saveRoom(saved);

    const second = await appEngine(t, app);
    second.postMessage(room.id, { text: "Again.", to: "codexapp" });
    await waitFor(() => prompts.length === 2 && !second.running.size, { label: "turn after the upgrade" });
    assert.match(prompts[1], /HOUSE-RULE-XYZ/);
    second.postMessage(room.id, { text: "And again.", to: "codexapp" });
    await waitFor(() => prompts.length === 3 && !second.running.size, { label: "the turn after" });
    assert.doesNotMatch(prompts[2], /HOUSE-RULE-XYZ/, "once is enough");
  } finally {
    t.cleanup();
  }
});

test("questions asked in chat can be answered through the answer API, one at a time", async () => {
  const t = await setup([
    { agent: "codex", match: "Go with your recommendation|SQLite", reply: "Using it.\nTORYO: REPLY" },
    { agent: "claude", match: "Go with your recommendation|SQLite", reply: "Agreed.\nTORYO: REPLY" },
    { agent: "codex", reply: "I recommend SQLite.\nTORYO: OWNER Which database?" },
    { agent: "claude", reply: "I recommend a CLI.\nTORYO: OWNER Ship a CLI?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", text: "Plan the storage.", to: "everyone" });
    await waitFor(() => summary(t.engine, room.id).waitingCount === 2 && !t.engine.running.size, { label: "both asked" });
    const asked = t.engine.roomView(room.id).events.filter((e) => e.type === "question" && e.open);
    const claudes = asked.find((q) => q.from === "claude");
    // Accept Claude's recommendation by the question's id: only that question closes.
    t.engine.answer(room.id, { accept: true, questionId: claudes.id });
    assert.equal(summary(t.engine, room.id).waitingCount, 1);
    assert.equal(summary(t.engine, room.id).waiting.from, "codex");
    // A written answer without an id goes to the question that's left.
    t.engine.answer(room.id, { text: "SQLite." });
    assert.equal(summary(t.engine, room.id).waitingCount, 0);
    await waitFor(() => turns(t.engine, room.id).filter((x) => x.state === "done").length === 4 && !t.engine.running.size, { label: "both replied" });
    const calls = t.calls();
    assert.match(calls.find((c) => c.kind === "claude" && /Agreed|Go with your recommendation/.test(c.prompt)).prompt, /Go with your recommendation: a CLI\./);
    assert.match(calls.filter((c) => c.kind === "codex").at(-1).prompt, /SQLite\./);
    const closed = t.engine.roomView(room.id).events.filter((e) => e.type === "question");
    assert.deepEqual(closed.map((q) => [q.from, q.open, q.answer]).sort(), [["claude", false, "Go with your recommendation: a CLI."], ["codex", false, "SQLite."]]);
    assert.throws(() => t.engine.answer(room.id, { text: "More?" }), /Nobody is waiting/);
  } finally {
    t.cleanup();
  }
});

test("Ask or Tell: a question mark, a question, or a request for an opinion or a choice is Ask; anything else is Tell", async () => {
  const { noteIntent } = await import("../web/intent.js");
  for (const ask of ["Tabs or spaces?", "what do you think about the cache", "Should we split the slice", "@claude which one would you pick", "Thoughts on the naming", "Any objections to dropping v1", "Is this ready"])
    assert.equal(noteIntent(ask), "ask", ask);
  for (const tell of ["Use tabs.", "Please also add note.txt.", "Skip the archived stories", "Rename the flag to --fast", "This is fine, carry on", "Do the migration first.", "Have a look at the logs.", "Could you add tests for it."])
    assert.equal(noteIntent(tell), "tell", tell);
  assert.equal(noteIntent("Are the tests green"), "ask");
  assert.equal(noteIntent("Do you see the flake"), "ask");
});
