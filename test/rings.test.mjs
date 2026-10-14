import { test } from "node:test";
import assert from "node:assert/strict";
import { markAnimation, phases, ringFor, ringParts, workKind } from "../web/rings.js";

const room = (status, { working = [], questions = [] } = {}) => ({ status, working: working.map((kind) => ({ agent: "codex", kind })), questions: questions.map((kind) => ({ id: kind, kind })) });

test("each kind of work has its ring: building, reviewing, planning, the checks, or a reply", () => {
  assert.deepEqual(
    ["build", "build-fix", "build-notes", "review", "review-answer", "plan-check", "plan-proposal", "plan-synthesis", "gates", "chat", "note-answer", "opinion"].map(workKind),
    ["build", "build", "build", "review", "review", "review", "plan", "plan", "checks", "chat", "chat", "chat"],
  );
});

test("a room's ring says what it's doing, and what needs you comes on top of anything else", () => {
  const cases = [
    [room("idle"), { ring: "idle", needs: false }],
    [room("running", { working: ["build"] }), { ring: "build", needs: false }],
    [room("running", { working: ["review"] }), { ring: "review", needs: false }],
    [room("running", { working: ["plan-critique"] }), { ring: "plan", needs: false }],
    [room("running", { working: ["gates"] }), { ring: "checks", needs: false }],
    // A question waits: orange in place, or outside the ring of whoever works.
    [room("waiting", { questions: ["chat-owner"] }), { ring: "needs", needs: false }],
    [room("waiting", { working: ["build"], questions: ["build-owner"] }), { ring: "build", needs: true }],
    // Still rings: paused (or stopped) and held, with the orange outside if a question waits; done; failed.
    [room("paused"), { ring: "paused", needs: false }],
    [room("stopped", { questions: ["chat-owner"] }), { ring: "paused", needs: true }],
    [room("held"), { ring: "held", needs: false }],
    [room("done"), { ring: "done", needs: false }],
    [room("waiting", { questions: ["error"] }), { ring: "error", needs: false }],
    [room("waiting", { working: ["chat"], questions: ["error", "chat-owner"] }), { ring: "error", needs: false }],
    // Finishing the turn that was running while the room pauses: still at work.
    [room("pausing", { working: ["build"] }), { ring: "build", needs: false }],
  ];
  for (const [r, expected] of cases) assert.deepEqual(ringFor(r), expected, JSON.stringify(r));
  // Older summaries without the question list: the one the room waits on.
  assert.deepEqual(ringFor({ status: "waiting", waiting: { kind: "build-owner" } }), { ring: "needs", needs: false });
});

test("rings share one clock: a tile drawn again carries on where it was", () => {
  const at = (s, name) => Number(s.match(new RegExp(`--${name}:(-?\\d+)ms`))[1]);
  const first = phases(10_000);
  assert.deepEqual([at(first, "phb"), at(first, "phn"), at(first, "phm")], [-(10_000 % 3200), -(10_000 % 1700), -(10_000 % 2400)]);
  // 1.5 s later the delays have moved on by 1.5 s (modulo each period), so the animation doesn't start over.
  const later = phases(11_500);
  assert.equal(at(later, "phb"), -(11_500 % 3200));
  assert.ok(at(first, "phb") <= 0 && at(later, "phb") <= 0);
});

test("a ring's parts: the sparkler for work, a badge for a still state, the outer pulse when a question waits", () => {
  const icon = (n) => `<i>${n}</i>`;
  const building = ringParts({ ring: "build", needs: true }, 32, icon, 0);
  assert.match(building.attrs, /data-ring="build" data-needs/);
  assert.match(building.inner, /<canvas class="sparkler" data-size="32"/);
  assert.match(building.style, /--size:32px;--phb:/);
  assert.equal(ringParts({ ring: "needs", needs: false }, 32, icon, 0).attrs, 'data-ring="needs"');
  assert.equal(ringParts({ ring: "done", needs: false }, 32, icon, 0).inner, '<span class="badge"><i>check</i></span>');
  assert.equal(ringParts({ ring: "held", needs: false }, 32, icon, 0).inner, '<span class="badge"><i>lock</i></span>');
  assert.equal(ringParts({ ring: "paused", needs: false }, 32, icon, 0).inner, '<span class="badge"><i>pause</i></span>');
  assert.equal(ringParts({ ring: "idle", needs: false }, 32, icon, 0).inner, "");
  assert.equal(ringParts({ ring: "checks", needs: false }, 32, icon, 0).inner, "");
});

test("the live logo breathes the blocks of the work going on anywhere, on the same clock", () => {
  assert.equal(markAnimation(new Set(), 0), "");
  assert.equal(markAnimation(new Set(["build"]), 1000), "mk-build var(--m-breathe) ease-in-out -1000ms infinite");
  assert.equal(markAnimation(new Set(["review", "plan", "checks", "chat"]), 4000), "mk-plan var(--m-breathe) ease-in-out -800ms infinite, mk-review var(--m-breathe) ease-in-out -800ms infinite");
});

test("from real summaries: with a question waiting, a paused room keeps its dashed ring and a held one its lock, under the orange", async () => {
  const { setup, waitFor } = await import("./helpers.mjs");
  const t = await setup([
    { agent: "codex", match: "Ask me", reply: "TORYO: OWNER Which one?" },
    { agent: "codex", match: "Take your time", delayMs: 1500, reply: "Done.\nTORYO: REPLY" },
    { reply: "Noted.\nTORYO: REPLY" },
  ]);
  const summary = (r) => t.engine.summary(t.engine.rooms.get(r.id));
  try {
    // Paused: a question in chat, then you pause the room. Its status is "waiting"; its ring is still the pause.
    const a = t.engine.createRoom({ projectId: "repo", mode: "chat", title: "a", members: ["codex"], text: "Ask me something.", to: "codex" });
    await waitFor(() => summary(a).questions.length === 1 && !summary(a).running.length, { label: "a's question" });
    t.engine.control(a.id, "pause");
    assert.equal(summary(a).status, "waiting");
    assert.deepEqual(ringFor(summary(a)), { ring: "paused", needs: true });
    // Held: a question waits, and the only work queued is for an agent you hold.
    const b = t.engine.createRoom({ projectId: "repo", mode: "chat", title: "b", members: ["codex", "claude"], text: "Ask me something.", to: "codex" });
    await waitFor(() => summary(b).questions.length === 1 && !summary(b).running.length, { label: "b's question" });
    t.engine.deskControl("hold", { target: "claude" });
    t.engine.postMessage(b.id, { text: "Your view?", to: "claude", answering: false });
    await waitFor(() => summary(b).held, { label: "b held" });
    assert.equal(summary(b).status, "waiting");
    assert.deepEqual(ringFor(summary(b)), { ring: "held", needs: true });
    // Paused while a turn runs: it finishes, and until then the ring shows the work.
    const c = t.engine.createRoom({ projectId: "repo", mode: "chat", title: "c", members: ["codex"], text: "Take your time.", to: "codex" });
    await waitFor(() => summary(c).running.length === 1, { label: "c working" });
    t.engine.control(c.id, "pause");
    assert.equal(summary(c).status, "pausing");
    assert.deepEqual(ringFor(summary(c)), { ring: "chat", needs: false });
    await waitFor(() => !summary(c).running.length, { label: "c's turn done" });
    assert.deepEqual(ringFor(summary(c)), { ring: "paused", needs: false });
    t.engine.deskControl("release", { target: "claude" });
    await waitFor(() => !summary(b).running.length && !t.engine.rooms.get(b.id).queue.length, { label: "b's reply" });
  } finally {
    t.cleanup();
  }
});
