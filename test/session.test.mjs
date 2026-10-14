import { test } from "node:test";
import assert from "node:assert/strict";
import { Timeline, sessionWords } from "../web/phases.js";
import { mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const sum = (e, id) => e.summary(e.rooms.get(id));

test("a room's session, as the desk says it, matches how long its turns and checks really ran, and what the page works out from the same events", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Your role: builder", workMs: 1200, reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md" },
      { agent: "claude", match: "Your role: reviewer", workMs: 800, reply: "Good.\nTORYO: APPROVED" },
    ],
    { gates: [{ name: "Slow check", command: "sleep 1", timeoutMin: 1 }] },
  );
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "build", task: "One slice", title: "Timed" });
    await waitFor(() => turns(e, room.id).some((x) => x.kind === "review" && x.state === "done"), { label: "the review" });
    // Stopped, so nothing runs on while it's compared (the builder carries on to the next slice after an approval).
    e.control(room.id, "stop");
    await waitFor(() => !sum(e, room.id).running.length, { label: "stopped" });
    const events = e.roomView(room.id).events;
    const ran = (pred) => events.filter(pred).reduce((n, x) => n + (Date.parse(x.endedAt) - Date.parse(x.startedAt)), 0);
    const { totals, length } = sum(e, room.id).session;
    const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1000, `${what}: ${a} ms against ${b} ms`);
    near(totals.build, ran((x) => x.type === "turn" && /^build/.test(x.kind)), "building");
    near(totals.review, ran((x) => x.type === "turn" && x.kind === "review"), "reviewing");
    const gate = events.find((x) => x.type === "gate");
    assert.ok(gate.startedAt, "the checks run's start is recorded");
    near(totals.checks, 1000, "the checks (sleep 1)");
    assert.ok(totals.build >= 1200 && totals.review >= 800 && totals.checks >= 1000);
    assert.ok(length >= totals.build + totals.review + totals.checks - 50);
    // The page's way: a Timeline fed the room's events. The finished phases agree to the millisecond.
    const page = new Timeline();
    for (const x of events) page.add(x);
    const v = page.view();
    assert.deepEqual([v.totals.build, v.totals.review, v.totals.checks], [totals.build, totals.review, totals.checks]);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("pausing and resuming a room, and a desk hold on its work, are kept as marks the transcript doesn't show", async () => {
  const t = await setup([{ agent: "codex", reply: "Hi.\nTORYO: REPLY" }]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Marked", text: "Hello.", to: "codex" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "a reply" });
    e.control(room.id, "pause");
    e.control(room.id, "resume");
    e.deskControl("hold", { target: "codex" });
    e.postMessage(room.id, { text: "Again.", to: "codex", answering: false });
    e.deskControl("release", { target: "codex" });
    await waitFor(() => turns(e, room.id).filter((x) => x.state === "done").length === 2, { label: "the second reply" });
    const marks = e.roomView(room.id).events.filter((x) => x.type === "mark").map((x) => x.what);
    assert.deepEqual(marks, ["paused", "resumed", "held", "free"]);
    assert.ok(sum(e, room.id).session.totals.paused >= 0);
    // Questions record when they close.
    const asker = await setup([{ agent: "codex", reply: "Which?\nTORYO: OWNER SQLite or Postgres?" }]);
    try {
      const r = asker.engine.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Asks", text: "Ask.", to: "codex" });
      await waitFor(() => asker.engine.summary(asker.engine.rooms.get(r.id)).questions.length === 1, { label: "a question" });
      const [q] = asker.engine.summary(asker.engine.rooms.get(r.id)).questions;
      asker.engine.answer(r.id, { questionId: q.id, text: "SQLite." });
      assert.ok(asker.engine.roomView(r.id).events.find((x) => x.id === q.id).closedAt);
      await waitFor(() => turns(asker.engine, r.id).filter((x) => x.state === "done").length === 2, { label: "its reply" });
    } finally {
      asker.engine.shutdown();
      asker.cleanup();
    }
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("checks cut short (the room stopped or moved on, Toryo stopped) keep the time they ran, after a restart too, and drive nothing", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md" }], { gates: [{ name: "Slow check", command: "sleep 3", timeoutMin: 1 }] });
  let e = t.engine;
  try {
    const checking = (id) => e.roomView(id).live.some((l) => l.kind === "gates");
    const cutIn = (id) => e.roomView(id).events.filter((x) => x.type === "mark" && x.what === "checks");
    // Stopped during its checks.
    const stopped = e.createRoom({ projectId: "repo", mode: "build", task: "One slice", title: "Stopped checks" });
    await waitFor(() => checking(stopped.id), { label: "the checks" });
    await new Promise((r) => setTimeout(r, 800));
    e.control(stopped.id, "stop");
    await waitFor(() => cutIn(stopped.id).length === 1, { label: "the stopped checks recorded" });
    const [cut] = cutIn(stopped.id);
    const ranFor = Date.parse(cut.at) - Date.parse(cut.startedAt);
    assert.equal(cut.why, "stopped");
    assert.ok(cut.runId && ranFor >= 700, `ran for ${ranFor} ms`);
    assert.equal(sum(e, stopped.id).session.totals.checks, ranFor);
    assert.ok(!e.roomView(stopped.id).events.some((x) => x.type === "gate"), "no result, and nothing acts on it");
    // Moved on: a new build while its checks run. They finish, drive nothing, and their time is kept.
    const moved = e.createRoom({ projectId: "repo", mode: "build", task: "One slice", title: "Superseded checks" });
    await waitFor(() => checking(moved.id), { label: "the checks" });
    e.startBuild(moved.id, { task: "Another slice" });
    await waitFor(() => cutIn(moved.id).length === 1, { label: "the superseded checks recorded", timeout: 10_000 });
    assert.equal(cutIn(moved.id)[0].why, "superseded");
    e.control(moved.id, "stop");
    await waitFor(() => !e.roomView(moved.id).live.length, { label: "stopped" });
    // A restart: the same from the saved events.
    const before = [stopped, moved].map((r) => sum(e, r.id).session.totals.checks);
    assert.ok(before[1] >= 2500, `the superseded run counted ${before[1]} ms`);
    e.shutdown();
    e = await t.make();
    assert.deepEqual([stopped, moved].map((r) => sum(e, r.id).session.totals.checks), before);
    // Toryo stopping during a room's checks: the time they ran is kept, and they run again after the restart.
    const restarted = e.createRoom({ projectId: "repo", mode: "build", task: "One slice", title: "Restarted checks" });
    await waitFor(() => checking(restarted.id), { label: "the checks" });
    await new Promise((r) => setTimeout(r, 600));
    e.shutdown();
    e = await t.make();
    const [offAt] = cutIn(restarted.id);
    assert.equal(offAt?.why, "restart");
    assert.ok(Date.parse(offAt.at) - Date.parse(offAt.startedAt) >= 500);
    await waitFor(() => checking(restarted.id), { label: "the checks again" });
    assert.ok(sum(e, restarted.id).session.totals.checks >= 500);
    e.control(restarted.id, "stop");
    await waitFor(() => !e.roomView(restarted.id).live.length, { label: "stopped" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("a pause or stop ends however the room goes on (a message, Resume, a new build or plan), and only then", async () => {
  const t = await setup([{ agent: "codex", reply: "Hi.\nTORYO: REPLY" }]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Goes on", text: "Hello.", to: "codex" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "a reply" });
    const marks = () => e.roomView(room.id).events.filter((x) => x.type === "mark" && x.what !== "held" && x.what !== "free").map((x) => x.what);
    e.control(room.id, "stop");
    e.postMessage(room.id, { text: "Go on.", to: "codex", answering: false });
    assert.deepEqual(marks(), ["stopped", "resumed"]);
    await waitFor(() => turns(e, room.id).filter((x) => x.state === "done").length === 2, { label: "the second reply" });
    // Paused, then stopped: one pause. A new build clears the stop, not the pause: still paused, nothing marked.
    e.control(room.id, "pause");
    e.control(room.id, "stop");
    e.startBuild(room.id, { task: "Something" });
    assert.deepEqual(marks(), ["stopped", "resumed", "paused"]);
    assert.equal(e.rooms.get(room.id).paused, true);
    e.control(room.id, "resume");
    e.control(room.id, "stop");
    e.startPlan(room.id, { topic: "Next" });
    assert.deepEqual(marks(), ["stopped", "resumed", "paused", "resumed", "stopped", "resumed"]);
    // Going on, the paused time stops growing.
    const paused = sum(e, room.id).session.totals.paused;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sum(e, room.id).session.totals.paused, paused);
    e.control(room.id, "stop");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a build started from a handoff while paused stays paused until Resume: on the desk, after a restart, and as the page works it out", async () => {
  let clock = Date.now();
  const t = await setup([{ agent: "claude", hang: true }], { engine: { now: () => clock } });
  let e = t.engine;
  try {
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude"], title: "Handed over" });
    const events = () => e.roomView(room.id).events;
    const marks = () => events().filter((x) => x.type === "mark").map((x) => x.what);
    const onPage = () => {
      const tl = new Timeline();
      for (const x of events()) tl.add(x);
      return tl.view({ now: clock }).totals.paused;
    };
    e.control(room.id, "pause");
    e.startBuild(room.id, { task: "Review it", reviewFirst: true, handoff: "Done.\nTORYO: REVIEW Slice 1: One | h.md" });
    assert.ok(events().some((x) => x.type === "turn" && x.imported), "the handoff, brought in");
    assert.deepEqual(marks(), ["paused"]);
    assert.equal(e.rooms.get(room.id).paused, true);
    assert.ok(e.rooms.get(room.id).queue.some((q) => q.kind === "review"), "its review waits");
    // Ten minutes later: ten minutes paused, on the desk and the page.
    const pausedAt = Date.parse(events().find((x) => x.type === "mark").at);
    clock = pausedAt + 10 * 60_000;
    assert.deepEqual([sum(e, room.id).session.totals.paused, onPage()], [10 * 60_000, 10 * 60_000]);
    // After a restart, from the saved events: the same, and no new mark.
    e.shutdown();
    e = await t.make();
    assert.deepEqual([sum(e, room.id).session.totals.paused, onPage(), marks()], [10 * 60_000, 10 * 60_000, ["paused"]]);
    // Resume ends it there, and the review goes.
    e.control(room.id, "resume");
    assert.deepEqual(marks(), ["paused", "resumed"]);
    const resumedAt = Date.parse(events().filter((x) => x.type === "mark")[1].at);
    clock += 5 * 60_000;
    assert.deepEqual([sum(e, room.id).session.totals.paused, onPage()], [resumedAt - pausedAt, resumedAt - pausedAt]);
    await waitFor(() => t.calls().some((c) => c.kind === "claude"), { label: "the review" });
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("a restart that cut a turn off pauses its room, and the session counts the pause from then", async () => {
  const t = await setup([{ agent: "codex", hang: true }]);
  let e = t.engine;
  try {
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Cut off", text: "Hello.", to: "codex" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "running"), { label: "a turn" });
    e.shutdown();
    e = await t.make();
    assert.equal(e.rooms.get(room.id).paused, true);
    assert.deepEqual(e.roomView(room.id).events.filter((x) => x.type === "mark").map((x) => x.what), ["paused"]);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(sum(e, room.id).session.totals.paused >= 150);
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("toryo show and the MCP room tool say the session in the same words as the room's summary", async () => {
  await withServer([{ agent: "codex", workMs: 1500, reply: "Hi.\nTORYO: REPLY" }], async ({ engine: e, client, home }) => {
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Said", text: "Hello.", to: "codex" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "a reply" });
    // Done, nothing running: the session's length still grows with the clock, so compare the phases.
    const phases = (text) => text.match(/This session, [^:]+: (.*)\./)?.[1];
    const shown = await client.roomText(room.id);
    assert.equal(phases(shown.split("\n")[1]), phases(sessionWords(sum(e, room.id).session)));
    assert.match(shown.split("\n")[1], /^This session, \d+ s: other work \d+ s\.$/);
    const m = mcp(home);
    try {
      assert.match((await m.call("toryo_room", { room: room.id })).text, /\nThis session, \d+ s: other work \d+ s\.\n/);
    } finally {
      m.close();
    }
  });
});
