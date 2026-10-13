import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { shortDuration, sliceTimes } from "../src/plan.mjs";
import { createServer } from "../src/server.mjs";
import { setup } from "./helpers.mjs";

test("slice times count agent and check time from the previous approval to this one", () => {
  const t = (min) => new Date(Date.UTC(2026, 9, 13, 10, min)).toISOString();
  const events = [
    { type: "system", at: t(0), text: "Build started: Claude builds, Codex reviews." },
    { type: "turn", startedAt: t(0), endedAt: t(30), status: "REVIEW" },
    { type: "gate", at: t(30), results: [{ seconds: 60 }, { seconds: 120 }] },
    { type: "turn", startedAt: t(33), endedAt: t(43), status: "CHANGES" },
    // Forty minutes waiting for the owner don't count as work.
    { type: "turn", startedAt: t(83), endedAt: t(98), status: "REVIEW" },
    { type: "turn", startedAt: t(98), endedAt: t(108), status: "APPROVED" },
    { type: "system", at: t(108), text: "“Slice 1: Basics” approved after 2 rounds (1h08m of work)." },
    { type: "turn", startedAt: t(108), endedAt: t(118), status: "REVIEW" },
  ];
  const { done, current } = sliceTimes(events);
  assert.equal(done.length, 1);
  assert.equal(done[0].label, "Slice 1: Basics");
  assert.equal(done[0].rounds, 2);
  assert.equal(shortDuration(done[0].active), "1h08m");
  assert.equal(shortDuration(done[0].wall), "1h48m");
  assert.equal(shortDuration(current.active), "10m");
  assert.deepEqual([0, 20_000, 42 * 60_000, 194 * 60_000, 27 * 3_600_000].map(shortDuration), ["<1m", "<1m", "42m", "3h14m", "1d3h"]);
});

test("each agent's models and efforts are offered for the Settings dropdowns", async () => {
  const t = await setup([]);
  const app = createServer({ engine: t.engine, webDir: join(import.meta.dirname, "..", "web"), port: 0 });
  const { port } = await app.listen();
  try {
    const get = (id) => fetch(`http://127.0.0.1:${port}/api/agents/${id}/models`).then((r) => r.json());
    const claude = await get("claude");
    assert.ok(claude.models.some((m) => m.id === "opus" && m.efforts.includes("max")));
    assert.deepEqual(await get("grok"), { models: [] });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/agents/nobody/models`)).status, 404);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("changed house rules reach every agent once, on its next turn", async () => {
  const { waitFor, turns } = await import("./helpers.mjs");
  const t = await setup([
    { agent: "claude", match: "every slice of the plan is done", reply: "Final: fine.\nTORYO: APPROVED" },
    { agent: "claude", match: "Your role: reviewer", times: 1, reply: "Finding 1.\nTORYO: CHANGES" },
    { agent: "claude", match: "Your role: reviewer", reply: "Fixed.\nTORYO: APPROVED" },
    { agent: "codex", match: "reviewed your last round", reply: "Fixed it.\nTORYO: REVIEW S1 | h.md" },
    { agent: "codex", match: "continue straight into the next unfinished slice", reply: "All done.\nTORYO: DONE" },
    { agent: "codex", match: "Your role: builder", reply: "Built S1.\nTORYO: REVIEW S1 | h.md" },
  ]);
  try {
    // Both agents have a turn under the old rules: the build, then the first review (pausing after each).
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build it" });
    t.engine.control(room.id, "pause");
    await waitFor(() => turns(t.engine, room.id).some((e) => e.agent === "codex" && e.state === "done"), { label: "kickoff" });
    t.engine.control(room.id, "resume");
    t.engine.control(room.id, "pause");
    await waitFor(() => turns(t.engine, room.id).some((e) => e.agent === "claude" && e.state === "done"), { label: "first review" });
    t.engine.updateProject("repo", { rules: "- Always run the smoke test." });
    t.engine.control(room.id, "resume");
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "room done" });
    const calls = t.calls();
    const codex = calls.filter((c) => c.kind === "codex");
    const claude = calls.filter((c) => c.kind === "claude");
    const updated = (c) => /The owner updated the house rules/.test(c.prompt);
    // Codex: nothing before the change, the full new rules once after it, then nothing.
    assert.deepEqual(codex.map(updated), [false, true, false]);
    assert.match(codex[1].prompt, /- Always run the smoke test\./);
    // Claude has the rules in its instructions; its first turn after the change says so once, in a short pointer.
    assert.equal(updated(claude[0]), false);
    assert.ok(claude.slice(1).every((c) => c.args.join(" ").includes("Always run the smoke test")));
    assert.equal(claude.filter(updated).length, 1);
    assert.doesNotMatch(claude.find(updated).prompt, /Always run the smoke test/);
    assert.ok(t.engine.roomView(room.id).events.some((e) => e.type === "system" && /Codex has the updated house rules/.test(e.text)));
  } finally {
    t.cleanup();
  }
});

test("a role change during a round waits for it, and a new builder gets the builder's briefing", async () => {
  const { waitFor, turns } = await import("./helpers.mjs");
  const t = await setup([
    { agent: "claude", match: "reviewed your last round", reply: "Fixed it.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", match: "Your role: reviewer", times: 1, reply: "Finding 1.\nTORYO: CHANGES" },
    { agent: "codex", match: "Your role: reviewer", reply: "Looks right.\nTORYO: OWNER Stop here?" },
    { agent: "codex", match: "Your role: builder", reply: "Built S1.\nTORYO: REVIEW S1 | h.md" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build it" });
    t.engine.control(room.id, "pause");
    await waitFor(() => turns(t.engine, room.id).some((e) => e.agent === "codex" && e.state === "done"), { label: "kickoff" });
    // Claude's review of Codex's work is already on its way: the change waits for it.
    t.engine.control(room.id, "roles", { builder: "claude", reviewer: "codex" });
    const r = t.engine.rooms.get(room.id);
    assert.deepEqual([r.crew.builder, r.crew.reviewer], ["codex", "claude"]);
    assert.deepEqual(r.rolesPending, { builder: "claude", reviewer: "codex" });
    t.engine.control(room.id, "resume");
    await waitFor(() => r.waiting, { label: "Codex's question" });
    assert.deepEqual([r.crew.builder, r.crew.reviewer, r.rolesPending], ["claude", "codex", null]);
    const calls = t.calls();
    assert.deepEqual(calls.map((c) => c.kind), ["codex", "claude", "claude", "codex"]);
    assert.match(calls[1].prompt, /Your role: reviewer/);
    assert.match(calls[2].prompt, /## Your role: builder/);
    // Claude reviewed this work itself: it's told the review to address is its own last message.
    assert.match(calls[2].prompt, /Roles changed: you build from now on, and Codex reviews\. Codex built the work so far, and you reviewed it/);
    // Only the builder and reviewer roles block removal; nobody leaves mid-turn.
    assert.throws(() => t.engine.control(room.id, "members", { members: ["claude"] }), /Give the builder's or reviewer's role to someone else/);
    const chat = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude"] });
    t.engine.control(chat.id, "members", { members: ["codex"] });
    assert.deepEqual(t.engine.rooms.get(chat.id).crew.members, ["codex"]);
  } finally {
    t.cleanup();
  }
});
