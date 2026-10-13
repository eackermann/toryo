import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, turns, waitFor } from "./helpers.mjs";

const sessionArg = (call) => (call.args.includes("--resume") ? "resume" : call.args.includes("--session-id") ? "new" : "?");
const sessionOf = (call) => call.args[call.args.indexOf(call.args.includes("--resume") ? "--resume" : "--session-id") + 1];

test("a review whose prompt a hook dropped is an error with Retry, never a verdict, and the retry carries the handoff again", async () => {
  const t = await setup([
    { agent: "codex", reply: "Built HANDOFF-777.\nTORYO: REVIEW Slice 1 | h1.md" },
    { agent: "claude", hookDrop: "cache-tax: prompt larger than the cached prefix", times: 1 },
    { agent: "claude", reply: "Looks right.\nTORYO: APPROVED", times: 1 },
    { agent: "codex", match: "approved", reply: "Done.\nTORYO: DONE" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x", settings: { autoContinue: false } });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "error question" });
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.waiting.kind, "error");
    assert.match(r.waiting.question, /Claude's turn failed: Claude never saw the prompt\. Prompt dropped by a hook: cache-tax/);
    assert.equal(r.waiting.recommendation, "Retry");
    const review = turns(t.engine, room.id).find((x) => x.kind === "review");
    assert.equal(review.state, "failed");
    assert.equal(review.dropped, true);
    // Not retried on its own (the hook would drop it again), and nothing went back to the builder.
    assert.deepEqual(t.calls().map((c) => c.kind), ["codex", "claude"]);
    assert.equal(r.build.round, 0);
    assert.equal(r.queue.length, 0);
    assert.equal(r.sessions.claude, undefined, "the session the dropped turn started is forgotten");

    t.engine.control(room.id, "retry");
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "slice-approved", { label: "approved after retry" });
    const retry = t.calls()[2];
    assert.equal(retry.kind, "claude");
    assert.match(retry.prompt, /Built HANDOFF-777/, "the handoff is sent again whole");
    assert.equal(sessionArg(retry), "new");
  } finally {
    t.cleanup();
  }
});

test("an empty review is an error after one quiet retry, never a verdict", async () => {
  const t = await setup([
    { agent: "codex", reply: "Built.\nTORYO: REVIEW Slice 1 | h1.md" },
    { agent: "claude", empty: true },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "error question" });
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.waiting.kind, "error");
    assert.match(r.waiting.question, /returned an empty message/);
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.kind}:${x.state}`), ["build:done", "review:failed", "review:failed"]);
    // Both tries carried the builder's message: the first never counted as delivered.
    const claude = t.calls().filter((c) => c.kind === "claude");
    assert.equal(claude.length, 2);
    for (const c of claude) assert.match(c.prompt, /Built\./);
    assert.equal(r.build.round, 0, "no round counted against the builder");
  } finally {
    t.cleanup();
  }
});

test("starting an agent fresh forgets only its session; its next turn starts a new one with what it needs", async () => {
  const t = await setup([
    { agent: "claude", reply: "Claude here.\nTORYO: REPLY" },
    { agent: "codex", reply: "Codex here.\nTORYO: REPLY" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude"], text: "Hello both, remember PURPLE-42." });
    const done = (n) => waitFor(() => turns(t.engine, room.id).filter((x) => x.state === "done").length === n, { label: `${n} turns` });
    await done(2);
    const before = { ...t.engine.rooms.get(room.id).sessions };
    assert.ok(before.claude && before.codex);

    t.engine.control(room.id, "fresh", { agent: "claude" });
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.fresh.claude, "you");
    assert.equal(r.sessions.codex, before.codex);
    assert.throws(() => t.engine.control(room.id, "fresh", { agent: "grok" }), /isn't in this room/);

    t.engine.postMessage(room.id, { text: "And now?", to: "everyone" });
    await done(4);
    const calls = t.calls();
    const [claudeCall] = calls.slice(2).filter((c) => c.kind === "claude");
    const [codexCall] = calls.slice(2).filter((c) => c.kind === "codex");
    assert.equal(sessionArg(claudeCall), "new");
    assert.notEqual(sessionOf(claudeCall), before.claude);
    assert.match(claudeCall.prompt, /## A fresh session/);
    assert.match(claudeCall.prompt, /The owner started you fresh in this room/);
    assert.match(claudeCall.prompt, /PURPLE-42/, "the recent messages come along");
    assert.ok(codexCall.args.includes("resume") && codexCall.args.includes(before.codex), "Codex keeps its session");
    assert.doesNotMatch(codexCall.prompt, /A fresh session/);
    const after = t.engine.rooms.get(room.id);
    assert.equal(after.fresh.claude, undefined);
    assert.notEqual(after.sessions.claude, before.claude);
    assert.equal(after.sessions.codex, before.codex);
  } finally {
    t.cleanup();
  }
});

/** A two-slice build: changes on slice 1, approval with a finding left open, a question to the owner, slice 2, the final review. */
const twoSlices = () => [
  { agent: "codex", match: "Your role: builder", reply: "Built S1.\nTORYO: REVIEW Slice 1 | h1.md", times: 1 },
  { agent: "codex", match: "reviewed your last round", reply: "Fixed F1.\nTORYO: REVIEW Slice 1 | h1.md", times: 1 },
  { agent: "codex", match: "approved “Slice 1”", reply: "A question first.\nTORYO: OWNER Use SQLite or Postgres?", times: 1 },
  { agent: "codex", match: "The owner answered", reply: "Built S2.\nTORYO: REVIEW Slice 2 | h2.md", times: 1 },
  { agent: "codex", match: "approved “Slice 2”", reply: "Everything is in.\nTORYO: DONE", times: 1 },
  { agent: "claude", match: "Do a final review", reply: "Final review: fine.\nTORYO: APPROVED", times: 1 },
  { agent: "claude", match: "Built S1", reply: "Finding F1: the null check is missing.\nTORYO: CHANGES", times: 1 },
  { agent: "claude", match: "Fixed F1", reply: "Good now.\nOpen: tidy the README section later\nTORYO: APPROVED", times: 1 },
  { agent: "claude", match: "Built S2", reply: "Resolved: L2\nSlice 2 is fine.\nTORYO: APPROVED", times: 1 },
];

test("the reviewer starts fresh for each new slice and for the final review, with a ledger of open findings and the owner's decisions", async () => {
  const t = await setup(twoSlices());
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Two slices" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "build-owner", { label: "builder's question" });
    t.engine.answer(room.id, { text: "Use SQLite." });
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "plan complete" });

    const reviews = t.calls().filter((c) => c.kind === "claude");
    assert.equal(reviews.length, 4);
    assert.deepEqual(reviews.map(sessionArg), ["new", "resume", "new", "new"], "round 2 of a slice keeps the reviewer's session");
    assert.equal(sessionOf(reviews[1]), sessionOf(reviews[0]));
    assert.equal(new Set(reviews.map(sessionOf)).size, 3);

    const slice2 = reviews[2].prompt;
    assert.match(slice2, /Toryo starts the reviewer fresh for each new slice/);
    assert.match(slice2, /The ledger: open findings and the owner's decisions/);
    assert.match(slice2, /L2 \(Slice 1, left open on approval, Claude\): tidy the README section later/);
    assert.doesNotMatch(slice2, /L1 \(/, "a finding resolved by the slice's approval isn't open");
    assert.match(slice2, /D1 \(Slice 1, Codex asked\): Use SQLite or Postgres\? → Use SQLite\./);
    assert.match(reviews[3].prompt, /Toryo starts a fresh session for the final review/);

    const ledger = t.engine.rooms.get(room.id).ledger;
    const byId = Object.fromEntries(ledger.map((e) => [e.id, e]));
    assert.deepEqual(Object.keys(byId).sort(), ["D1", "L1", "L2"]);
    assert.equal(byId.L1.state, "resolved");
    assert.match(byId.L1.resolution, /Slice 1 approved in round 2/);
    assert.match(byId.L1.text, /Finding F1/);
    assert.equal(byId.L2.state, "resolved");
    assert.match(byId.L2.resolution, /Claude's review of Slice 2/);
    assert.equal(byId.D1.answer, "Use SQLite.");
  } finally {
    t.cleanup();
  }
});

test("with the setting off, the reviewer keeps its session across slices; the final review is still fresh", async () => {
  const t = await setup(twoSlices());
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Two slices", settings: { freshReviewer: false } });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "build-owner", { label: "builder's question" });
    t.engine.answer(room.id, { text: "Use SQLite." });
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "plan complete" });
    const reviews = t.calls().filter((c) => c.kind === "claude");
    assert.deepEqual(reviews.map(sessionArg), ["new", "resume", "resume", "new"]);
    assert.doesNotMatch(reviews[2].prompt, /A fresh session/);
  } finally {
    t.cleanup();
  }
});

test("a note can be edited or withdrawn while it's queued, and not once an agent has it", async () => {
  const t = await setup([{ agent: "claude", reply: "Got it.\nTORYO: REPLY" }]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["claude"] });
    t.engine.control(room.id, "pause");
    // Withdrawn: the turn queued for it goes too, and nothing runs on resume.
    const first = t.engine.postMessage(room.id, { text: "Ignore this one.", to: "claude" }).event;
    assert.equal(t.engine.rooms.get(room.id).queue.length, 1);
    t.engine.editNote(room.id, first.id, { cancel: true });
    assert.equal(t.engine.rooms.get(room.id).queue.length, 0);
    assert.throws(() => t.engine.editNote(room.id, first.id, { text: "again" }), /already withdrawn/);

    // Edited: the agent gets the new text, never the old one.
    const second = t.engine.postMessage(room.id, { text: "Use tabs.", to: "claude" }).event;
    t.engine.editNote(room.id, second.id, { text: "Use spaces, EDITED-55." });
    assert.throws(() => t.engine.editNote(room.id, second.id, { text: "  " }), /Write the note/);
    t.engine.control(room.id, "resume");
    await waitFor(() => turns(t.engine, room.id).some((x) => x.state === "done"), { label: "claude replied" });
    const [call] = t.calls();
    assert.match(call.prompt, /Use spaces, EDITED-55\./);
    assert.doesNotMatch(call.prompt, /Use tabs|Ignore this one/);
    assert.equal(t.calls().length, 1);

    // Delivered: it stays as sent.
    assert.throws(() => t.engine.editNote(room.id, second.id, { text: "Too late." }), /already gone to the crew/);
    const events = t.engine.roomView(room.id).events;
    assert.ok(events.find((e) => e.id === first.id).cancelled);
    assert.ok(events.find((e) => e.id === second.id).editedAt);
    assert.ok(events.some((e) => e.type === "system" && /You withdrew your note to Claude/.test(e.text)));
  } finally {
    t.cleanup();
  }
});

test("Claude's zero-turn result is retried whole, in a new session, with the handoff", async () => {
  const t = await setup([
    { agent: "codex", reply: "Built HANDOFF-888.\nTORYO: REVIEW Slice 1 | h1.md" },
    { agent: "claude", zeroTurns: true, times: 1 },
    { agent: "claude", reply: "Fine.\nTORYO: APPROVED", times: 1 },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x", settings: { autoContinue: false } });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "slice-approved", { label: "approved" });
    const [first, retry] = t.calls().filter((c) => c.kind === "claude");
    assert.match(first.prompt, /HANDOFF-888/);
    assert.match(retry.prompt, /HANDOFF-888/, "the retry carries the handoff again");
    assert.equal(sessionArg(retry), "new");
    assert.notEqual(sessionOf(retry), sessionOf(first), "not the session the failed turn started");
    const [failed] = turns(t.engine, room.id).filter((x) => x.kind === "review");
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /ran no turns/);
  } finally {
    t.cleanup();
  }
});

test("a dropped prompt is an error even when diagnostic text follows; the model quoting the notice is not a drop", async () => {
  const t = await setup([
    { agent: "codex", reply: "Built.\nTORYO: REVIEW Slice 1 | h1.md" },
    { agent: "claude", hookDrop: "cache-tax: too large", resultText: "Hook cache-tax blocked this prompt (exit 2).", times: 1 },
    { agent: "claude", reply: "Prompt dropped by a hook: is the notice the parser looks for. Fine.\nTORYO: APPROVED", times: 1 },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x", settings: { autoContinue: false } });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "error" });
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.waiting.kind, "error");
    assert.match(r.waiting.question, /cache-tax/);
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.kind}:${x.state}`), ["build:done", "review:failed"], "no review-status, no automatic retry");
    t.engine.control(room.id, "retry");
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "slice-approved", { label: "approved" });
    assert.equal(turns(t.engine, room.id).at(-1).dropped, undefined);
  } finally {
    t.cleanup();
  }
});

test("withdrawing one of two notes that share a queued turn keeps the turn for the other", async () => {
  const t = await setup([{ agent: "claude", reply: "Got it.\nTORYO: REPLY" }]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["claude"] });
    t.engine.control(room.id, "pause");
    const a = t.engine.postMessage(room.id, { text: "First: use tabs.", to: "claude" }).event;
    const b = t.engine.postMessage(room.id, { text: "Second: KEEP-ME-321.", to: "claude" }).event;
    assert.equal(t.engine.rooms.get(room.id).queue.length, 1);
    assert.deepEqual(t.engine.rooms.get(room.id).queue[0].notes, [a.id, b.id]);
    t.engine.editNote(room.id, a.id, { cancel: true });
    assert.equal(t.engine.rooms.get(room.id).queue.length, 1, "the turn stays for the second note");
    t.engine.control(room.id, "resume");
    await waitFor(() => turns(t.engine, room.id).some((x) => x.state === "done"), { label: "reply" });
    const [call] = t.calls();
    assert.match(call.prompt, /KEEP-ME-321/);
    assert.doesNotMatch(call.prompt, /use tabs/);
    // Withdrawing the last one drops the turn.
    t.engine.control(room.id, "pause");
    const c = t.engine.postMessage(room.id, { text: "Third.", to: "claude" }).event;
    t.engine.editNote(room.id, c.id, { cancel: true });
    assert.equal(t.engine.rooms.get(room.id).queue.length, 0);
  } finally {
    t.cleanup();
  }
});

test("a question that arrives while the reviewer answers another is answered next, and the build carries on", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", delayMs: 1500, reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", match: "SECOND-Q", reply: "Second answer.\nTORYO: REPLY", times: 1 },
    { agent: "claude", match: "Answering your question", delayMs: 400, reply: "First answer.\nTORYO: REPLY", times: 1 },
    { agent: "claude", match: "Your role: reviewer", reply: "Fine.\nTORYO: OWNER Ship it?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("codex"), { label: "builder working" });
    t.engine.postMessage(room.id, { text: "Why this order?", to: "claude" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("claude"), { label: "first answer started" });
    const second = t.engine.postMessage(room.id, { text: "And SECOND-Q: why that name?", to: "claude" }).event;
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "review done" });
    assert.deepEqual(
      turns(t.engine, room.id).map((x) => `${x.agent}:${x.kind}:${x.status}`).sort(),
      ["claude:note-answer:REPLY", "claude:note-answer:REPLY", "claude:review:OWNER", "codex:build:REVIEW"],
    );
    assert.equal(t.engine.roomView(room.id).events.find((e) => e.id === second.id).outcomes.claude.status, "answered");
  } finally {
    t.cleanup();
  }
});

test("in a finished, paused build, withdrawing the first of two notes to the builder keeps the turn for the second", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", reply: "All built.\nTORYO: DONE", times: 1 },
    { agent: "claude", reply: "Final: fine.\nTORYO: APPROVED" },
    { agent: "codex", match: "The owner wrote to you", reply: "N1: done — kept.\nTORYO: OWNER Anything else?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "build done" });
    t.engine.control(room.id, "pause");
    const a = t.engine.postMessage(room.id, { text: "First: rename it.", to: "codex" }).event;
    const b = t.engine.postMessage(room.id, { text: "Second: KEEP-77.", to: "codex" }).event;
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.queue.length, 1);
    assert.deepEqual(r.queue[0].notes, [a.id, b.id]);
    t.engine.editNote(room.id, a.id, { cancel: true });
    assert.equal(r.queue.length, 1, "the turn stays for the second note");
    assert.equal(r.done, false, "the build stays reopened");
    t.engine.control(room.id, "resume");
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "builder's reply" });
    const last = t.calls().at(-1);
    assert.match(last.prompt, /KEEP-77/);
    assert.doesNotMatch(last.prompt, /rename it/);
  } finally {
    t.cleanup();
  }
});

test("withdrawing a note sent mid-turn skips its building turn, and the relay carries on to review", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", delayMs: 600, reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "codex", match: "Building: your notes", reply: "N1: done.\nTORYO: REPLY" },
    { agent: "claude", reply: "Fine.\nTORYO: OWNER Ship it?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("codex"), { label: "builder working" });
    const note = t.engine.postMessage(room.id, { text: "Add a changelog line.", to: "codex" }).event;
    t.engine.control(room.id, "pause");
    await waitFor(() => t.engine.rooms.get(room.id).queue.some((q) => q.kind === "build-notes"), { label: "notes turn queued" });
    assert.deepEqual(t.engine.rooms.get(room.id).queue.find((q) => q.kind === "build-notes").notes, [note.id]);
    t.engine.editNote(room.id, note.id, { cancel: true });
    // The review the build turn was heading for is queued instead of the notes turn.
    assert.deepEqual(t.engine.rooms.get(room.id).queue.map((q) => `${q.agent}:${q.kind}`), ["claude:review"]);
    t.engine.control(room.id, "resume");
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "review done" });
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.agent}:${x.kind}:${x.status}`), ["codex:build:REVIEW", "claude:review:OWNER"]);
    assert.doesNotMatch(t.calls().at(-1).prompt, /changelog/);
  } finally {
    t.cleanup();
  }
});

test("withdrawing a question sent mid-review skips the answer, and the review's verdict carries on", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", match: "Your role: reviewer", delayMs: 600, reply: "One finding.\nTORYO: CHANGES" },
    { agent: "claude", match: "Answering your question", reply: "Because.\nTORYO: REPLY" },
    { agent: "codex", match: "reviewed your last round", reply: "Fixed.\nTORYO: OWNER Anything else?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("claude"), { label: "reviewer working" });
    const q = t.engine.postMessage(room.id, { text: "Why that finding?", to: "claude" }).event;
    t.engine.control(room.id, "pause");
    await waitFor(() => t.engine.rooms.get(room.id).queue.some((x) => x.kind === "note-answer"), { label: "answer queued" });
    t.engine.editNote(room.id, q.id, { cancel: true });
    assert.deepEqual(t.engine.rooms.get(room.id).queue.map((x) => `${x.agent}:${x.kind}`), ["codex:build-fix"]);
    assert.equal(t.engine.rooms.get(room.id).build.round, 1, "the CHANGES verdict counted");
    t.engine.control(room.id, "resume");
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "builder's question" });
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.agent}:${x.kind}:${x.status}`), ["codex:build:REVIEW", "claude:review:CHANGES", "codex:build-fix:OWNER"]);
  } finally {
    t.cleanup();
  }
});

test("a turn queued for a note before 13 Oct still goes once its notes are withdrawn, one after the other", async () => {
  const t = await setup([]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["claude"] });
    t.engine.control(room.id, "pause");
    const a = t.engine.postMessage(room.id, { text: "First.", to: "claude" }).event;
    // The turn as an older Toryo queued it: one `note`, no list.
    const q = t.engine.rooms.get(room.id).queue[0];
    delete q.forNotes;
    delete q.notes;
    q.note = a.id;
    const b = t.engine.postMessage(room.id, { text: "Second.", to: "claude" }).event;
    assert.deepEqual([q.forNotes, q.notes, q.note], [true, [a.id, b.id], undefined]);
    t.engine.editNote(room.id, a.id, { cancel: true });
    assert.equal(t.engine.rooms.get(room.id).queue.length, 1);
    t.engine.editNote(room.id, b.id, { cancel: true });
    assert.equal(t.engine.rooms.get(room.id).queue.length, 0);
  } finally {
    t.cleanup();
  }
});
