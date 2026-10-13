import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, turns, waitFor } from "./helpers.mjs";

test("build relay: review, fixes, approval, next slice, final review", async () => {
  const t = await setup([
    { agent: "claude", match: "every slice of the plan is done", reply: "Final review: all good.\nTORYO: APPROVED" },
    { agent: "claude", match: "Your role: reviewer", times: 1, reply: "Finding 1: a.txt has no trailing newline (a.txt:1).\nTORYO: CHANGES" },
    { agent: "claude", match: "Your role: reviewer", reply: "Verified the fix.\nTORYO: APPROVED" },
    { agent: "codex", match: "Your role: builder", write: { path: "a.txt", content: "hello" }, reply: "Built slice 1.\nTORYO: REVIEW Slice 1: Basics | docs/handoff.md" },
    { agent: "codex", match: "reviewed your last round", write: { path: "a.txt", content: "hello\n" }, reply: "Fixed the newline.\nTORYO: REVIEW Slice 1: Basics | docs/handoff.md" },
    { agent: "codex", match: "continue straight into the next unfinished slice", reply: "Nothing left.\nTORYO: DONE" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Make a.txt", planPath: "docs/plan.md" });
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "room done" });
    const ts = turns(t.engine, room.id);
    assert.deepEqual(
      ts.map((x) => `${x.agent}:${x.kind}:${x.status}`),
      [
        "codex:build:REVIEW",
        "claude:review:CHANGES",
        "codex:build-fix:REVIEW",
        "claude:review:APPROVED",
        "codex:build-next:DONE",
        "claude:review:APPROVED",
      ],
    );
    const calls = t.calls();
    // Messages are forwarded verbatim.
    assert.match(calls[2].prompt, /Finding 1: a\.txt has no trailing newline/);
    assert.match(calls[3].prompt, /Fixed the newline\./);
    // Reviewer is read-only, builder writes.
    assert.ok(calls[1].args.includes("--disallowedTools"));
    assert.ok(calls[0].args.includes("workspace-write"));
    assert.ok(calls[2].args.includes("resume"));
    // Snapshots record what each turn changed.
    assert.deepEqual(ts[0].files.map((f) => f.path), ["a.txt"]);
    assert.deepEqual(ts[2].files.map((f) => f.path), ["a.txt"]);
    // The reviewer is told which snapshot it reviews, and how to diff since its last review.
    assert.match(calls[3].prompt, /Changes since your last review: `git --git-dir=/);
    const r = t.engine.rooms.get(room.id);
    assert.deepEqual(r.build.approved, ["Slice 1: Basics"]);
    assert.ok(t.notes.some((n) => n.t === "Plan complete"));
    // The project repository's own git state is untouched by snapshots.
    const diff = await t.engine.turnDiff(room.id, ts[2].id);
    assert.match(diff.diff, /\+hello/);
  } finally {
    t.cleanup();
  }
});

test("nudges when the builder stops without a status, then an owner question and answer", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", reply: "Done some work. Shall I continue?" },
    { agent: "codex", match: "nudge 1 of 2", reply: "Need a decision.\nI recommend skipping archived stories.\nTORYO: OWNER Skip archived stories?" },
    { agent: "codex", match: "The owner answered", reply: "Skipping them.\nTORYO: REVIEW Slice 1 | h.md" },
    { agent: "claude", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "codex", match: "approved", reply: "TORYO: DONE" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "owner question" });
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.waiting.kind, "build-owner");
    assert.equal(r.waiting.question, "Skip archived stories?");
    assert.match(r.waiting.recommendation, /skipping archived stories/);
    assert.ok(t.notes.some((n) => /needs your answer/.test(n.t)));
    // Auto-routing sends the reply to whoever is waiting.
    const sent = t.engine.postMessage(room.id, { text: "Yes, skip them." });
    assert.deepEqual(sent.routed.agents, ["codex"]);
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "done" });
    const calls = t.calls();
    assert.match(calls[1].prompt, /nudge 1 of 2/);
    assert.match(calls[2].prompt, /Yes, skip them\./);
  } finally {
    t.cleanup();
  }
});

test("chat to everyone runs in parallel and a bounded discussion ends when they agree", async () => {
  const t = await setup([
    { agent: "codex", match: "Discussion round 1", reply: "Agreed with Claude.\nTORYO: AGREE" },
    { agent: "claude", match: "Discussion round 1", reply: "Agreed with Codex.\nTORYO: AGREE" },
    { agent: "codex", reply: "Codex thinks A.\nTORYO: REPLY", delayMs: 150 },
    { agent: "claude", reply: "Claude thinks B.\nTORYO: REPLY", delayMs: 150 },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", text: "A or B?", to: "everyone", discuss: 2 });
    await waitFor(() => t.engine.roomView(room.id).events.some((e) => e.type === "system" && /agree after 1 discussion round/.test(e.text)), { label: "agreement" });
    const calls = t.calls();
    const first = calls.filter((c) => !/Discussion round/.test(c.prompt));
    assert.equal(first.length, 2);
    // The two first replies overlapped in time (parallel).
    assert.ok(Math.abs(first[0].at - first[1].at) < 140);
    const codexDiscuss = calls.find((c) => c.kind === "codex" && /Discussion round 1/.test(c.prompt));
    assert.match(codexDiscuss.prompt, /Claude thinks B\./);
    assert.ok(codexDiscuss.args.includes("read-only") || codexDiscuss.args.some((a) => /read-only/.test(a)));
  } finally {
    t.cleanup();
  }
});

test("planning round: blind proposals, critiques, checkpoint, written plan, check, then build", async () => {
  const t = await setup([
    { agent: "codex", match: "step 1 of 4", reply: "Codex proposal: three slices.\n- Q: Use SQLite? (Recommended: yes)\nTORYO: PROPOSAL" },
    { agent: "claude", match: "step 1 of 4", reply: "Claude proposal: two slices.\n- Q: Ship a CLI too? (Recommended: no)\nTORYO: PROPOSAL" },
    { agent: "codex", match: "step 2 of 4", reply: "Claude's plan is leaner.\nTORYO: CRITIQUE" },
    { agent: "claude", match: "step 2 of 4", reply: "Codex covers migrations better.\nTORYO: CRITIQUE" },
    {
      agent: "codex",
      match: "step 3 of 4",
      write: { path: "docs/plans/storage.md", content: "# Storage\n\n### Slice 1: Schema\n- [ ] tables\n\n### Slice 2: API\n- [ ] routes\n" },
      reply: "Plan written.\nTORYO: REVIEW docs/plans/storage.md",
    },
    { agent: "claude", match: "step 4 of 4", reply: "Plan is complete.\nTORYO: APPROVED" },
    { agent: "codex", match: "Your role: builder", reply: "Starting.\nTORYO: OWNER Which database file name?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "plan", topic: "Storage" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "plan-checkpoint", { label: "checkpoint" });
    let calls = t.calls();
    const claudeProposal = calls.find((c) => c.kind === "claude" && /step 1 of 4/.test(c.prompt));
    assert.doesNotMatch(claudeProposal.prompt, /Codex proposal/);
    const claudeCritique = calls.find((c) => c.kind === "claude" && /step 2 of 4/.test(c.prompt));
    assert.match(claudeCritique.prompt, /Codex proposal: three slices/);
    const w = t.engine.rooms.get(room.id).waiting;
    assert.deepEqual(w.questions.map((q) => q.question).sort(), ["Ship a CLI too?", "Use SQLite?"]);

    t.engine.synthesize(room.id, { synthesizer: "codex", planPath: "docs/plans/storage.md", decisions: "SQLite: yes. CLI: no." });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "plan-ready", { label: "plan ready" });
    calls = t.calls();
    const synth = calls.find((c) => /step 3 of 4/.test(c.prompt));
    assert.match(synth.prompt, /SQLite: yes\. CLI: no\./);
    assert.ok(synth.args.includes("workspace-write") || synth.args.some((a) => /workspace-write/.test(a)));
    assert.ok(existsSync(join(t.repo, "docs/plans/storage.md")));
    const view = t.engine.planView(room.id);
    assert.deepEqual(view.slices.map((s) => s.name), ["Schema", "API"]);

    // Accepting the recommendation starts the build with the plan (it doesn't ask for a revision).
    t.engine.answer(room.id, { accept: true });
    assert.equal(t.engine.rooms.get(room.id).mode, "build");
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "build-owner", { label: "build started" });
    calls = t.calls();
    assert.match(calls.at(-1).prompt, /Plan: docs\/plans\/storage\.md/);
    assert.ok(!calls.some((c) => /The plan check is above/.test(c.prompt)));
  } finally {
    t.cleanup();
  }
});

test("a note sent now interrupts the running turn and resumes it with the note", async () => {
  const t = await setup([
    { agent: "codex", match: "interrupted your previous turn", reply: "Adjusted.\nTORYO: OWNER ok?" },
    { agent: "codex", match: "Your role: builder", hang: true },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("codex"), { label: "running" });
    await new Promise((r) => setTimeout(r, 200));
    t.engine.postMessage(room.id, { text: "Use tabs, not spaces.", to: "codex", delivery: "now" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "after interrupt" });
    const calls = t.calls();
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /Use tabs, not spaces\./);
    assert.match(calls[1].prompt, /Your role: builder/);
    const ts = turns(t.engine, room.id);
    assert.equal(ts[0].state, "interrupted");
  } finally {
    t.cleanup();
  }
});

test("turns in flight when Toryo stops are re-queued on the next start", async () => {
  const t = await setup([
    { agent: "codex", match: "Toryo restarted while you were working", reply: "Resumed.\nTORYO: OWNER fine?" },
    { agent: "codex", match: "Your role: builder", hang: true },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("codex"), { label: "running" });
    await new Promise((r) => setTimeout(r, 200));
    // The session is on disk as soon as the agent has started, not only when its turn ends.
    const session = t.engine.store.loadRoom(room.id).sessions.codex;
    assert.ok(session);
    t.engine.shutdown();
    await waitFor(() => t.engine.running.size === 0, { label: "stopped" });

    const second = await t.make();
    const r2 = second.rooms.get(room.id);
    assert.equal(r2.paused, true);
    assert.equal(r2.queue.length, 1);
    second.control(room.id, "resume");
    await waitFor(() => second.rooms.get(room.id).waiting, { label: "resumed turn finished" });
    assert.match(t.calls().at(-1).prompt, /Toryo restarted while you were working/);
    assert.ok(t.calls().at(-1).args.includes(session), "the restarted turn resumes the same session");
  } finally {
    t.cleanup();
  }
});

test("project checks run before review and failures go back to the builder", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Toryo ran the project's checks", write: { path: "ok.flag", content: "1" }, reply: "Fixed the check.\nTORYO: REVIEW S1 | h.md" },
      { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW S1 | h.md" },
      { agent: "claude", reply: "ok\nTORYO: OWNER stop here?" },
    ],
    { gates: [{ name: "flag exists", command: "test -f ok.flag" }] },
  );
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "review reached", timeout: 30_000 });
    const ev = t.engine.roomView(room.id).events;
    const gates = ev.filter((e) => e.type === "gate");
    assert.equal(gates.length, 2);
    assert.equal(gates[0].results[0].ok, false);
    assert.equal(gates[1].results[0].ok, true);
    assert.equal(t.engine.rooms.get(room.id).waiting.from, "claude");
  } finally {
    t.cleanup();
  }
});

test("status parsing tolerates formatting", async () => {
  const { parseStatus, parseQuestions, stripStatus } = await import("../src/protocol.mjs");
  assert.deepEqual(parseStatus("text\n**TORYO: REVIEW Slice 2 | docs/h.md**\n"), { status: "REVIEW", detail: "Slice 2 | docs/h.md" });
  assert.deepEqual(parseStatus("text\n`TORYO: APPROVED`"), { status: "APPROVED", detail: "" });
  assert.equal(parseStatus("no status here").status, null);
  assert.equal(stripStatus("Body\n\nTORYO: CHANGES"), "Body");
  assert.deepEqual(parseQuestions("- Q: Use X? (Recommended: yes)\n* **Q:** Ship? (Recommended: later)"), [
    { question: "Use X?", recommendation: "yes" },
    { question: "Ship?", recommendation: "later" },
  ]);
  const { parseSlices } = await import("../src/plan.mjs");
  const slices = parseSlices("# P\n## Slice 1: A ✅\n- [x] a\n## Slice 2 — B\n- [ ] b\n### detail\n## Notes");
  assert.deepEqual(slices.map((s) => [s.number, s.name, s.markedDone, s.checks]), [
    ["1", "A ✅", true, 1],
    ["2", "B", false, 1],
  ]);
  void readFileSync;
});

test("a build can start by reviewing a round the builder finished elsewhere", async () => {
  const t = await setup([
    { agent: "codex", match: "every slice of the plan is done", reply: "Final review: fine.\nTORYO: APPROVED" },
    { agent: "codex", match: "Your role: reviewer", times: 1, reply: "Finding 1: the server starts twice (bin/x.mjs:3).\nTORYO: CHANGES" },
    { agent: "codex", match: "Your role: reviewer", reply: "Verified.\nTORYO: APPROVED" },
    { agent: "claude", match: "reviewed your last round", reply: "Fixed the double start.\nTORYO: REVIEW Review fixes | docs/review-handoff.md" },
    { agent: "claude", match: "continue straight into the next unfinished slice", reply: "Nothing left.\nTORYO: DONE" },
  ]);
  try {
    const handoff = "I built the whole desk. Read docs/review-handoff.md first.";
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], builder: "claude", reviewer: "codex", reviewFirst: true, handoff, task: "Address the review" });
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "room done" });
    const ts = turns(t.engine, room.id);
    assert.deepEqual(
      ts.map((x) => `${x.agent}:${x.kind}:${x.status}${x.imported ? ":imported" : ""}`),
      ["claude:build:REVIEW:imported", "codex:review:CHANGES", "claude:build-fix:REVIEW", "codex:review:APPROVED", "claude:build-next:DONE", "codex:review:APPROVED"],
    );
    const calls = t.calls();
    // The reviewer goes first, with the handoff verbatim.
    assert.equal(calls[0].kind, "codex");
    assert.match(calls[0].prompt, /I built the whole desk\. Read docs\/review-handoff\.md first\./);
    // The builder's first Toryo turn carries the briefing once, then the review to address.
    assert.match(calls[1].prompt, /## Your role: builder/);
    assert.match(calls[1].prompt, /Finding 1: the server starts twice/);
    assert.doesNotMatch(calls[3].prompt, /## Your role: builder/);
    // The builder renamed the slice when it resubmitted; the approval goes to that name.
    assert.deepEqual(t.engine.rooms.get(room.id).build.approved, ["Review fixes"]);
    // A start that can't find a handoff fails before any room exists.
    const before = t.engine.rooms.size;
    assert.throws(() => t.engine.createRoom({ projectId: "repo", mode: "build", reviewFirst: true, task: "x" }), /Paste Codex's handoff message/);
    assert.equal(t.engine.rooms.size, before);
  } finally {
    t.cleanup();
  }
});

test("after a restart, Toryo follows the Codex app's turn again instead of sending it twice", async () => {
  const t = await setup([]);
  try {
    const { Engine } = await import("../src/engine.mjs");
    const { Store } = await import("../src/store.mjs");
    const { Snapshots } = await import("../src/snapshots.mjs");
    const { ADAPTERS } = await import("../src/agents/index.mjs");
    const runs = [];
    const app = (behaviour) => ({
      ...ADAPTERS.codexapp,
      detect: async () => ({ installed: true }),
      currentLimits: () => ({ status: "allowed", windows: [{ label: "weekly", used: 7, resetsAt: null }] }),
      run: async (args) => {
        runs.push({ attach: args.attach, turn: args.turnDir.split("/").pop(), thread: args.sessionId });
        // Like the real adapter: the app has the message once it's queued.
        if (!args.attach) args.onSubmitted?.();
        return behaviour(args);
      },
    });
    const make = (behaviour) => new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app(behaviour) } });
    const first = make(({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ text: "", aborted: true }))));
    await first.init({ detect: false });
    const room = first.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "x", appThread: "thread-1" });
    await waitFor(() => runs.length === 1, { label: "app turn started" });
    first.shuttingDown = true;
    for (const run of first.running.values()) run.controller.abort();
    await waitFor(() => first.running.size === 0, { label: "stopped" });

    const second = make(() => ({ text: "Finished in the app.\nTORYO: OWNER Ship it?", sessionId: "thread" }));
    await second.init({ detect: true });
    await waitFor(() => second.rooms.get(room.id).waiting, { label: "followed turn finished" });
    assert.equal(second.rooms.get(room.id).paused, false);
    assert.deepEqual(runs[1].attach, { marker: `[Toryo ${runs[0].turn}]` });
    // Usage shows before the agent's first turn here, and is remembered.
    assert.equal(second.limits.codexapp.windows[0].used, 7);
    assert.ok(existsSync(join(t.home, "limits.json")));
  } finally {
    t.cleanup();
  }
});

test("a build started over a running one isn't finished by the old one's turn", async () => {
  const t = await setup([
    { agent: "codex", match: "Task: A", delayMs: 600, reply: "A finished.\nTORYO: DONE" },
    { agent: "codex", match: "Task: B", reply: "B slice 1.\nTORYO: REVIEW Slice 1 | h.md" },
    { agent: "claude", match: "every slice of the plan is done", reply: "Final.\nTORYO: APPROVED" },
    { agent: "claude", match: "Your role: reviewer", reply: "Good.\nTORYO: APPROVED" },
    { agent: "codex", match: "continue straight into the next unfinished slice", reply: "Next.\nTORYO: OWNER Which slice next?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "A" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("codex"), { label: "A running" });
    t.engine.startBuild(room.id, { task: "B" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "B's question" });
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.done, false);
    assert.equal(r.waiting.kind, "build-owner");
    assert.deepEqual(r.build.approved, ["Slice 1"]);
    assert.ok(!t.calls().some((c) => /every slice of the plan is done/.test(c.prompt)));
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.kind}:${x.status}`), ["build:DONE", "build:REVIEW", "review:APPROVED", "build-next:OWNER"]);
  } finally {
    t.cleanup();
  }
});

test("a swap during a round takes effect at the next building turn", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", delayMs: 500, reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", match: "Your role: reviewer", reply: "Fix X.\nTORYO: CHANGES" },
    { agent: "claude", match: "reviewed your last round", reply: "Fixed X.\nTORYO: OWNER Done?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("codex"), { label: "builder running" });
    t.engine.control(room.id, "swap");
    assert.deepEqual(t.engine.rooms.get(room.id).crew, { members: ["codex", "claude"], builder: "codex", reviewer: "claude" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "question" });
    // Codex's round was reviewed by Claude, and Claude took over building after that review.
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.agent}:${x.kind}:${x.status}`), ["codex:build:REVIEW", "claude:review:CHANGES", "claude:build-fix:OWNER"]);
    assert.deepEqual(t.engine.rooms.get(room.id).crew, { members: ["codex", "claude"], builder: "claude", reviewer: "codex" });
  } finally {
    t.cleanup();
  }
});

test("a turn that never started is sent again whole: the handoff and the builder's briefing", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: reviewer", failEarly: true, times: 1 },
    { agent: "codex", match: "Your role: reviewer", reply: "Finding: Z.\nTORYO: CHANGES" },
    { agent: "claude", match: "reviewed your last round", failEarly: true, times: 1 },
    { agent: "claude", match: "reviewed your last round", reply: "Fixed Z.\nTORYO: OWNER ok?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], builder: "claude", reviewer: "codex", reviewFirst: true, handoff: "HANDOFF-TEXT-123 is ready." });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "question" });
    const calls = t.calls();
    assert.deepEqual(calls.map((c) => c.kind), ["codex", "codex", "claude", "claude"]);
    assert.match(calls[1].prompt, /HANDOFF-TEXT-123/);
    assert.ok(!calls[1].args.includes("resume"), "nothing to resume after a launch that never started");
    assert.match(calls[3].prompt, /## Your role: builder/);
    assert.match(calls[3].prompt, /Finding: Z\./);
    assert.ok(calls[3].args.includes("--session-id"));
    assert.equal(t.engine.rooms.get(room.id).build.briefed, true);
  } finally {
    t.cleanup();
  }
});

test("a reviewer that keeps leaving out its status still counts against the round limit", async () => {
  const t = await setup([
    { agent: "codex", reply: "Work.\nTORYO: REVIEW S | h.md" },
    { agent: "claude", reply: "Some notes, no status." },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x", settings: { maxRounds: 2 } });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "owner asked" });
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.waiting.kind, "max-rounds");
    assert.equal(r.build.round, 2);
    assert.deepEqual(turns(t.engine, room.id).map((x) => x.kind), ["build", "review", "review-status", "build-fix", "review", "review-status"]);
  } finally {
    t.cleanup();
  }
});

test("a turn that runs out of time asks the owner instead of going quiet", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", hang: true }]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x", settings: { turnTimeoutMin: 0.01 } });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "timeout question" });
    const r = t.engine.rooms.get(room.id);
    assert.equal(r.waiting.kind, "error");
    assert.match(r.waiting.question, /ran out of time/);
    const [turn] = turns(t.engine, room.id);
    assert.equal(turn.state, "failed");
    assert.equal(turn.timedOut, true);
    assert.equal(t.calls().length, 1);
  } finally {
    t.cleanup();
  }
});

test("two planners asking at once both get answered", async () => {
  const t = await setup([
    { agent: "codex", match: "step 1 of 4", times: 1, reply: "Need input.\nTORYO: OWNER Codex question?" },
    { agent: "claude", match: "step 1 of 4", times: 1, reply: "Need input too.\nTORYO: OWNER Claude question?" },
    { agent: "codex", match: "step 1 of 4", reply: "Codex proposal.\nTORYO: PROPOSAL" },
    { agent: "claude", match: "step 1 of 4", reply: "Claude proposal.\nTORYO: PROPOSAL" },
    { reply: "Critique.\nTORYO: CRITIQUE" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "plan", topic: "Storage" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).waitingCount === 2, { label: "two questions" });
    const first = t.engine.rooms.get(room.id).waiting;
    t.engine.answer(room.id, { text: "Answer one." });
    await waitFor(() => t.engine.rooms.get(room.id).plan.pending.length === 1, { label: "first planner done" });
    assert.notEqual(t.engine.rooms.get(room.id).waiting.from, first.from);
    t.engine.answer(room.id, { text: "Answer two." });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "plan-checkpoint", { label: "checkpoint" });
    const qs = t.engine.roomView(room.id).events.filter((e) => e.type === "question" && e.kind === "plan-owner");
    assert.deepEqual(qs.map((q) => q.answer), ["Answer one.", "Answer two."]);
  } finally {
    t.cleanup();
  }
});

test("DONE runs the project's checks before the final review", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Toryo ran the project's checks", write: { path: "status.txt", content: "good" }, reply: "Fixed.\nTORYO: DONE" },
      { agent: "codex", match: "Your role: builder", write: { path: "status.txt", content: "good" }, reply: "Slice 1.\nTORYO: REVIEW S1 | h.md" },
      { agent: "codex", match: "continue straight into the next unfinished slice", write: { path: "status.txt", content: "bad" }, reply: "All done.\nTORYO: DONE" },
      { agent: "claude", match: "every slice of the plan is done", reply: "Final: fine.\nTORYO: APPROVED" },
      { agent: "claude", match: "Your role: reviewer", reply: "ok\nTORYO: APPROVED" },
    ],
    { gates: [{ name: "status is good", command: "grep -q good status.txt" }] },
  );
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "done", timeout: 30_000 });
    const events = t.engine.roomView(room.id).events.filter((e) => e.type === "gate" || e.type === "turn");
    assert.deepEqual(
      events.map((e) => (e.type === "gate" ? `gate:${e.results[0].ok}` : `${e.kind}:${e.status}`)),
      ["build:REVIEW", "gate:true", "review:APPROVED", "build-next:DONE", "gate:false", "build-gate:DONE", "gate:true", "review:APPROVED"],
    );
    assert.match(t.calls().at(-1).prompt, /every slice of the plan is done/);
  } finally {
    t.cleanup();
  }
});

test("checks running when Toryo stops run again on the next start", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW S1 | h.md" },
      { agent: "claude", reply: "ok\nTORYO: OWNER fine?" },
    ],
    { gates: [{ name: "slow", command: "sleep 1; true" }] },
  );
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => [...t.engine.running.values()].some((r) => r.agent === "toryo"), { label: "checks running" });
    t.engine.shutdown();
    await waitFor(() => t.engine.running.size === 0, { label: "stopped" });
    assert.ok(t.engine.store.loadRoom(room.id).activeGate, "the running checks are on disk");

    const second = await t.make();
    await waitFor(() => second.rooms.get(room.id).waiting, { label: "review after the checks", timeout: 30_000 });
    const gates = second.roomView(room.id).events.filter((e) => e.type === "gate");
    assert.equal(gates.length, 1);
    assert.equal(second.rooms.get(room.id).waiting.from, "claude");
    assert.equal(second.rooms.get(room.id).activeGate, null);
  } finally {
    t.cleanup();
  }
});

test("files are read only inside the project, and only up to the limit", async () => {
  const { mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
  const t = await setup([]);
  try {
    writeFileSync(join(t.base, "secret.txt"), "outside");
    mkdirSync(join(t.repo, "docs"));
    writeFileSync(join(t.repo, "docs", "inside.md"), "inside");
    symlinkSync(join(t.base, "secret.txt"), join(t.repo, "link-out"));
    symlinkSync(t.base, join(t.repo, "dir-out"));
    symlinkSync(join(t.repo, "docs", "inside.md"), join(t.repo, "link-in"));
    writeFileSync(join(t.repo, "big.txt"), "é".repeat(1_000_000));
    assert.throws(() => t.engine.readProjectFile("repo", "link-out"), (e) => e.status === 403);
    assert.throws(() => t.engine.readProjectFile("repo", "dir-out/secret.txt"), (e) => e.status === 403);
    assert.throws(() => t.engine.readProjectFile("repo", "../secret.txt"), (e) => e.status === 403);
    assert.equal(t.engine.readProjectFile("repo", "link-in").content, "inside");
    const big = t.engine.readProjectFile("repo", "big.txt");
    assert.equal(big.truncated, true);
    assert.equal(big.content, "é".repeat(750_000));
  } finally {
    t.cleanup();
  }
});

test("a read-only turn can't write to the project, from any tool", async (ctx) => {
  const t = await setup([
    { agent: "claude", match: "Don't change files", write: { path: "ro.txt", content: "x" }, reply: "Tried to write.\nTORYO: REPLY" },
    { agent: "claude", match: "You may change files", write: { path: "rw.txt", content: "x" }, reply: "Wrote.\nTORYO: REPLY" },
  ]);
  try {
    if (!t.engine.readOnly.ok) return ctx.skip(`read-only mounts unavailable: ${t.engine.readOnly.why}`);
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Look around.", to: "claude" });
    await waitFor(() => turns(t.engine, room.id).some((x) => x.state === "done"), { label: "read-only reply" });
    assert.ok(!existsSync(join(t.repo, "ro.txt")));
    assert.match(turns(t.engine, room.id)[0].text, /write refused: EROFS/);
    t.engine.postMessage(room.id, { text: "Now write it.", to: "claude", allowWrite: true });
    await waitFor(() => turns(t.engine, room.id).filter((x) => x.state === "done").length === 2, { label: "write reply" });
    assert.ok(existsSync(join(t.repo, "rw.txt")));
  } finally {
    t.cleanup();
  }
});

test("the Codex app's turn can't be cancelled: a stop waits for it, a second stop lets go", async () => {
  const t = await setup([]);
  try {
    const { ADAPTERS } = await import("../src/agents/index.mjs");
    const { Engine } = await import("../src/engine.mjs");
    const { Store } = await import("../src/store.mjs");
    const { Snapshots } = await import("../src/snapshots.mjs");
    let finish;
    const app = {
      ...ADAPTERS.codexapp,
      detect: async () => ({ installed: true }),
      currentLimits: () => null,
      // Like the real app: a stop doesn't end the turn; only `abandon` stops following it.
      run: ({ abandon, onSubmitted }) =>
        new Promise((resolve) => {
          onSubmitted?.();
          finish = (text) => resolve({ text, sessionId: "thread-1" });
          abandon.addEventListener("abort", () => resolve({ text: "", aborted: true }));
        }),
    };
    const engine = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app } });
    await engine.init({ detect: false });
    const room = engine.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", reviewer: "claude", task: "x", appThread: "thread-1" });
    await waitFor(() => finish, { label: "app turn" });
    engine.postMessage(room.id, { text: "Use tabs.", to: "codexapp", delivery: "now" });
    assert.equal(engine.running.size, 1, "an interrupt doesn't drop the app's turn");
    engine.control(room.id, "stop");
    assert.equal(engine.summary(engine.rooms.get(room.id)).status, "stopping");
    assert.equal(engine.running.size, 1);
    // Its result arrives after the stop and drives nothing.
    finish("Done in the app.\nTORYO: REVIEW S1 | h.md");
    await waitFor(() => engine.running.size === 0, { label: "app turn over" });
    assert.equal(engine.summary(engine.rooms.get(room.id)).status, "stopped");
    assert.equal(engine.rooms.get(room.id).queue.length, 0);

    finish = null;
    engine.control(room.id, "resume");
    await waitFor(() => finish, { label: "next app turn" });
    engine.control(room.id, "stop");
    engine.control(room.id, "stop");
    await waitFor(() => engine.running.size === 0, { label: "let go" });
    assert.ok(engine.roomView(room.id).events.some((e) => e.type === "system" && /stopped waiting for Codex app/.test(e.text)));
  } finally {
    t.cleanup();
  }
});

test("the read-only mount can be turned off per agent", async (ctx) => {
  const t = await setup([{ agent: "claude", write: { path: "ro.txt", content: "x" }, reply: "Wrote.\nTORYO: REPLY" }]);
  try {
    if (!t.engine.readOnly.ok) return ctx.skip("read-only mounts unavailable");
    t.engine.updateConfig({ agents: { claude: { readOnlyMount: false } } });
    const room = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Look around.", to: "claude" });
    await waitFor(() => turns(t.engine, room.id).some((x) => x.state === "done"), { label: "reply" });
    assert.ok(existsSync(join(t.repo, "ro.txt")));
    assert.ok(t.engine.roomView(room.id).events.some((e) => e.type === "system" && /Files changed during Claude's read-only turn/.test(e.text)));
  } finally {
    t.cleanup();
  }
});

test("a swap while a finished round waits for its review still has the old reviewer review it", async () => {
  const t = await setup([
    { agent: "codex", match: "Your role: builder", delayMs: 400, reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "claude", match: "Your role: reviewer", reply: "Fix X.\nTORYO: CHANGES" },
    { agent: "claude", match: "reviewed your last round", reply: "Fixed X.\nTORYO: OWNER Done?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.summary(t.engine.rooms.get(room.id)).running.includes("codex"), { label: "builder running" });
    t.engine.control(room.id, "pause");
    await waitFor(() => t.engine.rooms.get(room.id).queue.some((q) => q.kind === "review"), { label: "review queued while paused" });
    t.engine.control(room.id, "swap");
    assert.equal(t.engine.rooms.get(room.id).queue.find((q) => q.kind === "review").agent, "claude");
    t.engine.control(room.id, "resume");
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "question" });
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.agent}:${x.kind}:${x.status}`), ["codex:build:REVIEW", "claude:review:CHANGES", "claude:build-fix:OWNER"]);
  } finally {
    t.cleanup();
  }
});

test("fixing the checks after DONE leads to the final review, even when the fix says REVIEW", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Toryo ran the project's checks", write: { path: "status.txt", content: "good" }, reply: "Fixed the check.\nTORYO: REVIEW S1 | h.md" },
      { agent: "codex", match: "Your role: builder", write: { path: "status.txt", content: "good" }, reply: "Slice 1.\nTORYO: REVIEW S1 | h.md" },
      { agent: "codex", match: "continue straight into the next unfinished slice", write: { path: "status.txt", content: "bad" }, reply: "All done.\nTORYO: DONE" },
      { agent: "claude", match: "every slice of the plan is done", reply: "Final: fine.\nTORYO: APPROVED" },
      { agent: "claude", match: "Your role: reviewer", reply: "ok\nTORYO: APPROVED" },
    ],
    { gates: [{ name: "status is good", command: "grep -q good status.txt" }] },
  );
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "done", timeout: 30_000 });
    const reviews = t.calls().filter((c) => c.kind === "claude");
    assert.equal(reviews.length, 2);
    assert.match(reviews[1].prompt, /every slice of the plan is done/, "the review after the fix is the final one");
  } finally {
    t.cleanup();
  }
});

test("only approving the final review completes the plan", async () => {
  const t = await setup([
    { agent: "claude", match: "every slice of the plan is done", times: 1, reply: "One more thing.\nTORYO: CHANGES" },
    { agent: "claude", match: "Your role: reviewer", reply: "ok\nTORYO: APPROVED" },
    { agent: "codex", match: "Your role: builder", reply: "Slice 1.\nTORYO: REVIEW S1 | h.md" },
    { agent: "codex", match: "reviewed your last round", reply: "Fixed.\nTORYO: REVIEW S1 | h.md" },
    { agent: "codex", match: "continue straight into the next unfinished slice", times: 1, reply: "All done.\nTORYO: DONE" },
    { agent: "codex", match: "continue straight into the next unfinished slice", reply: "Anything else?\nTORYO: OWNER More?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting, { label: "question" });
    assert.equal(t.engine.rooms.get(room.id).done, false);
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.kind}:${x.status}`), [
      "build:REVIEW",
      "review:APPROVED",
      "build-next:DONE",
      "review:CHANGES",
      "build-fix:REVIEW",
      "review:APPROVED",
      "build-next:OWNER",
    ]);
  } finally {
    t.cleanup();
  }
});

test("an answer to the reviewer's question goes back to the reviewer, which finishes its review", async () => {
  const t = await setup([
    { agent: "claude", match: "The owner answered your question", reply: "Then it's fine.\nTORYO: APPROVED" },
    { agent: "claude", match: "Your role: reviewer", reply: "Is the old endpoint meant to stay?\nTORYO: OWNER Keep the old endpoint?" },
    { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW S1 | h.md" },
    { agent: "codex", match: "continue straight into the next unfinished slice", reply: "Next.\nTORYO: OWNER Which slice?" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "review-owner", { label: "reviewer asked" });
    // A plain reply goes to the reviewer that asked.
    assert.deepEqual(t.engine.postMessage(room.id, { text: "Yes, keep it for now." }).routed.agents, ["claude"]);
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "build-owner", { label: "builder carried on" });
    assert.deepEqual(turns(t.engine, room.id).map((x) => `${x.agent}:${x.kind}:${x.status}`), ["codex:build:REVIEW", "claude:review:OWNER", "claude:review-answer:APPROVED", "codex:build-next:OWNER"]);
    const answered = t.calls().find((c) => /The owner answered your question/.test(c.prompt));
    assert.match(answered.prompt, /Yes, keep it for now\./);
    assert.ok(answered.args.includes("--disallowedTools"), "the reviewer stays read-only");
    assert.deepEqual(t.engine.rooms.get(room.id).build.approved, ["S1"]);
  } finally {
    t.cleanup();
  }
});

test("an answer during the final review lets the reviewer complete the plan", async () => {
  const t = await setup([
    { agent: "claude", match: "The owner answered your question", reply: "Then the plan is complete.\nTORYO: APPROVED" },
    { agent: "claude", match: "every slice of the plan is done", reply: "I recommend shipping as is.\nTORYO: OWNER Ship without the migration?" },
    { agent: "codex", reply: "All done.\nTORYO: DONE" },
  ]);
  try {
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "review-owner", { label: "reviewer asked" });
    t.engine.answer(room.id, { accept: true });
    await waitFor(() => t.engine.rooms.get(room.id).done, { label: "plan complete" });
    const answered = t.calls().find((c) => /The owner answered your question/.test(c.prompt));
    assert.match(answered.prompt, /Go with your recommendation: shipping as is\./);
    assert.match(answered.prompt, /Finish your final review/);
  } finally {
    t.cleanup();
  }
});

test("after an upgrade, an answer to a question from the final review still completes the plan", async () => {
  const t = await setup([
    { agent: "claude", match: "The owner answered your question", reply: "Then the plan is complete.\nTORYO: APPROVED" },
    { agent: "claude", match: "every slice of the plan is done", times: 1, reply: "One question.\nTORYO: OWNER Ship without the migration?" },
    { agent: "claude", match: "every slice of the plan is done", hang: true },
    { agent: "codex", match: "continue straight into the next unfinished slice", reply: "Should not run.\nTORYO: DONE" },
    { agent: "codex", reply: "All done.\nTORYO: DONE" },
  ]);
  try {
    // A question waiting from the final review, saved the way the previous version saved it (no `final`).
    const room = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x" });
    await waitFor(() => t.engine.rooms.get(room.id).waiting?.kind === "review-owner", { label: "final review asked" });
    t.engine.shutdown();
    const saved = t.engine.store.loadRoom(room.id);
    delete saved.waiting.final;
    assert.equal(saved.build.final, true);
    t.engine.store.saveRoom(saved);
    let engine = await t.make();
    engine.answer(room.id, { text: "Yes, ship it." });
    await waitFor(() => engine.rooms.get(room.id).done, { label: "plan complete" });
    assert.ok(!turns(engine, room.id).some((x) => x.kind === "build-next"), "no further building turn");

    // A final review cut off by the restart, its request saved without `final`.
    const two = engine.createRoom({ projectId: "repo", mode: "build", task: "y" });
    await waitFor(() => turns(engine, two.id).some((x) => x.kind === "review" && x.state === "running"), { label: "final review running" });
    engine.shutdown();
    await waitFor(() => !engine.running.size, { label: "stopped" });
    const review = turns(engine, two.id).find((x) => x.kind === "review");
    const { final, ...older } = review.req;
    assert.equal(final, true);
    engine.store.appendEvent(two.id, { id: review.id, req: older });
    engine = await t.make();
    assert.equal(engine.rooms.get(two.id).queue[0].final, true);
  } finally {
    t.cleanup();
  }
});
