import { test } from "node:test";
import assert from "node:assert/strict";
import { Sessions } from "../web/phases.js";
import { mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const sum = (e, id) => e.summary(e.rooms.get(id));
const replies = (e, id) => turns(e, id).filter((x) => x.state === "done").length;
const refused = (fn, pattern, status = 409) =>
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, err.message);
    assert.match(err.message, pattern);
    return true;
  });

test("a new session is refused while anything runs or is queued, naming it, and starts once however many ask", async () => {
  const t = await setup([{ agent: "codex", match: "Hang on", hang: true }, { agent: "codex", reply: "Hi.\nTORYO: REPLY" }]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Busy", text: "Hang on.", to: "codex" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "running"), { label: "a turn" });
    refused(() => e.newSession(room.id, { ends: 1 }), /^Codex is replying\. Wait for it to finish, or stop the room first, then start the new session\.$/);
    e.control(room.id, "stop");
    await waitFor(() => !sum(e, room.id).running.length, { label: "stopped" });
    // Queued: paused, with a note waiting for its turn.
    e.control(room.id, "resume");
    e.control(room.id, "pause");
    e.postMessage(room.id, { text: "Later.", to: "codex", answering: false });
    refused(() => e.newSession(room.id, { ends: 1 }), /^Codex's reply is queued\. Wait for it/);
    refused(() => e.newSession(room.id, {}), /Say which session this ends \(ends: 1\)/, 400);
    assert.equal(e.rooms.get(room.id).session, undefined, "nothing changed");
    // Stopped (which clears the queue): accepted, once. The same request again, as from a second click or another
    // client, is refused.
    e.control(room.id, "stop");
    e.newSession(room.id, { ends: 1 });
    refused(() => e.newSession(room.id, { ends: 1 }), /^Session 1 has already ended: this room is in session 2 now\. Nothing changed\.$/);
    assert.equal(e.roomView(room.id).events.filter((x) => x.type === "session").length, 1);
    assert.deepEqual([sum(e, room.id).session.n, sum(e, room.id).status], [2, "idle"]);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("what a new session ends and what stays: questions close (a late answer is refused), unsent notes aren't sent, agents start fresh with only the new session", async () => {
  const t = await setup([
    { agent: "codex", match: "Which database", reply: "Which one?\nTORYO: OWNER SQLite or Postgres?" },
    { agent: "codex", reply: "Hello.\nTORYO: REPLY" },
    { agent: "claude", reply: "Hi.\nTORYO: REPLY" },
  ]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude"], title: "Sprint room", text: "Which database for the cache?", to: "codex" });
    await waitFor(() => sum(e, room.id).questions.length === 1, { label: "a question" });
    const [q] = sum(e, room.id).questions;
    // A note Claude hasn't had yet: queued while paused, then the room stopped.
    e.control(room.id, "pause");
    const note = e.postMessage(room.id, { text: "A note from the old sprint.", to: "claude", answering: false }).event;
    e.control(room.id, "stop");
    e.control(room.id, "rename", { title: "Kept name" });
    e.control(room.id, "settings", { maxRounds: 7 });
    const before = structuredClone({ crew: e.rooms.get(room.id).crew, ledger: e.rooms.get(room.id).ledger ?? null, projectId: e.rooms.get(room.id).projectId });
    const out = e.newSession(room.id, { ends: 1 });
    assert.equal(out.session.n, 2);
    const r = e.rooms.get(room.id);
    const find = (id) => e.roomView(room.id).events.find((x) => x.id === id);
    // The question closed, and an answer to it now is refused.
    assert.deepEqual([find(q.id).open, find(q.id).answer, Boolean(find(q.id).closedAt)], [false, "(closed: a new session started)", true]);
    refused(() => e.answer(room.id, { questionId: q.id, text: "SQLite." }), /already been answered|isn't open|no longer/i);
    // The note isn't sent in the new session; the page says so.
    assert.deepEqual(find(note.id).notSent, ["claude"]);
    // The room waits in chat with nothing queued; its name, crew, settings, project and ledger stay.
    assert.deepEqual([r.mode, r.paused, r.stopped, r.done, r.queue.length, r.waiting, sum(e, room.id).status], ["chat", false, false, false, 0, null, "idle"]);
    assert.deepEqual([r.title, r.settings.maxRounds], ["Kept name", 7]);
    assert.deepEqual({ crew: r.crew, ledger: r.ledger ?? null, projectId: r.projectId }, before);
    const marker = e.roomView(room.id).events.find((x) => x.type === "session");
    assert.deepEqual([marker.n, marker.ends, marker.fresh, marker.kept, marker.closed, marker.notSent], [2, 1, ["codex", "claude"], [], [q.id], [note.id]]);
    // Each agent's next turn: a new agent session, briefed, with nothing from before the new session.
    const firstCodex = t.calls().find((c) => c.kind === "codex");
    e.postMessage(room.id, { text: "New sprint: what's first?", to: "everyone", answering: false });
    await waitFor(() => replies(e, room.id) >= 3, { label: "both replies" });
    const [codex, claude] = ["codex", "claude"].map((k) => t.calls().filter((c) => c.kind === k).at(-1));
    assert.ok(!codex.args.includes("resume"), "Codex starts a new session");
    assert.notEqual(codex.session, firstCodex.session);
    assert.ok(claude.args.includes("--session-id"), "Claude starts a new session");
    for (const c of [codex, claude]) {
      assert.match(c.prompt, /The owner started a new session in this room: what came before it is finished, so you start fresh\./);
      assert.match(c.prompt, /New sprint: what's first\?/);
      assert.doesNotMatch(c.prompt, /Which database|A note from the old sprint|SQLite or Postgres/);
    }
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("keeping the agents' memory: their sessions carry on, and each is told once that a new session began", async () => {
  const t = await setup([{ agent: "codex", reply: "Hi.\nTORYO: REPLY" }]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Kept", text: "Hello.", to: "codex" });
    await waitFor(() => replies(e, room.id) === 1, { label: "a reply" });
    const first = t.calls()[0];
    e.newSession(room.id, { ends: 1, keepMemory: true });
    assert.deepEqual(e.roomView(room.id).events.find((x) => x.type === "session").kept, ["codex"]);
    e.postMessage(room.id, { text: "Next sprint.", to: "codex", answering: false });
    await waitFor(() => replies(e, room.id) === 2, { label: "the second reply" });
    e.postMessage(room.id, { text: "And again.", to: "codex", answering: false });
    await waitFor(() => replies(e, room.id) === 3, { label: "the third reply" });
    const [, second, third] = t.calls();
    assert.ok(second.args.includes("resume"), "the same Codex session");
    assert.equal(second.session, first.session);
    assert.match(second.prompt, /## A new session\nThe owner started a new session in this room \(session 2\)\./);
    assert.doesNotMatch(third.prompt, /## A new session/, "said once");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("the first step from the same action: a planning round or a build, as a new room starts them, checked before anything changes", async () => {
  const t = await setup([
    { agent: "codex", match: "step 1 of 4", reply: "My proposal.\nTORYO: PROPOSAL" },
    { agent: "codex", match: "Your role: builder", hang: true },
    { agent: "codex", reply: "Hi.\nTORYO: REPLY" },
  ]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Steps", text: "Hello.", to: "codex" });
    await waitFor(() => replies(e, room.id) === 1, { label: "a reply" });
    refused(() => e.newSession(room.id, { ends: 1, then: { mode: "plan", topic: " " } }), /^Say what you want to plan\.$/, 400);
    refused(() => e.newSession(room.id, { ends: 1, then: { mode: "build" } }), /^Give a task or a plan file\.$/, 400);
    assert.equal(e.rooms.get(room.id).session, undefined, "nothing changed");
    e.newSession(room.id, { ends: 1, then: { mode: "plan", topic: "The next sprint" } });
    assert.deepEqual([e.rooms.get(room.id).mode, e.rooms.get(room.id).plan.topic, e.rooms.get(room.id).session.n], ["plan", "The next sprint", 2]);
    await waitFor(() => turns(e, room.id).some((x) => x.kind === "plan-proposal" && x.state === "done"), { label: "a proposal" });
    e.control(room.id, "stop");
    await waitFor(() => !sum(e, room.id).running.length, { label: "stopped" });
    e.newSession(room.id, { ends: 2, then: { mode: "build", task: "Build the sprint" } });
    assert.deepEqual([e.rooms.get(room.id).mode, e.rooms.get(room.id).build.task, e.rooms.get(room.id).session.n], ["build", "Build the sprint", 3]);
    await waitFor(() => turns(e, room.id).some((x) => x.kind === "build" && x.state === "running"), { label: "the builder" });
    e.control(room.id, "stop");
    await waitFor(() => !sum(e, room.id).running.length, { label: "stopped" });
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("the timeline and totals start again; earlier sessions keep theirs, after a restart too, and the page splits them the same way", async () => {
  const t = await setup([{ agent: "codex", workMs: 600, reply: "Hi.\nTORYO: REPLY" }]);
  let e = t.engine;
  try {
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Timed", text: "First sprint.", to: "codex" });
    await waitFor(() => replies(e, room.id) === 1, { label: "a reply" });
    const first = sum(e, room.id).session.totals;
    assert.ok(first.other >= 600);
    e.newSession(room.id, { ends: 1 });
    const now = sum(e, room.id).session;
    assert.equal(now.n, 2);
    assert.deepEqual(Object.values(now.totals), Object.values(now.totals).map(() => 0), "the new session starts from nothing");
    assert.deepEqual([now.earlier.length, now.earlier[0].n, now.earlier[0].totals], [1, 1, first]);
    // After a restart: the same split, from the saved events and the room's boundary.
    e.shutdown();
    e = await t.make();
    const again = sum(e, room.id).session;
    assert.deepEqual([again.n, again.earlier[0].totals, again.totals.other], [2, first, 0]);
    e.postMessage(room.id, { text: "Second sprint.", to: "codex", answering: false });
    await waitFor(() => replies(e, room.id) === 2, { label: "a reply in session 2" });
    assert.doesNotMatch(t.calls().at(-1).prompt, /First sprint/, "the next turn has only this session");
    assert.ok(sum(e, room.id).session.totals.other >= 600);
    assert.deepEqual(sum(e, room.id).session.earlier[0].totals, first, "an earlier session's totals don't change");
    // The page's way: the room's events, split where the session began.
    const page = new Sessions();
    for (const x of e.roomView(room.id).events) page.add(x);
    assert.deepEqual([page.list.length, page.n, page.view(0).totals], [2, 2, first]);
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("the command line, MCP and the API give the same results and the same refusals", async () => {
  await withServer([{ agent: "codex", match: "Hang on", hang: true }, { agent: "codex", reply: "Hi.\nTORYO: REPLY" }], async ({ engine: e, client, home, post: postJson }) => {
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Shared", text: "Hang on.", to: "codex" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "running"), { label: "a turn" });
    const busy = "Codex is replying. Wait for it to finish, or stop the room first, then start the new session.";
    await assert.rejects(client.newSession(room.id), (err) => err.message === busy);
    const m = mcp(home);
    try {
      const said = await m.call("toryo_session_new", { room: room.id });
      assert.deepEqual([said.error, said.text], [true, busy]);
      e.control(room.id, "stop");
      await waitFor(() => !sum(e, room.id).running.length, { label: "stopped" });
      assert.equal(await client.newSession(room.id), "Session 2 started in “Shared”; session 1 is kept in its history. Each agent starts fresh on its next turn (the Codex app keeps its thread). Nothing runs until you send something.");
      const viaMcp = await m.call("toryo_session_new", { room: room.id, keepMemory: true, mode: "chat", text: "Next sprint." });
      assert.equal(viaMcp.text, "Session 3 started in “Shared”; session 2 is kept in its history. The agents keep their memory. Then your message went to the crew.");
      await waitFor(() => replies(e, room.id) === 1, { label: "the reply" });
      const post = (body) => postJson(`/api/rooms/${room.id}/control`, { action: "new-session", ...body });
      assert.equal((await post({ ends: 3 })).body.session.n, 4);
      assert.deepEqual(await post({ ends: 3 }), { status: 409, body: { error: "Session 3 has already ended: this room is in session 4 now. Nothing changed." } });
      const shown = await client.roomText(room.id);
      assert.match(shown, /\nSession 4\. This session, /);
      assert.match(shown, /\nEarlier, session 1, .* to .*: (under a second of work|other work \d+ s)\.\nEarlier, session 2, .*: nothing run\.\nEarlier, session 3, /);
      assert.match(shown, /— Session 4 started\./);
    } finally {
      m.close();
    }
  });
});

test("an approval in a new session doesn't settle an earlier session's finding on a slice of the same name; the fresh reviewer is told where it came from", async () => {
  const t = await setup([
    { agent: "codex", reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md" },
    { agent: "claude", match: "Your role: reviewer", reply: "Fix the index.\nTORYO: CHANGES", times: 1 },
    { agent: "claude", reply: "Good.\nTORYO: APPROVED" },
  ]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "build", task: "One slice", title: "Two builds", settings: { autoContinue: false } });
    await waitFor(() => (e.rooms.get(room.id).ledger ?? []).length === 1, { label: "a finding" });
    e.control(room.id, "stop");
    await waitFor(() => !sum(e, room.id).running.length, { label: "stopped" });
    const [finding] = e.rooms.get(room.id).ledger;
    assert.deepEqual([finding.id, finding.slice, finding.session, finding.state], ["L1", "Slice 1: One", 1, "open"]);
    e.newSession(room.id, { ends: 1, then: { mode: "build", task: "The next sprint" } });
    await waitFor(() => turns(e, room.id).some((x) => x.kind === "review" && x.status === "APPROVED"), { label: "an approval in session 2" });
    assert.equal(e.rooms.get(room.id).ledger.find((f) => f.id === "L1").state, "open", "only a review that says so settles it");
    const review = t.calls().filter((c) => c.kind === "claude").at(-1);
    assert.match(review.prompt, /- L1 \(Slice 1: One, session 1, round 1 changes, Claude\): Fix the index\./);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("with memory kept, a first turn that never really happened (its prompt dropped, or empty) leaves the new-session note for the next try", async () => {
  const t = await setup([
    { agent: "claude", match: "Next sprint", hookDrop: "cache-tax: prompt larger than the cached prefix", times: 1 },
    { agent: "claude", match: "Second sprint", empty: true, times: 1 },
    { agent: "claude", reply: "Hi.\nTORYO: REPLY" },
  ]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], title: "Dropped", text: "Hello.", to: "claude" });
    await waitFor(() => replies(e, room.id) === 1, { label: "a reply" });
    const notice = (n) => new RegExp(`## A new session\\nThe owner started a new session in this room \\(session ${n}\\)`);
    // Dropped by a hook: an error with Retry; the retry has the note.
    e.newSession(room.id, { ends: 1, keepMemory: true });
    e.postMessage(room.id, { text: "Next sprint.", to: "claude", answering: false });
    await waitFor(() => e.rooms.get(room.id).waiting?.kind === "error", { label: "the dropped turn" });
    e.control(room.id, "retry", { questionId: e.rooms.get(room.id).waiting.eventId });
    await waitFor(() => replies(e, room.id) === 2, { label: "the retry" });
    const tries = t.calls().filter((c) => /Next sprint/.test(c.prompt));
    assert.equal(tries.length, 2);
    for (const c of tries) assert.match(c.prompt, notice(2));
    // Empty: retried once on its own, with the note.
    e.newSession(room.id, { ends: 2, keepMemory: true });
    e.postMessage(room.id, { text: "Second sprint.", to: "claude", answering: false });
    await waitFor(() => replies(e, room.id) === 3, { label: "the quiet retry" });
    const again = t.calls().filter((c) => /Second sprint/.test(c.prompt));
    assert.equal(again.length, 2);
    for (const c of again) assert.match(c.prompt, notice(3));
    e.postMessage(room.id, { text: "And on.", to: "claude", answering: false });
    await waitFor(() => replies(e, room.id) === 4, { label: "the next reply" });
    assert.doesNotMatch(t.calls().at(-1).prompt, /## A new session/);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a second opinion on a message from an earlier session carries that message", async () => {
  const t = await setup([
    { agent: "codex", match: "Which store", reply: "Use SQLite for the cache.\nTORYO: REPLY" },
    { agent: "claude", reply: "Postgres would be safer.\nTORYO: OPINION" },
  ]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude"], title: "Opinions", text: "Which store for the cache?", to: "codex" });
    await waitFor(() => replies(e, room.id) === 1, { label: "Codex's answer" });
    const target = turns(e, room.id)[0];
    e.newSession(room.id, { ends: 1 });
    e.control(room.id, "opinion", { eventId: target.id, agent: "claude" });
    await waitFor(() => replies(e, room.id) === 2, { label: "the opinion" });
    const asked = t.calls().find((c) => c.kind === "claude");
    assert.match(asked.prompt, /Codex, from an earlier session in this room ← the message you were asked about[\s\S]*Use SQLite for the cache\./);
    assert.match(asked.prompt, /## Second opinion requested/);
    assert.doesNotMatch(asked.prompt, /Which store for the cache/, "only the message asked about, not the rest of session 1");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a reply in a new session doesn't answer a note a stopped turn had read before it", async () => {
  const t = await setup([{ agent: "codex", match: "Hold this", hang: true }, { agent: "codex", reply: "Hi.\nTORYO: REPLY" }]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Replies" });
    const old = e.postMessage(room.id, { text: "Hold this.", to: "codex", answering: false }).event;
    await waitFor(() => e.roomView(room.id).events.find((x) => x.id === old.id).readBy?.codex, { label: "the note read" });
    e.control(room.id, "stop");
    await waitFor(() => !sum(e, room.id).running.length, { label: "stopped" });
    e.newSession(room.id, { ends: 1 });
    const fresh = e.postMessage(room.id, { text: "Something else.", to: "codex", answering: false }).event;
    await waitFor(() => replies(e, room.id) === 1, { label: "the reply" });
    const find = (id) => e.roomView(room.id).events.find((x) => x.id === id);
    assert.ok(find(fresh.id).repliedBy?.codex, "the new note is answered");
    assert.equal(find(old.id).repliedBy, undefined, "the old one isn't");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});
