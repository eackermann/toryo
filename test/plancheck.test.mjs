import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptRecommendation, parseQuestions, splitRecommendation } from "../src/protocol.mjs";
import { FAKE, mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const PLAN = "docs/plans/p.md";
const plan = (version) => ({ path: PLAN, content: `# P (${version})\n\n### Slice 1: One\n\n### Slice 2: Two\n` });
// A planning round that ends with a written plan Claude approves, so the room is Ready.
const round = [
  { agent: "codex", match: "step 1 of 4", reply: "Codex proposal.\nTORYO: PROPOSAL" },
  { agent: "claude", match: "step 1 of 4", reply: "Claude proposal.\nTORYO: PROPOSAL" },
  { match: "step 2 of 4", reply: "Critique.\nTORYO: CRITIQUE" },
  { agent: "codex", match: "step 3 of 4", write: plan("written"), reply: `Written.\nTORYO: REVIEW ${PLAN}` },
];
const room = (t, id) => t.engine.rooms.get(id);
const ready = (t, id) => room(t, id).waiting?.kind === "plan-ready" ? room(t, id).waiting : null;
const kinds = (t, id) => turns(t.engine, id).map((x) => `${x.agent}:${x.kind}:${x.status ?? x.state}`);

/** Start a round, settle the checkpoint with Codex as the author, and wait until the plan is Ready. */
async function readyPlan(t, { participants } = {}) {
  const r = t.engine.createRoom({ projectId: "repo", mode: "plan", topic: "P", planPath: PLAN, ...(participants ? { members: participants } : {}) });
  await waitFor(() => room(t, r.id).waiting?.kind === "plan-checkpoint", { label: "checkpoint" });
  t.engine.synthesize(r.id, { questionId: room(t, r.id).waiting.eventId, synthesizer: "codex", decisions: "" });
  await waitFor(() => ready(t, r.id), { label: "plan ready" });
  return r;
}

test("you ask for changes: the author revises, the other planner checks once (read-only) and asks for a fix, the author addresses it, and the plan is ready again", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", reply: "Looks complete.\nTORYO: APPROVED" },
    { agent: "codex", match: "The owner asked for changes to the plan", write: plan("revised"), reply: `Split slice 2.\nTORYO: REVIEW ${PLAN}` },
    { agent: "claude", match: "Check the revised plan", reply: "One finding: slice 2's tests went missing in the split.\nTORYO: CHANGES" },
    { agent: "codex", match: "checked the plan, and their findings are above", write: plan("addressed"), reply: `Put the tests back.\nTORYO: REVIEW ${PLAN}` },
  ]);
  try {
    const r = await readyPlan(t);
    assert.match(ready(t, r.id).question, /Claude checked it and approved\./);
    const before = ready(t, r.id).eventId;
    t.engine.answer(r.id, { questionId: before, text: "Split slice 2 in two." });
    await waitFor(() => ready(t, r.id) && ready(t, r.id).eventId !== before, { label: "ready again" });
    assert.deepEqual(kinds(t, r.id).slice(-3), ["codex:plan-revise:REVIEW", "claude:plan-check:CHANGES", "codex:plan-revise:REVIEW"]);
    const calls = t.calls();
    const recheck = calls.filter((c) => /Check the revised plan/.test(c.prompt));
    assert.equal(recheck.length, 1, "one check of your change");
    assert.equal(recheck[0].kind, "claude", "by the other planner, never the author");
    assert.ok(recheck[0].args.includes("--disallowedTools"), "read-only");
    assert.match(recheck[0].prompt, /Split slice 2 in two\./, "it sees your request");
    // The findings reach the author by themselves, and nothing checks the author's answer.
    const address = calls.find((c) => /checked the plan, and their findings are above/.test(c.prompt));
    assert.equal(address.kind, "codex");
    assert.match(address.prompt, /slice 2's tests went missing/);
    assert.equal(calls.filter((c) => /Check the revised plan|step 4 of 4/.test(c.prompt)).length, 2, "the first check and the re-check, nothing after");
    assert.match(ready(t, r.id).question, /Claude asked for changes, and Codex addressed them\./);
    assert.equal(room(t, r.id).plan.revision, 3);
    assert.equal(room(t, r.id).plan.cycle, null);
    assert.match(readFileSync(join(t.repo, PLAN), "utf8"), /addressed/);
  } finally {
    t.cleanup();
  }
});

test("asking for a check: an approving one leaves the plan ready, saying who checked; a stale card or a second click is refused", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
  ]);
  try {
    const r = await readyPlan(t);
    const card = ready(t, r.id).eventId;
    assert.deepEqual(room(t, r.id).waiting.checkers, ["claude"]);
    t.engine.control(r.id, "plan-check", { questionId: card });
    // Pressed twice, or from an older card: refused.
    assert.throws(() => t.engine.control(r.id, "plan-check", { questionId: card }), (e) => e.status === 409);
    await waitFor(() => ready(t, r.id), { label: "ready after the check" });
    assert.equal(t.calls().filter((c) => /step 4 of 4/.test(c.prompt)).length, 2, "the first check and the one you asked for");
    assert.match(ready(t, r.id).question, /Claude checked it and approved\./);
    assert.ok(!t.calls().some((c) => c.kind === "codex" && /plan-revise|Revise/.test(c.prompt)), "no revision after an approving check");
    for (const [action, args] of [["plan-check", {}], ["forward-discussion", { agent: "claude" }]])
      assert.throws(() => t.engine.control(r.id, action, { questionId: card, ...args }), (e) => e.status === 409);
    assert.throws(() => t.engine.answer(r.id, { questionId: card, accept: true }), (e) => e.status === 409);
    // Only the other planners can check.
    assert.throws(() => t.engine.control(r.id, "plan-check", { questionId: ready(t, r.id).eventId, checkers: ["codex"] }), /Only the other planners/);
  } finally {
    t.cleanup();
  }
});

test("with Re-check after changes off, your change is revised and the plan is ready, unchecked; with no other planner there's no check to ask for", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "codex", match: "The owner asked for changes to the plan", write: plan("revised"), reply: `Done.\nTORYO: REVIEW ${PLAN}` },
    { agent: "codex", match: "step 1 of 4", reply: "Codex proposal.\nTORYO: PROPOSAL" },
  ]);
  try {
    const r = await readyPlan(t);
    t.engine.control(r.id, "settings", { recheckAfterChanges: false });
    t.engine.answer(r.id, { questionId: ready(t, r.id).eventId, text: "Rename slice 1." });
    await waitFor(() => ready(t, r.id) && room(t, r.id).plan.revision === 2, { label: "ready, revised" });
    assert.equal(t.calls().filter((c) => /Check the revised plan/.test(c.prompt)).length, 0);
    assert.match(ready(t, r.id).question, /Nobody has checked it since your change: Re-check after changes is off/);
    // A round with one planner: nobody else can check.
    const solo = await readyPlan(t, { participants: ["codex"] });
    assert.deepEqual(room(t, solo.id).waiting.checkers, []);
    assert.match(ready(t, solo.id).question, /There's no other planner here to check it\./);
    assert.throws(() => t.engine.control(solo.id, "plan-check", { questionId: ready(t, solo.id).eventId }), /no other planner/);
  } finally {
    t.cleanup();
  }
});

test("a recommendation's wrapper never becomes part of the answer: (Recommended: yes to both)? is accepted as yes to both", () => {
  assert.deepEqual(splitRecommendation("Do X and Y (Recommended: yes to both)?"), { question: "Do X and Y?", recommendation: "yes to both" });
  assert.equal(acceptRecommendation(splitRecommendation("Do X and Y (Recommended: yes to both)?").recommendation), "Go with your recommendation: yes to both.");
  // Nested parentheses, quotes and its own punctuation stay.
  assert.equal(splitRecommendation('Which? (Recommended: use `run()` (the fast one), then "check".)').recommendation, 'use `run()` (the fast one), then "check".');
  assert.equal(acceptRecommendation('use `run()` (the fast one), then "check".'), 'Go with your recommendation: use `run()` (the fast one), then "check".');
  assert.equal(splitRecommendation("Tabs? (Recommended: tabs, as in “the guide (v2)”)").recommendation, "tabs, as in “the guide (v2)”");
  assert.equal(splitRecommendation("Which one? I recommend SQLite: one file.").recommendation, "SQLite: one file.");
  assert.equal(splitRecommendation("Recommended: yes to both)?").recommendation, "yes to both");
  // Quoted parentheses: single quotes, escaped double quotes, curly quotes; apostrophes aren't quotes.
  assert.deepEqual(splitRecommendation("Delimiter? (Recommended: use ')' as the closing token)?"), { question: "Delimiter?", recommendation: "use ')' as the closing token" });
  assert.equal(acceptRecommendation(splitRecommendation("Delimiter? (Recommended: use ')' as the closing token)?").recommendation), "Go with your recommendation: use ')' as the closing token.");
  assert.equal(splitRecommendation('Q? (Recommended: say "use \\"(\\" here")').recommendation, 'say "use \\"(\\" here"');
  assert.equal(splitRecommendation("Q? (Recommended: it's ')' here, don't (ever) change it)").recommendation, "it's ')' here, don't (ever) change it");
  assert.equal(splitRecommendation("Q? (Recommended: the owners' choice (theirs))?").recommendation, "the owners' choice (theirs)");
  assert.equal(splitRecommendation("Q? (Recommended: ‘it’s (here)’ then stop)").recommendation, "‘it’s (here)’ then stop");
  // A quote that's never closed is just a character.
  assert.equal(splitRecommendation("Q? (Recommended: 'tis fine) and more").recommendation, "'tis fine");
  assert.equal(acceptRecommendation("Really?"), "Go with your recommendation: Really?");
  assert.equal(acceptRecommendation(""), "Go with your recommendation.");
  assert.deepEqual(parseQuestions("- Q: Keep the old API? (Recommended: yes, for one release)\n- Q: Do X and Y (Recommended: yes to both)?\n- Q: Delimiter? (Recommended: use ')' as the closing token)?"), [
    { question: "Keep the old API?", recommendation: "yes, for one release" },
    { question: "Do X and Y?", recommendation: "yes to both" },
    { question: "Delimiter?", recommendation: "use ')' as the closing token" },
  ]);
});

test("accepting that recommendation, in a build and in chat, sends exactly “Go with your recommendation: yes to both.”", async () => {
  const t = await setup([
    // Quoted parentheses inside a recommendation: in single quotes, and in double quotes with an escaped quote.
    { agent: "codex", match: "Pick the quoting", reply: 'One choice.\nTORYO: OWNER Quoting? (Recommended: write "say \\"(\\" here" as it is)' },
    { agent: "codex", match: "Which delimiter", reply: "TORYO: OWNER Delimiter? (Recommended: use ')' as the closing token)?" },
    { agent: "codex", match: "Your role: builder", reply: "Two choices.\nTORYO: OWNER Do X and Y (Recommended: yes to both)?" },
    { agent: "codex", match: "Ask me", reply: "TORYO: OWNER Do X and Y (Recommended: yes to both)?" },
    { reply: "Noted.\nTORYO: REPLY" },
  ]);
  try {
    const build = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => room(t, build.id).waiting, { label: "builder's question" });
    assert.equal(room(t, build.id).waiting.question, "Do X and Y?");
    t.engine.answer(build.id, { questionId: room(t, build.id).waiting.eventId, accept: true });
    const chat = t.engine.createRoom({ projectId: "repo", mode: "chat", title: "c", members: ["codex"], text: "Ask me something.", to: "codex" });
    await waitFor(() => t.engine.summary(room(t, chat.id)).questions.length === 1, { label: "chat question" });
    const q = t.engine.summary(room(t, chat.id)).questions[0];
    assert.deepEqual([q.question, q.recommendation], ["Do X and Y?", "yes to both"]);
    t.engine.answer(chat.id, { questionId: q.id, accept: true });
    for (const id of [build.id, chat.id])
      assert.equal(t.engine.roomView(id).events.find((e) => e.type === "owner" && e.kind === "answer").text, "Go with your recommendation: yes to both.");
    // The whole recommendation, quoted parentheses and all: accepted in chat, and in a build.
    const delim = t.engine.createRoom({ projectId: "repo", mode: "chat", title: "d", members: ["codex"], text: "Which delimiter?", to: "codex" });
    await waitFor(() => t.engine.summary(room(t, delim.id)).questions.length === 1, { label: "delimiter question" });
    const dq = t.engine.summary(room(t, delim.id)).questions[0];
    assert.deepEqual([dq.question, dq.recommendation], ["Delimiter?", "use ')' as the closing token"]);
    t.engine.answer(delim.id, { questionId: dq.id, accept: true });
    // A build in a folder of its own: the first build is still going (one builder per folder).
    const quoting = t.engine.createRoom({ projectId: t.project("quoting"), mode: "build", task: "Pick the quoting" });
    await waitFor(() => room(t, quoting.id).waiting, { label: "quoting question" });
    assert.equal(room(t, quoting.id).waiting.recommendation, 'write "say \\"(\\" here" as it is');
    t.engine.answer(quoting.id, { questionId: room(t, quoting.id).waiting.eventId, accept: true });
    const answered = (id) => t.engine.roomView(id).events.find((e) => e.type === "owner" && e.kind === "answer").text;
    assert.equal(answered(delim.id), "Go with your recommendation: use ')' as the closing token.");
    assert.equal(answered(quoting.id), 'Go with your recommendation: write "say \\"(\\" here" as it is.');
    for (const id of [build.id, chat.id, delim.id, quoting.id]) await waitFor(() => !t.engine.summary(room(t, id)).running.length && !room(t, id).queue.length, { label: "replies" });
  } finally {
    t.cleanup();
  }
});

test("several checkers: each checks once, and all their findings reach the author in one turn", async () => {
  const t = await setup([
    { agent: "cursor", match: "step 1 of 4", reply: "Cursor proposal.\nTORYO: PROPOSAL" },
    ...round,
    { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "cursor", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "codex", match: "The owner asked for changes to the plan", write: plan("revised"), reply: `Done.\nTORYO: REVIEW ${PLAN}` },
    { agent: "claude", match: "Check the revised plan", reply: "Claude: the rollback step is missing.\nTORYO: CHANGES" },
    { agent: "cursor", match: "Check the revised plan", reply: "Cursor: slice 2 is too big for one review.\nTORYO: CHANGES" },
    { agent: "codex", match: "checked the plan, and their findings are above", write: plan("addressed"), reply: `Both fixed.\nTORYO: REVIEW ${PLAN}` },
  ]);
  t.engine.updateConfig({ agents: { cursor: { command: [process.execPath, FAKE, "cursor"] } } });
  try {
    const r = await readyPlan(t, { participants: ["codex", "claude", "cursor"] });
    assert.deepEqual(room(t, r.id).waiting.checkers, ["claude", "cursor"]);
    const before = ready(t, r.id).eventId;
    t.engine.answer(r.id, { questionId: before, text: "Add a rollback." });
    await waitFor(() => ready(t, r.id) && ready(t, r.id).eventId !== before, { label: "ready again" });
    const calls = t.calls();
    assert.deepEqual(calls.filter((c) => /Check the revised plan/.test(c.prompt)).map((c) => c.kind).sort(), ["claude", "cursor"]);
    const address = calls.filter((c) => /checked the plan, and their findings are above/.test(c.prompt));
    assert.equal(address.length, 1, "one turn for all the findings");
    assert.match(address[0].prompt, /Claude and Cursor checked the plan/);
    assert.match(address[0].prompt, /the rollback step is missing/);
    assert.match(address[0].prompt, /slice 2 is too big/);
    assert.match(ready(t, r.id).question, /Claude and Cursor asked for changes, and Codex addressed them\./);
  } finally {
    t.cleanup();
  }
});

test("a check without a verdict is never an approval: the checker is asked once for its verdict, and if none comes the card says so", async () => {
  const t = await setup([
    ...round,
    // The first check: no status line at all, and still none when asked for the verdict alone.
    { agent: "claude", match: "step 4 of 4", times: 1, reply: "Looks fine to me." },
    { agent: "claude", match: "ended without a verdict", times: 1, reply: "As I said, it looks fine." },
    // The one you ask for: a reply instead of a verdict, then the verdict when asked.
    { agent: "claude", match: "step 4 of 4", times: 1, reply: "Nothing to add.\nTORYO: REPLY" },
    { agent: "claude", match: "ended without a verdict", reply: "TORYO: APPROVED" },
  ]);
  try {
    const r = await readyPlan(t);
    const verdictAsks = () => t.calls().filter((c) => /ended without a verdict/.test(c.prompt));
    assert.equal(verdictAsks().length, 1, "asked once, not again");
    assert.ok(verdictAsks()[0].args.includes("--disallowedTools"), "still read-only");
    assert.match(ready(t, r.id).question, /Claude checked it but didn't say whether it approves\./);
    assert.doesNotMatch(ready(t, r.id).question, /approved/);
    assert.equal(room(t, r.id).plan.review.verdict, "incomplete");
    // A reply instead of a verdict: asked once more, and its approval counts.
    t.engine.control(r.id, "plan-check", { questionId: ready(t, r.id).eventId });
    await waitFor(() => ready(t, r.id) && verdictAsks().length === 2, { label: "ready after the second check" });
    assert.match(ready(t, r.id).question, /Claude checked it and approved\./);
  } finally {
    t.cleanup();
  }
});

test("a question you ask a checker while it gives its verdict is answered, and the check isn't asked for its verdict again", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "Answering your question", reply: "Yes, slice 2 is small enough.\nTORYO: REPLY" },
    { agent: "claude", match: "step 4 of 4", reply: "Looks fine." },
    { agent: "claude", match: "ended without a verdict", workMs: 1500, reply: "Still fine, as far as I can see." },
  ]);
  try {
    const r = t.engine.createRoom({ projectId: "repo", mode: "plan", topic: "P", planPath: PLAN });
    await waitFor(() => room(t, r.id).waiting?.kind === "plan-checkpoint", { label: "checkpoint" });
    t.engine.synthesize(r.id, { questionId: room(t, r.id).waiting.eventId, synthesizer: "codex", decisions: "" });
    const verdictAsks = () => t.calls().filter((c) => /ended without a verdict/.test(c.prompt));
    await waitFor(() => verdictAsks().length === 1, { label: "asked for its verdict" });
    // While Claude works on its verdict, you ask it something.
    t.engine.postMessage(r.id, { text: "Is slice 2 small enough?", to: "claude", answering: false, intent: "ask" });
    await waitFor(() => ready(t, r.id), { label: "plan ready" });
    assert.ok(t.calls().some((c) => /Answering your question/.test(c.prompt)), "your question is answered");
    assert.equal(verdictAsks().length, 1, "asked for its verdict once, not again after your answer");
    assert.match(ready(t, r.id).question, /Claude checked it but didn't say whether it approves\./);
  } finally {
    t.cleanup();
  }
});

test("with several checkers, approval needs every one of them: one without a verdict is named, beside the others' approval or findings", async () => {
  const t = await setup([
    { agent: "cursor", match: "step 1 of 4", reply: "Cursor proposal.\nTORYO: PROPOSAL" },
    ...round,
    { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "cursor", match: "step 4 of 4", reply: "Seems OK." },
    { agent: "cursor", match: "ended without a verdict", reply: "Seems OK, as I said." },
    { agent: "codex", match: "The owner asked for changes to the plan", write: plan("revised"), reply: `Done.\nTORYO: REVIEW ${PLAN}` },
    { agent: "claude", match: "Check the revised plan", reply: "The rollback step is missing.\nTORYO: CHANGES" },
    { agent: "cursor", match: "Check the revised plan", reply: "Looks fine.\nTORYO: REPLY" },
    { agent: "codex", match: "checked the plan, and their findings are above", write: plan("addressed"), reply: `Fixed.\nTORYO: REVIEW ${PLAN}` },
  ]);
  t.engine.updateConfig({ agents: { cursor: { command: [process.execPath, FAKE, "cursor"] } } });
  try {
    const r = await readyPlan(t, { participants: ["codex", "claude", "cursor"] });
    assert.match(ready(t, r.id).question, /Claude checked it and approved\. Cursor checked it but didn't say whether it approves\./);
    assert.equal(room(t, r.id).plan.review.verdict, "incomplete");
    const before = ready(t, r.id).eventId;
    t.engine.answer(r.id, { questionId: before, text: "Add a rollback." });
    await waitFor(() => ready(t, r.id) && ready(t, r.id).eventId !== before, { label: "ready again" });
    // Claude's findings go to Codex; Cursor, asked once for its verdict, gave none.
    const address = t.calls().filter((c) => /checked the plan, and their findings are above/.test(c.prompt));
    assert.equal(address.length, 1);
    assert.match(address[0].prompt, /Claude checked the plan/);
    assert.match(ready(t, r.id).question, /Claude asked for changes, and Codex addressed them\. Cursor checked it but didn't say whether it approves\./);
    assert.equal(t.calls().filter((c) => c.kind === "cursor" && /ended without a verdict/.test(c.prompt)).length, 2, "once for each check");
  } finally {
    t.cleanup();
  }
});

test("a checker's question comes back to that checker, still read-only, and the cycle carries on", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", times: 1, reply: "Fine.\nTORYO: APPROVED" },
    { agent: "claude", match: "step 4 of 4", times: 1, reply: "Before I go on.\nTORYO: OWNER Should slice 2 keep the old API?" },
    { agent: "claude", match: "The owner answered|answered your question|Keep it", reply: "Then it's fine.\nTORYO: APPROVED" },
  ]);
  try {
    const r = await readyPlan(t);
    t.engine.control(r.id, "plan-check", { questionId: ready(t, r.id).eventId });
    await waitFor(() => room(t, r.id).waiting?.kind === "plan-owner", { label: "the checker's question" });
    assert.equal(room(t, r.id).waiting.from, "claude");
    t.engine.answer(r.id, { questionId: room(t, r.id).waiting.eventId, text: "Keep it." });
    await waitFor(() => ready(t, r.id), { label: "ready after the check" });
    const resumed = t.calls().filter((c) => c.kind === "claude").at(-1);
    assert.match(resumed.prompt, /Keep it\./);
    assert.ok(resumed.args.includes("--disallowedTools"), "still read-only");
    assert.match(ready(t, r.id).question, /Claude checked it and approved\./);
    assert.ok(!t.calls().some((c) => c.kind === "codex" && /Revise|revise/.test(c.prompt.split("\n").slice(-3).join("\n"))));
  } finally {
    t.cleanup();
  }
});

test("your discussion of a ready plan with another planner goes to the author once, as a change request with each message and who said it, and enters the same cycle", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    // First: the re-check's prompt quotes the forwarded discussion, which the chat rules below would match.
    { agent: "claude", match: "Check the revised plan", reply: "Good.\nTORYO: APPROVED" },
    { agent: "claude", match: "What would you change", reply: "I'd move the migration into slice 1.\nTORYO: REPLY" },
    { agent: "claude", match: "And the docs", reply: "Docs can wait for slice 2.\nTORYO: REPLY" },
    { agent: "codex", match: "The owner asked for changes to the plan", write: plan("forwarded"), reply: `Moved it.\nTORYO: REVIEW ${PLAN}` },
  ]);
  try {
    const r = await readyPlan(t);
    const card = ready(t, r.id).eventId;
    const ask = (text) => t.engine.postMessage(r.id, { text, to: "claude", answering: false }).event.id;
    const q1 = ask("What would you change in the plan?");
    await waitFor(() => turns(t.engine, r.id).some((x) => x.agent === "claude" && /migration/.test(x.text ?? "")), { label: "first reply" });
    const q2 = ask("And the docs?");
    await waitFor(() => turns(t.engine, r.id).some((x) => x.agent === "claude" && /Docs can wait/.test(x.text ?? "")), { label: "second reply" });
    const replies = turns(t.engine, r.id).filter((x) => x.agent === "claude" && x.kind === "chat").map((x) => x.id);
    // Nothing to forward from the author, or with someone you haven't talked to.
    assert.throws(() => t.engine.control(r.id, "forward-discussion", { questionId: card, agent: "codex" }), /other than the author/);
    t.engine.control(r.id, "forward-discussion", { questionId: card, agent: "claude" });
    // A second click: refused, so it reaches the author once.
    assert.throws(() => t.engine.control(r.id, "forward-discussion", { questionId: card, agent: "claude" }), (e) => e.status === 409);
    const request = t.engine.roomView(r.id).events.find((e) => e.kind === "change-request");
    assert.deepEqual(request.to, ["codex"]);
    assert.deepEqual(request.forwarded, [{ id: q1, from: "owner" }, { id: replies[0], from: "claude" }, { id: q2, from: "owner" }, { id: replies[1], from: "claude" }]);
    for (const id of [q1, replies[0], q2, replies[1]]) assert.ok(request.text.includes(`[${id}]`));
    assert.match(request.text, /\*\*The owner \(to Claude\)\*\* \[[^\]]+\]:\n> What would you change in the plan\?/);
    assert.match(request.text, /\*\*Claude\*\* \[[^\]]+\]:\n> I'd move the migration into slice 1\./);
    assert.doesNotMatch(request.text, /TORYO: REPLY/);
    // Your words are yours; the planner's are suggestions.
    assert.match(request.text, /What the owner says there is the owner's; Claude's replies are a planner's suggestions, which count as decisions only where the owner agreed with them\./);
    await waitFor(() => ready(t, r.id) && ready(t, r.id).eventId !== card, { label: "ready again" });
    const revise = t.calls().find((c) => c.kind === "codex" && /The owner asked for changes to the plan/.test(c.prompt));
    // Once: in the change request, not again from the room.
    assert.equal(revise.prompt.split("I'd move the migration into slice 1.").length - 1, 1);
    assert.equal(revise.prompt.split("What would you change in the plan?").length - 1, 1);
    assert.equal(t.calls().filter((c) => /Check the revised plan/.test(c.prompt)).length, 1, "the same cycle: one check of the revision");
    assert.match(ready(t, r.id).question, /Claude checked it and approved\./);
  } finally {
    t.cleanup();
  }
});

test("your answers to the planner's questions are part of the discussion: forwarded with what they answered, by the exchange or by their ids", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "claude", match: "Check the revised plan", reply: "Good.\nTORYO: APPROVED" },
    { agent: "claude", match: "Keep SQLite", reply: "Understood: SQLite stays.\nTORYO: REPLY" },
    { agent: "claude", match: "What would you change", reply: "Redis would make the cache faster.\nTORYO: OWNER Switch the cache to Redis?" },
    { agent: "codex", match: "The owner asked for changes to the plan", write: plan("forwarded"), reply: `Kept SQLite.\nTORYO: REVIEW ${PLAN}` },
  ]);
  try {
    const r = await readyPlan(t);
    const card = ready(t, r.id).eventId;
    const note = t.engine.postMessage(r.id, { text: "What would you change in the plan?", to: "claude", answering: false }).event.id;
    await waitFor(() => t.engine.summary(room(t, r.id)).questions.some((q) => q.from === "claude"), { label: "Claude's question" });
    const asked = t.engine.summary(room(t, r.id)).questions.find((q) => q.from === "claude");
    assert.equal(asked.question, "Switch the cache to Redis?");
    t.engine.answer(r.id, { questionId: asked.id, text: "No. Keep SQLite." });
    await waitFor(() => turns(t.engine, r.id).some((x) => /SQLite stays/.test(x.text ?? "")), { label: "Claude's acknowledgement" });
    const events = t.engine.roomView(r.id).events;
    const answer = events.find((e) => e.type === "owner" && e.kind === "answer" && /Keep SQLite/.test(e.text));
    const [suggestion, ack] = turns(t.engine, r.id).filter((x) => x.agent === "claude" && /Redis|SQLite stays/.test(x.text ?? "")).map((x) => x.id);
    t.engine.control(r.id, "forward-discussion", { questionId: card, agent: "claude" });
    const request = t.engine.roomView(r.id).events.find((e) => e.kind === "change-request");
    assert.deepEqual(request.forwarded, [{ id: note, from: "owner" }, { id: suggestion, from: "claude" }, { id: answer.id, from: "owner" }, { id: ack, from: "claude" }]);
    assert.match(request.text, /\*\*Claude\*\* \[[^\]]+\]:\n> Redis would make the cache faster\.\n>\n> \(Question for the owner: Switch the cache to Redis\?\)/);
    assert.ok(request.text.includes(`**The owner (answering Claude: “Switch the cache to Redis?”)** [${answer.id}]:\n> No. Keep SQLite.`));
    await waitFor(() => ready(t, r.id) && ready(t, r.id).eventId !== card, { label: "ready again" });
    const revise = t.calls().find((c) => c.kind === "codex" && /The owner asked for changes to the plan/.test(c.prompt));
    assert.equal(revise.prompt.split("No. Keep SQLite.").length - 1, 1, "your answer reaches the author once");
    assert.match(ready(t, r.id).question, /Claude checked it and approved\./);
    // Named by its id, your answer alone can be forwarded too.
    const second = ready(t, r.id).eventId;
    t.engine.control(r.id, "forward-discussion", { questionId: second, eventIds: [answer.id] });
    const again = t.engine.roomView(r.id).events.filter((e) => e.kind === "change-request").at(-1);
    assert.deepEqual(again.forwarded, [{ id: answer.id, from: "owner" }]);
    await waitFor(() => ready(t, r.id) && ready(t, r.id).eventId !== second, { label: "ready after the second" });
  } finally {
    t.cleanup();
  }
});

test("the plan file changing while it's checked: the ready card says the check was of an earlier version", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", times: 1, reply: "Fine.\nTORYO: APPROVED" },
    { agent: "claude", match: "step 4 of 4", workMs: 1500, reply: "Fine.\nTORYO: APPROVED" },
  ]);
  try {
    const r = await readyPlan(t);
    t.engine.control(r.id, "plan-check", { questionId: ready(t, r.id).eventId });
    await waitFor(() => t.engine.summary(room(t, r.id)).running.includes("claude"), { label: "checking" });
    writeFileSync(join(t.repo, PLAN), "# P (edited by hand)\n");
    await waitFor(() => ready(t, r.id), { label: "ready" });
    assert.match(ready(t, r.id).question, /Claude checked it and approved\. That check was of an earlier version: the plan file changed while it ran\./);
    assert.ok(t.engine.roomView(r.id).events.some((e) => e.type === "system" && /changed while Claude checked it/.test(e.text)));
  } finally {
    t.cleanup();
  }
});

test("a restart in the middle of the cycle carries on where it was; a hold makes the check wait without skipping it", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "codex", match: "The owner asked for changes to the plan", write: plan("revised"), reply: `Done.\nTORYO: REVIEW ${PLAN}` },
    { agent: "claude", match: "Check the revised plan", times: 1, hang: true },
    { agent: "claude", match: "Check the revised plan", reply: "A finding.\nTORYO: CHANGES" },
    { agent: "codex", match: "checked the plan, and their findings are above", write: plan("addressed"), reply: `Fixed.\nTORYO: REVIEW ${PLAN}` },
  ]);
  try {
    const r = await readyPlan(t);
    t.engine.answer(r.id, { questionId: ready(t, r.id).eventId, text: "Change it." });
    // Wait until Claude has read the check (the fake logs it), so the restart cuts a check that started.
    await waitFor(() => t.calls().some((c) => c.kind === "claude" && /Check the revised plan/.test(c.prompt)), { label: "the re-check running" });
    // The desk stops mid-check, and starts again.
    t.engine.shutdown();
    await waitFor(() => t.engine.running.size === 0, { label: "stopped" });
    t.engine = await t.make();
    // As after any restart with a turn cut off: the room waits for you to resume it, then runs the turn again.
    assert.equal(room(t, r.id).plan.cycle.stage, "check");
    t.engine.deskControl("hold", { target: "claude" });
    t.engine.control(r.id, "resume");
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(room(t, r.id).plan.cycle.stage, "check");
    assert.ok(!t.engine.summary(room(t, r.id)).running.length, "held: the check waits");
    t.engine.deskControl("release", { target: "claude" });
    await waitFor(() => ready(t, r.id), { label: "ready after the restart" });
    assert.match(ready(t, r.id).question, /Claude asked for changes, and Codex addressed them\./);
    const rerun = t.calls().filter((c) => c.kind === "claude" && /Check the revised plan/.test(c.prompt));
    assert.equal(rerun.length, 2, "the same check, run again");
    assert.match(rerun[1].prompt, /Toryo restarted while you were working/);
    assert.equal(t.calls().filter((c) => /checked the plan, and their findings are above/.test(c.prompt)).length, 1);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("Stop ends the cycle (a check finishing late changes nothing), Resume brings the ready card back; switching mode drops the cycle too", async () => {
  const t = await setup([
    ...round,
    { agent: "claude", match: "step 4 of 4", times: 1, reply: "Fine.\nTORYO: APPROVED" },
    { agent: "claude", match: "step 4 of 4", workMs: 1200, reply: "Needs work.\nTORYO: CHANGES" },
  ]);
  try {
    const r = await readyPlan(t);
    t.engine.control(r.id, "plan-check", { questionId: ready(t, r.id).eventId });
    await waitFor(() => t.engine.summary(room(t, r.id)).running.includes("claude"), { label: "checking" });
    t.engine.control(r.id, "stop");
    await waitFor(() => !t.engine.summary(room(t, r.id)).running.length, { label: "stopped" });
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(!t.calls().some((c) => /findings are above/.test(c.prompt)), "no revision from a stopped check");
    t.engine.control(r.id, "resume");
    assert.match(ready(t, r.id).question, /The check was stopped before it finished\./);
    // Switching to chat while a check runs: its late result drives nothing.
    t.engine.control(r.id, "plan-check", { questionId: ready(t, r.id).eventId });
    await waitFor(() => t.engine.summary(room(t, r.id)).running.includes("claude"), { label: "checking again" });
    t.engine.control(r.id, "chat-mode");
    await waitFor(() => !t.engine.summary(room(t, r.id)).running.length, { label: "the late check" });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(room(t, r.id).mode, "chat");
    assert.ok(!t.calls().some((c) => /findings are above/.test(c.prompt)));
    assert.equal(room(t, r.id).waiting, null);
  } finally {
    t.cleanup();
  }
});

test("the same actions from the API, the command line and MCP: each names the Ready card, and an older one is refused", async () => {
  await withServer(
    [
      ...round,
      { agent: "claude", match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
      { agent: "claude", match: "Check the revised plan", reply: "Good.\nTORYO: APPROVED" },
      { agent: "claude", match: "Anything missing", reply: "Slice 2 needs a test.\nTORYO: REPLY" },
      { agent: "codex", match: "The owner asked for changes to the plan", write: plan("forwarded"), reply: `Added it.\nTORYO: REVIEW ${PLAN}` },
    ],
    async (t) => {
      const { client, post, home } = t;
      const r = await readyPlan(t);
      const card = ready(t, r.id).eventId;
      await assert.rejects(client.plan(undefined, "build"), /Usage: toryo plan check\|forward/);
      // Over HTTP, each names its card.
      for (const action of ["plan-check", "forward-discussion"]) {
        const unnamed = await post(`/api/rooms/${r.id}/control`, { action, agent: "claude" });
        assert.equal(unnamed.status, 400);
        assert.match(unnamed.body.error, /which question/);
      }
      // From the command line, with one plan ready, the card can be left out.
      assert.match(await client.plan(undefined, "check"), /Asked Claude to check the plan in/);
      await waitFor(() => ready(t, r.id) && ready(t, r.id).eventId !== card, { label: "ready after the check" });
      // The card it acted on has gone: naming it again is refused, and nothing more is checked.
      await assert.rejects(client.plan(undefined, "check", { question: card }), /has moved on/);
      const stale = await post(`/api/rooms/${r.id}/control`, { action: "plan-check", questionId: card });
      assert.equal(stale.status, 409);
      assert.equal(t.calls().filter((c) => /step 4 of 4/.test(c.prompt)).length, 2);

      t.engine.postMessage(r.id, { text: "Anything missing?", to: "claude", answering: false });
      await waitFor(() => turns(t.engine, r.id).some((x) => /needs a test/.test(x.text ?? "")), { label: "Claude's reply" });
      const m = mcp(home);
      try {
        // Claude is the only other planner, so MCP needn't say whose discussion it is.
        const sent = await m.call("toryo_plan", { action: "forward" });
        assert.ok(!sent.error, sent.text);
        assert.match(sent.text, /Sent your discussion with Claude to Codex as a change request/);
        const again = await m.call("toryo_plan", { action: "forward" });
        assert.ok(again.error);
        assert.match(again.text, /No plan is ready/);
      } finally {
        m.close();
      }
      await waitFor(() => ready(t, r.id), { label: "ready after the forwarded change" });
      assert.match(ready(t, r.id).question, /Claude checked it and approved\./);
      assert.equal(t.engine.roomView(r.id).events.filter((e) => e.kind === "change-request").length, 1);
    },
  );
});
