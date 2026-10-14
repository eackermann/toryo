import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToryoClient } from "../src/client.mjs";
import { mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const open = (engine, id) => engine.summary(engine.rooms.get(id)).questions;
const idle = (engine, id) => !engine.summary(engine.rooms.get(id)).running.length && !engine.rooms.get(id).queue.length;
const answers = (engine, id) => engine.roomView(id).events.filter((e) => e.type === "owner" && e.kind === "answer");

test("two clients answer the same question: one answer counts, every other client is refused and nothing else is queued", async () => {
  await withServer(
    [
      { agent: "codex", match: "The owner answered", times: 1, reply: "Using tabs.\nTORYO: OWNER Line length?" },
      { agent: "codex", match: "The owner answered", reply: "Done.\nTORYO: OWNER Anything else?" },
      { agent: "codex", match: "Your role: builder", reply: "Question first.\nI recommend tabs.\nTORYO: OWNER Tabs or spaces?" },
    ],
    async ({ engine, home, post, client, calls }) => {
      const room = engine.createRoom({ projectId: "repo", mode: "build", task: "Format the files" });
      await waitFor(() => engine.rooms.get(room.id).waiting, { label: "first question" });
      const [first] = open(engine, room.id);
      assert.equal(first.question, "Tabs or spaces?");
      // When it was asked, so a client can go to the oldest question first.
      assert.equal(first.at, engine.roomView(room.id).events.find((e) => e.id === first.id).at);

      // Over HTTP an answer must say which question it answers.
      const unnamed = await post(`/api/rooms/${room.id}/answer`, { accept: true });
      assert.equal(unnamed.status, 400);
      assert.match(unnamed.body.error, /which question/);
      assert.equal(engine.rooms.get(room.id).waiting.eventId, first.id);

      // Two clients answer it at once: one wins, the other is told it was already answered.
      const both = await Promise.all([post(`/api/rooms/${room.id}/answer`, { accept: true, questionId: first.id }), post(`/api/rooms/${room.id}/answer`, { text: "Spaces.", questionId: first.id })]);
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
      assert.match(both.find((r) => r.status === 409).body.error, /already been answered/);
      await waitFor(() => engine.rooms.get(room.id).waiting?.question === "Line length?", { label: "the next question" });
      const [second] = open(engine, room.id);

      // Written to the old screen: the page's note naming the first question, the CLI and MCP naming it by id. None
      // lands on the newer question, and nothing is sent.
      const fromPage = await post(`/api/rooms/${room.id}/messages`, { text: "Spaces after all.", to: "codex", answering: first.id });
      assert.equal(fromPage.status, 409);
      const overHttp = await post(`/api/rooms/${room.id}/answer`, { text: "Spaces after all.", questionId: first.id });
      assert.equal(overHttp.status, 409);
      await assert.rejects(client.answer(undefined, "Spaces after all.", { question: first.id }), /already been answered/);
      const m = mcp(home);
      try {
        const stale = await m.call("toryo_answer", { text: "Spaces after all.", question: first.id });
        assert.ok(stale.error);
        assert.match(stale.text, /already been answered/);
        assert.equal(engine.rooms.get(room.id).waiting.eventId, second.id);
        assert.equal(answers(engine, room.id).length, 1);
        assert.equal(calls().filter((c) => /The owner answered/.test(c.prompt)).length, 1);
        assert.ok(!engine.roomView(room.id).events.some((e) => e.type === "owner" && /after all/.test(e.text)));

        // Status and room text show each open question with the id that answers it.
        assert.match(await client.statusText(), new RegExp(`Codex asks: Line length\\? \\[id ${second.id}\\]`));
        assert.match((await m.call("toryo_room", {})).text, new RegExp(`WAITING FOR YOU: Codex asks: Line length\\? \\[id ${second.id}\\]`));

        // With one question open, the CLI and MCP may leave the id out: they look it up and send it.
        assert.match((await m.call("toryo_answer", { text: "100 columns." })).text, /Answered in .*: Line length\?/);
      } finally {
        m.close();
      }
      await waitFor(() => engine.rooms.get(room.id).waiting?.question === "Anything else?", { label: "answered and continued" });
      assert.deepEqual(answers(engine, room.id).map((e) => e.text).slice(1), ["100 columns."]);
      assert.equal(calls().filter((c) => /The owner answered/.test(c.prompt)).length, 2);
    },
  );
});

test("with no room named, the CLI answers the only open question anywhere; with questions in several rooms it asks which", async () => {
  await withServer([{ agent: "codex", reply: "TORYO: OWNER Which colour?" }], async ({ engine, client }) => {
    const a = engine.createRoom({ projectId: "repo", mode: "chat", title: "First", members: ["codex"], text: "Ask me.", to: "codex" });
    await waitFor(() => open(engine, a.id).length === 1 && idle(engine, a.id), { label: "first question" });
    const b = engine.createRoom({ projectId: "repo", mode: "chat", title: "Second", members: ["codex"], text: "Ask me too.", to: "codex" });
    await waitFor(() => open(engine, b.id).length === 1 && idle(engine, b.id), { label: "second question" });
    const [qa] = open(engine, a.id);
    const [qb] = open(engine, b.id);
    // The second room is the latest, but a question is open in the first too: nothing is sent, and both are listed.
    await assert.rejects(client.answer(undefined, "Red."), (e) => /2 questions are open/.test(e.message) && e.message.includes(`“First”: Codex asks: Which colour? [id ${qa.id}]`) && e.message.includes(`“Second”: Codex asks: Which colour? [id ${qb.id}]`));
    assert.equal(answers(engine, a.id).length + answers(engine, b.id).length, 0);
    // Named by id alone, it's found in its room.
    assert.match(await client.answer(undefined, "Red.", { question: qa.id }), /Answered in “First”/);
    assert.deepEqual(open(engine, a.id), []);
    assert.deepEqual(open(engine, b.id).map((q) => q.id), [qb.id]);
    await waitFor(() => idle(engine, a.id) && open(engine, a.id).length === 1, { label: "first room asked again" });
    await assert.rejects(client.answer(undefined, "Red.", { question: qa.id }), /already been answered/);
  });
});

test("several open questions from one agent: a plain note closes none of them, and each answer closes only its own", async () => {
  await withServer(
    [
      { agent: "codex", match: "Pick a colour", delayMs: 400, reply: "I recommend blue.\nTORYO: OWNER Which colour?" },
      { agent: "codex", match: "Pick a size", reply: "TORYO: OWNER Which size?" },
      { agent: "codex", reply: "Noted.\nTORYO: REPLY" },
    ],
    async ({ engine, post, client }) => {
      const room = engine.createRoom({ projectId: "repo", mode: "chat", title: "chat", members: ["codex"], text: "Pick a colour for the logo.", to: "codex" });
      await waitFor(() => engine.summary(engine.rooms.get(room.id)).running.includes("codex"), { label: "codex working" });
      engine.postMessage(room.id, { text: "Pick a size too.", to: "codex" });
      await waitFor(() => open(engine, room.id).length === 2 && !engine.summary(engine.rooms.get(room.id)).running.length, { label: "two questions" });
      const [colour, size] = open(engine, room.id);
      assert.deepEqual([colour.question, size.question], ["Which colour?", "Which size?"]);
      assert.equal(colour.recommendation, "blue.");

      // Which one a plain note answers isn't clear, so both stay open (the CLI won't guess either).
      engine.postMessage(room.id, { text: "Hold on, thinking.", to: "codex" });
      assert.deepEqual(open(engine, room.id).map((q) => q.id), [colour.id, size.id]);
      const before = engine.roomView(room.id).events.length;
      await assert.rejects(client.answer(room.id, "Large."), (e) => /2 questions are open/.test(e.message) && e.message.includes(`[id ${colour.id}]`) && e.message.includes(`[id ${size.id}]`));
      assert.equal(engine.roomView(room.id).events.length, before);

      // The second question, answered by id: the first stays open.
      assert.equal((await post(`/api/rooms/${room.id}/answer`, { text: "Large.", questionId: size.id })).status, 200);
      assert.deepEqual(open(engine, room.id).map((q) => q.id), [colour.id]);
      // The page's "Use the recommendation" names its card's question too.
      const accepted = await post(`/api/rooms/${room.id}/answer`, { accept: true, questionId: colour.id });
      assert.equal(accepted.status, 200);
      assert.deepEqual(open(engine, room.id), []);
      const closed = engine.roomView(room.id).events.filter((e) => e.type === "question");
      assert.deepEqual(closed.map((q) => q.answer), ["Go with your recommendation: blue.", "Large."]);
      assert.equal((await post(`/api/rooms/${room.id}/answer`, { accept: true, questionId: colour.id })).status, 409);
      await waitFor(() => idle(engine, room.id), { label: "replies done" });
    },
  );
});

test("a note answering one of several questions from the page closes that one, and a plain note to an agent with one question still answers it", async () => {
  const t = await setup([
    { agent: "codex", match: "Pick a colour", delayMs: 400, reply: "TORYO: OWNER Which colour?" },
    { agent: "codex", match: "Pick a size", reply: "TORYO: OWNER Which size?" },
    { agent: "codex", reply: "Noted.\nTORYO: REPLY" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", title: "chat", members: ["codex"], text: "Pick a colour.", to: "codex" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("codex"), { label: "codex working" });
    t.engine.postMessage(room.id, { text: "Pick a size.", to: "codex" });
    await waitFor(() => open(t.engine, room.id).length === 2 && !t.engine.summary(t.engine.rooms.get(room.id)).running.length, { label: "two questions" });
    const [colour, size] = open(t.engine, room.id);
    const { routed } = t.engine.postMessage(room.id, { text: "Small.", to: "codex", answering: size.id });
    assert.match(routed.why, /answer/);
    assert.deepEqual(open(t.engine, room.id).map((q) => q.id), [colour.id]);
    await waitFor(() => !t.engine.summary(t.engine.rooms.get(room.id)).running.length && !t.engine.rooms.get(room.id).queue.length, { label: "reply" });
    // Now the colour question is codex's only one: a plain note to it answers it.
    t.engine.postMessage(room.id, { text: "Red.", to: "codex" });
    assert.deepEqual(open(t.engine, room.id), []);
    assert.deepEqual(t.engine.roomView(room.id).events.filter((e) => e.type === "question").map((q) => q.answer), ["Red.", "Small."]);
    assert.throws(() => t.engine.postMessage(room.id, { text: "Blue.", to: "codex", answering: colour.id }), (e) => e.status === 409);
    await waitFor(() => idle(t.engine, room.id), { label: "replies done" });
  } finally {
    t.cleanup();
  }
});

test("two planners' questions: answering the later one by id leaves the earlier one waiting", async () => {
  await withServer(
    [
      { agent: "codex", match: "step 1 of 4", times: 1, reply: "Need input.\nTORYO: OWNER Codex question?" },
      { agent: "claude", match: "step 1 of 4", times: 1, reply: "Need input too.\nTORYO: OWNER Claude question?" },
      { agent: "codex", match: "step 1 of 4", reply: "Codex proposal.\nTORYO: PROPOSAL" },
      { agent: "claude", match: "step 1 of 4", reply: "Claude proposal.\nTORYO: PROPOSAL" },
      { reply: "Critique.\nTORYO: CRITIQUE" },
    ],
    async ({ engine, post }) => {
      const room = engine.createRoom({ projectId: "repo", mode: "plan", topic: "Storage" });
      await waitFor(() => open(engine, room.id).length === 2, { label: "two questions" });
      const [first, later] = open(engine, room.id);
      assert.equal((await post(`/api/rooms/${room.id}/answer`, { text: "Answer to the later one.", questionId: later.id })).status, 200);
      await waitFor(() => engine.rooms.get(room.id).plan.pending.length === 1, { label: "that planner carried on" });
      assert.deepEqual(open(engine, room.id).map((q) => q.id), [first.id]);
      assert.deepEqual(engine.rooms.get(room.id).plan.pending, [first.from]);
      await waitFor(() => idle(engine, room.id), { label: "proposal done" });
    },
  );
});

test("a retry or a planning decision sent twice, or to a question that has moved on, is refused; an unknown author and missing recommendations too", async () => {
  await withServer(
    [
      { agent: "codex", match: "Your role: builder", times: 4, fail: true },
      { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER fine?" },
      { agent: "codex", match: "step 1 of 4", reply: "Codex proposal.\n- Q: Use SQLite? (Recommended: yes)\nTORYO: PROPOSAL" },
      { agent: "claude", match: "step 1 of 4", reply: "Claude proposal.\n- Q: Ship a CLI too?\nTORYO: PROPOSAL" },
      { match: "step 2 of 4", reply: "Critique.\nTORYO: CRITIQUE" },
      { match: "step 3 of 4", delayMs: 300, write: { path: "docs/plans/p.md", content: "# P\n\n### Slice 1: One\n" }, reply: "Written.\nTORYO: REVIEW docs/plans/p.md" },
      { match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    ],
    async ({ engine, post, calls }) => {
      // Retry, pressed in two places at once.
      const build = engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
      await waitFor(() => engine.rooms.get(build.id).waiting?.kind === "error", { label: "failed turn" });
      const failed = engine.rooms.get(build.id).waiting.eventId;
      const retries = await Promise.all([1, 2].map(() => post(`/api/rooms/${build.id}/control`, { action: "retry", questionId: failed })));
      assert.deepEqual(retries.map((r) => r.status).sort(), [200, 409]);
      // It failed again: a Retry still aimed at the first failure must not retry the new one.
      await waitFor(() => engine.rooms.get(build.id).waiting?.kind === "error" && engine.rooms.get(build.id).waiting.eventId !== failed, { label: "failed again" });
      const again = engine.rooms.get(build.id).waiting.eventId;
      assert.equal((await post(`/api/rooms/${build.id}/control`, { action: "retry", questionId: failed })).status, 409);
      // Over HTTP, a Retry must say which failure it's for: an unnamed one would take whichever is open now.
      assert.equal((await post(`/api/rooms/${build.id}/control`, { action: "retry" })).status, 400);
      assert.equal(engine.rooms.get(build.id).waiting?.eventId, again);
      assert.equal((await post(`/api/rooms/${build.id}/control`, { action: "retry", questionId: again })).status, 200);
      await waitFor(() => engine.rooms.get(build.id).waiting?.question === "fine?", { label: "retried" });
      assert.equal(calls().filter((c) => /Your role: builder/.test(c.prompt)).length, 5);

      // Planning: the checkpoint waits for your call.
      const plan = engine.createRoom({ projectId: "repo", mode: "plan", topic: "Storage", planPath: "docs/plans/p.md" });
      await waitFor(() => engine.rooms.get(plan.id).waiting?.kind === "plan-checkpoint", { label: "checkpoint" });
      const checkpoint = engine.rooms.get(plan.id).waiting.eventId;
      // Unnamed (an old planning form, say): refused over HTTP, and the checkpoint stays open.
      for (const action of ["synthesize", "accept-checkpoint"]) {
        const unnamed = await post(`/api/rooms/${plan.id}/control`, { action, synthesizer: "claude", decisions: "From an old form." });
        assert.equal(unnamed.status, 400);
        assert.match(unnamed.body.error, /which question/);
      }
      assert.equal(engine.rooms.get(plan.id).waiting?.eventId, checkpoint);
      // Not every question has a recommendation: accepting them all can't be done.
      const missing = await post(`/api/rooms/${plan.id}/control`, { action: "accept-checkpoint", questionId: checkpoint });
      assert.equal(missing.status, 400);
      assert.match(missing.body.error, /“Ship a CLI too\?”/);
      // An author who isn't one of the planners.
      const stranger = await post(`/api/rooms/${plan.id}/control`, { action: "synthesize", questionId: checkpoint, synthesizer: "grok", decisions: "x" });
      assert.equal(stranger.status, 400);
      assert.equal(engine.rooms.get(plan.id).waiting?.eventId, checkpoint);
      assert.equal(engine.rooms.get(plan.id).plan.phase, "checkpoint");

      // Two submissions at once: one plan is written.
      const both = await Promise.all(["SQLite: yes.", "SQLite: no."].map((decisions) => post(`/api/rooms/${plan.id}/control`, { action: "synthesize", questionId: checkpoint, synthesizer: "claude", decisions })));
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
      // And one more, after the round moved on.
      assert.equal((await post(`/api/rooms/${plan.id}/control`, { action: "accept-checkpoint", questionId: checkpoint })).status, 409);
      await waitFor(() => engine.rooms.get(plan.id).waiting?.kind === "plan-ready", { label: "plan written" });
      const writes = calls().filter((c) => /step 3 of 4/.test(c.prompt));
      assert.equal(writes.length, 1);
      assert.equal(writes[0].kind, "claude");
      assert.equal(engine.roomView(plan.id).events.filter((e) => e.kind === "decisions").length, 1);
    },
  );
});

test("accepting every planning recommendation records each choice as shown, with the default author or the one you pick", async () => {
  for (const pick of [undefined, "claude"]) {
    const t = await setup([
      { agent: "codex", match: "step 1 of 4", reply: "Codex proposal.\n- Q: Use SQLite? (Recommended: yes)\nTORYO: PROPOSAL" },
      { agent: "claude", match: "step 1 of 4", reply: "Claude proposal.\n- Q: Ship a CLI too? (Recommended: no, later)\nTORYO: PROPOSAL" },
      { match: "step 2 of 4", reply: "Critique.\nTORYO: CRITIQUE" },
      { match: "step 3 of 4", write: { path: "docs/plans/p.md", content: "# P\n\n### Slice 1: One\n" }, reply: "Written.\nTORYO: REVIEW docs/plans/p.md" },
      { match: "step 4 of 4", reply: "Fine.\nTORYO: APPROVED" },
    ]);
    try {
      const room = t.engine.createRoom({ projectId: "repo", mode: "plan", topic: "Storage", planPath: "docs/plans/p.md" });
      await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "plan-checkpoint", { label: "checkpoint" });
      const checkpoint = t.engine.rooms.get(room.id).waiting.eventId;
      // The CLI's --accept (no author: the default), or the page's button (the author picked in the form).
      if (pick) t.engine.control(room.id, "accept-checkpoint", { questionId: checkpoint, synthesizer: pick });
      else t.engine.answer(room.id, { accept: true, questionId: checkpoint });
      const author = pick ?? t.engine.rooms.get(room.id).crew.builder;
      assert.equal(t.engine.rooms.get(room.id).plan.synthesizer, author);
      await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "plan-ready", { label: "plan written" });
      const recorded = [...t.engine.roomView(room.id).events.find((e) => e.kind === "decisions").text.split("\n")].slice(1).sort();
      assert.deepEqual(recorded, ["- Ship a CLI too? → no, later (Claude's recommendation)", "- Use SQLite? → yes (Codex's recommendation)"]);
      const write = t.calls().find((c) => /step 3 of 4/.test(c.prompt));
      assert.equal(write.kind, author);
      assert.match(write.prompt, /Use SQLite\? → yes \(Codex's recommendation\)/);
      const closed = t.engine.roomView(room.id).events.find((e) => e.id === checkpoint);
      assert.equal(closed.open, false);
      assert.match(closed.answer, /Ship a CLI too\? → no, later/);
    } finally {
      t.cleanup();
    }
  }
});

test("an answer to an agent you're holding is accepted and waits in the queue; it starts only once you release the agent", async () => {
  await withServer(
    [
      { agent: "codex", match: "The owner answered", reply: "Using tabs.\nTORYO: OWNER Anything else?" },
      { agent: "codex", match: "Your role: builder", reply: "I recommend tabs.\nTORYO: OWNER Tabs or spaces?" },
    ],
    async ({ engine, post, calls }) => {
      const room = engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
      await waitFor(() => engine.rooms.get(room.id).waiting, { label: "question" });
      const [q] = open(engine, room.id);
      engine.deskControl("hold", { target: "codex" });
      assert.equal((await post(`/api/rooms/${room.id}/answer`, { accept: true, questionId: q.id })).status, 200);
      assert.deepEqual(open(engine, room.id), []);
      assert.equal(answers(engine, room.id).length, 1);
      await new Promise((r) => setTimeout(r, 400));
      const s = engine.summary(engine.rooms.get(room.id));
      assert.deepEqual(s.running, []);
      assert.deepEqual(s.blocked.map((b) => [b.agent, b.kind]), [["codex", "build-answer"]]);
      assert.equal(calls().length, 1);
      engine.deskControl("release", { target: "codex" });
      await waitFor(() => engine.rooms.get(room.id).waiting?.question === "Anything else?", { label: "released and answered" });
      assert.deepEqual(turns(engine, room.id).map((x) => x.kind), ["build", "build-answer"]);
    },
  );
});

test("against a desk started before this update (no question ids yet), the CLI and MCP refuse a named question and otherwise answer as they used to", async () => {
  const home = mkdtempSync(join(tmpdir(), "toryo-old-desk-"));
  const posted = [];
  const room = { id: "r1", title: "Old room", mode: "build", status: "waiting", running: [], waiting: { from: "codex", question: "Tabs or spaces?", kind: "build-owner" }, waitingCount: 1 };
  const desk = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "POST") posted.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/api/state" ? { rooms: [room], agents: {} } : {}));
    });
  });
  await new Promise((r) => desk.listen(0, "127.0.0.1", r));
  writeFileSync(join(home, "server.json"), JSON.stringify({ port: desk.address().port }));
  try {
    const client = new ToryoClient(home);
    assert.match(await client.statusText(), /waiting for you: Codex asks: Tabs or spaces\?$/m);
    // Named: that desk can't tell questions apart, so nothing is sent rather than an answer landing somewhere else.
    await assert.rejects(client.answer(undefined, "Tabs.", { question: "e-elsewhere" }), /Restart it first/);
    await assert.rejects(client.answer("Old room", "Tabs.", { question: "e-elsewhere" }), /Restart it first/);
    assert.deepEqual(posted, []);
    assert.equal(await client.answer(undefined, "", { accept: true }), "Answered in “Old room”.");
    assert.deepEqual(posted, [{ url: "/api/rooms/r1/answer", body: { text: "", accept: true } }]);
  } finally {
    await new Promise((r) => desk.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});

test("an agent with a question the room waits on and a chat question: a plain note answers neither", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", reply: "I recommend tabs.\nTORYO: OWNER Tabs or spaces?" },
    { agent: "codex", match: "About the licence", reply: "TORYO: OWNER MIT or Apache?" },
    { agent: "codex", reply: "Noted.\nTORYO: REPLY" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "builder's question" });
    // A note the page says answers nothing: it doesn't answer the builder's question, and the builder asks in chat.
    t.engine.postMessage(room.id, { text: "About the licence: which one?", to: "codex", answering: false });
    await waitFor(() => open(t.engine, room.id).length === 2 && idle(t.engine, room.id), { label: "a chat question too" });
    const [tabs, licence] = open(t.engine, room.id);
    assert.deepEqual([tabs.kind, licence.kind], ["build-owner", "chat-owner"]);
    // A note to several agents can't answer a question the room waits on: that one is answered from its card.
    assert.throws(() => t.engine.postMessage(room.id, { text: "Tabs.", to: "everyone", answering: [tabs.id] }), (e) => e.status === 400);
    const { event } = t.engine.postMessage(room.id, { text: "Hold on; thinking.", to: "codex" });
    assert.equal(event.kind, undefined);
    assert.equal(event.answers, undefined);
    assert.deepEqual(open(t.engine, room.id).map((q) => q.id), [tabs.id, licence.id]);
    await waitFor(() => idle(t.engine, room.id), { label: "reply" });
    assert.ok(!t.calls().some((c) => /The owner answered/.test(c.prompt)));
    assert.deepEqual(open(t.engine, room.id).map((q) => q.id), [tabs.id, licence.id]);
  } finally {
    t.cleanup();
  }
});

test("a note to several agents answers the chat questions the page names, and none at all if one has been answered", async () => {
  const t = await setup([
    { agent: "codex", match: "Ask us", reply: "TORYO: OWNER Codex: which port?" },
    { agent: "claude", match: "Ask us", reply: "TORYO: OWNER Claude: which host?" },
    { reply: "Noted.\nTORYO: REPLY" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", title: "chat", members: ["codex", "claude"], text: "Ask us something.", to: "everyone" });
    await waitFor(() => open(t.engine, room.id).length === 2 && idle(t.engine, room.id), { label: "two questions" });
    const [a, b] = open(t.engine, room.id);
    t.engine.answer(room.id, { questionId: a.id, text: "8080." });
    await waitFor(() => idle(t.engine, room.id), { label: "reply" });
    const before = t.engine.roomView(room.id).events.length;
    // One of them answered meanwhile: nothing is sent, and the other stays open.
    assert.throws(() => t.engine.postMessage(room.id, { text: "8080 and localhost.", to: "everyone", answering: [a.id, b.id] }), (e) => e.status === 409);
    assert.equal(t.engine.roomView(room.id).events.length, before);
    assert.deepEqual(open(t.engine, room.id).map((q) => q.id), [b.id]);
    // The open one named: the note answers it.
    const { event } = t.engine.postMessage(room.id, { text: "localhost.", to: "everyone", answering: [b.id] });
    assert.deepEqual(event.answers.map((x) => x.id), [b.id]);
    assert.deepEqual(open(t.engine, room.id), []);
    await waitFor(() => idle(t.engine, room.id), { label: "replies" });
  } finally {
    t.cleanup();
  }
});

test("an answer reaches the agent with the question it answers, so a bare “Yes” says what it's yes to", async () => {
  await withServer(
    [
      { agent: "codex", match: "First thing", delayMs: 400, reply: "TORYO: OWNER Should I add tests?" },
      { agent: "codex", match: "Second thing", reply: "TORYO: OWNER Should I add docs?" },
      { agent: "codex", reply: "Noted.\nTORYO: REPLY" },
    ],
    async ({ engine, post, calls }) => {
      const room = engine.createRoom({ projectId: "repo", mode: "chat", title: "chat", members: ["codex"], text: "First thing.", to: "codex" });
      await waitFor(() => engine.summary(engine.rooms.get(room.id)).running.includes("codex"), { label: "codex working" });
      engine.postMessage(room.id, { text: "Second thing.", to: "codex" });
      await waitFor(() => open(engine, room.id).length === 2 && idle(engine, room.id), { label: "two questions" });
      const [tests, docs] = open(engine, room.id);
      assert.equal((await post(`/api/rooms/${room.id}/answer`, { questionId: docs.id, text: "Yes." })).status, 200);
      await waitFor(() => idle(engine, room.id) && calls().length === 3, { label: "reply" });
      const first = calls()[2].prompt;
      assert.match(first, /The owner \(to (you|everyone)\) · answering your question “Should I add docs\?”\nYes\./);
      assert.doesNotMatch(first, /answering your question “Should I add tests\?”/);
      // The page's note naming the other question.
      assert.equal((await post(`/api/rooms/${room.id}/messages`, { text: "No.", to: "codex", answering: tests.id })).status, 200);
      await waitFor(() => idle(engine, room.id) && calls().length === 4, { label: "second reply" });
      assert.match(calls()[3].prompt, /The owner \(to (you|everyone)\) · answering your question “Should I add tests\?”\nNo\./);
      const shown = engine.roomView(room.id).events.filter((e) => e.type === "owner" && e.kind === "answer");
      assert.deepEqual(shown.map((e) => e.answers.map((a) => a.question)), [["Should I add docs?"], ["Should I add tests?"]]);
    },
  );
});

test("a queued note that answered questions stays as sent: it can't be withdrawn or changed while its agents are held", async () => {
  const t = await setup([
    { agent: "codex", match: "Ask us", reply: "TORYO: OWNER Codex: which port?" },
    { agent: "claude", match: "Ask us", reply: "TORYO: OWNER Claude: which host?" },
    { reply: "Noted.\nTORYO: REPLY" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", title: "chat", members: ["codex", "claude"], text: "Ask us something.", to: "everyone" });
    await waitFor(() => open(t.engine, room.id).length === 2 && idle(t.engine, room.id), { label: "two questions" });
    const [a, b] = open(t.engine, room.id);
    t.engine.deskControl("hold", { target: "codex" });
    t.engine.deskControl("hold", { target: "claude" });
    // From the page (naming both questions) and from a terminal (each agent's only question): both close them.
    const { event: both } = t.engine.postMessage(room.id, { text: "8080 on localhost.", to: "everyone", answering: [a.id, b.id] });
    assert.deepEqual(open(t.engine, room.id), []);
    assert.equal(t.engine.rooms.get(room.id).queue.length, 2, "queued while the agents are held");
    for (const change of [{ cancel: true }, { text: "9090 on localhost." }])
      assert.throws(() => t.engine.editNote(room.id, both.id, change), (e) => e.status === 409 && /answered a question/.test(e.message));
    const shown = t.engine.roomView(room.id).events;
    assert.equal(shown.find((e) => e.id === both.id).cancelled, undefined);
    assert.equal(shown.find((e) => e.id === both.id).text, "8080 on localhost.");
    assert.deepEqual([a.id, b.id].map((id) => shown.find((e) => e.id === id).answer), ["8080 on localhost.", "8080 on localhost."]);
    assert.equal(t.engine.rooms.get(room.id).queue.length, 2);
    // A plain note that answered nothing can still be withdrawn.
    const { event: plain } = t.engine.postMessage(room.id, { text: "Also, use IPv6.", to: "codex" });
    assert.equal(plain.answers, undefined);
    t.engine.editNote(room.id, plain.id, { cancel: true });
    t.engine.deskControl("release", { target: "codex" });
    t.engine.deskControl("release", { target: "claude" });
    await waitFor(() => idle(t.engine, room.id), { label: "replies after release" });
    assert.deepEqual(open(t.engine, room.id), []);
  } finally {
    t.cleanup();
  }
});
