import { test } from "node:test";
import assert from "node:assert/strict";
import { BREAK_MS, Timeline, durationWords, sessionWords, workKind } from "../web/phases.js";

const T0 = Date.parse("2026-10-13T10:00:00Z");
const min = 60_000;
const iso = (m) => new Date(T0 + m * min).toISOString();
const turn = (id, kind, from, to, extra = {}) => ({ id, type: "turn", kind, agent: "codex", at: iso(from), startedAt: iso(from), endedAt: to == null ? undefined : iso(to), state: to == null ? "running" : "done", ...extra });
const timeline = (events) => {
  const t = new Timeline();
  for (const e of events) t.add(e);
  return t;
};

test("each kind of turn lands in its phase: building, reviewing (plan checks too), planning, checks, other", () => {
  assert.deepEqual(["build", "build-fix", "build-next", "review", "review-status", "plan-check", "plan-proposal", "plan-synthesis", "gates", "chat", "opinion", "note-answer"].map(workKind), ["build", "build", "build", "review", "review", "review", "plan", "plan", "checks", "chat", "chat", "chat"]);
  const v = timeline([turn("a", "build", 0, 10), turn("b", "review", 10, 15), turn("c", "plan-proposal", 15, 18), turn("d", "chat", 18, 19)]).view({ now: T0 + 20 * min });
  assert.deepEqual([v.totals.build, v.totals.review, v.totals.plan, v.totals.other].map((ms) => ms / min), [10, 5, 3, 1]);
  assert.equal(v.length, 20 * min);
});

test("turns side by side in one phase count once; phases that overlap are each counted, and it says so", () => {
  // Two planners proposing at once, 0–10 and 5–12: 12 minutes of planning, not 17. A reply during the planning.
  const v = timeline([turn("a", "plan-proposal", 0, 10), turn("b", "plan-proposal", 5, 12), turn("c", "chat", 8, 9)]).view({ now: T0 + 12 * min });
  assert.equal(v.totals.plan, 12 * min);
  assert.equal(v.totals.other, 1 * min);
  assert.equal(v.overlap, true);
  assert.equal(timeline([turn("a", "build", 0, 5), turn("b", "review", 5, 8)]).view({ now: T0 + 8 * min }).overlap, false);
});

test("a turn running grows to now; a turn changed again replaces what it said; one never sent counts nothing; the Codex app's from when it took the turn up", () => {
  const t = timeline([turn("a", "build", 0, null)]);
  assert.equal(t.view({ now: T0 + 7 * min }).totals.build, 7 * min);
  assert.equal(t.view({ now: T0 + 7 * min }).segments[0].running, true);
  t.add(turn("a", "build", 0, 4));
  assert.equal(t.view({ now: T0 + 7 * min }).totals.build, 4 * min);
  t.add({ ...turn("b", "build", 5, 6), state: "deferred" });
  assert.equal(t.view({ now: T0 + 7 * min }).totals.build, 4 * min);
  t.add({ ...turn("c", "build", 10, 30), agent: "codexapp", pickedUpAt: iso(25) });
  assert.equal(t.view({ now: T0 + 30 * min }).totals.build, 9 * min, "4 + 5 minutes of the app actually working");
});

test("the Codex app: its queue isn't work: nothing before it takes the turn up, from then on after, nothing for a turn it never took up, and the totals never go back", () => {
  const app = (extra) => ({ ...turn("c", "build", 0, null), agent: "codexapp", ...extra });
  const t = timeline([app()]);
  const seen = [t.view({ now: T0 + 5 * min }).totals.build];
  t.add(app({ pickedUpAt: iso(6) }));
  seen.push(t.view({ now: T0 + 8 * min }).totals.build);
  t.add({ ...app({ pickedUpAt: iso(6) }), state: "done", endedAt: iso(10) });
  seen.push(t.view({ now: T0 + 12 * min }).totals.build);
  assert.deepEqual(seen.map((ms) => ms / min), [0, 2, 4]);
  assert.equal(t.view({ now: T0 + 12 * min }).segments[0].from, T0 + 6 * min);
  // Ended without the app ever taking it up (stopped in its queue, or from before pickups were recorded).
  const never = timeline([{ ...turn("d", "build", 0, 10), agent: "codexapp" }]).view({ now: T0 + 10 * min });
  assert.deepEqual([never.totals.build, never.segments.length], [0, 0]);
});

test("checks: a run that ended counts once, never also as still running; one cut short keeps the time it ran and says why", () => {
  const t = timeline([{ id: "e1", type: "gate", at: iso(5), startedAt: iso(2), runId: "g1", results: [{ name: "t", ok: true, seconds: 180 }] }]);
  // The desk's list of what runs can still name a run whose result has just come in.
  const v = t.view({ now: T0 + 9 * min, live: [{ id: "g1", kind: "gates", agent: "toryo", startedAt: iso(2) }] });
  assert.deepEqual([v.totals.checks, v.segments.length], [3 * min, 1]);
  t.add({ id: "m1", type: "mark", what: "checks", at: iso(8), startedAt: iso(6), runId: "g2", why: "stopped" });
  const cut = t.view({ now: T0 + 9 * min, live: [{ id: "g2", kind: "gates", agent: "toryo", startedAt: iso(6) }] });
  assert.equal(cut.totals.checks, 5 * min);
  assert.deepEqual(cut.segments.map((x) => [x.cut ?? null, x.inRoom ?? true, x.running]), [[null, true, false], ["stopped", false, false]]);
});

test("checks: from their recorded start, or, in a room from before that, their end less their checks' times", () => {
  const recorded = timeline([{ id: "g", type: "gate", at: iso(10), startedAt: iso(6), results: [{ name: "t", ok: true, seconds: 60 }] }]).view({ now: T0 + 10 * min });
  assert.equal(recorded.totals.checks, 4 * min);
  const older = timeline([{ id: "g", type: "gate", at: iso(10), results: [{ name: "a", ok: true, seconds: 90 }, { name: "b", ok: false, seconds: 30 }] }]).view({ now: T0 + 10 * min });
  assert.equal(older.totals.checks, 2 * min);
  assert.deepEqual([older.segments[0].estimated, older.segments[0].ok], [true, false]);
  // A checks run going on now (no event yet): from what's running.
  assert.equal(timeline([]).view({ now: T0 + 5 * min, live: [{ id: "g2", kind: "gates", agent: "toryo", startedAt: iso(2) }] }).totals.checks, 3 * min);
});

test("waiting for you: from a question to its answer, questions open at once counted once, and a close time nobody recorded not counted", () => {
  const q = (id, from, extra) => ({ id, type: "question", at: iso(from), open: false, ...extra });
  const v = timeline([
    q("q1", 0, { closedAt: iso(10) }),
    q("q2", 5, { closedAt: iso(12) }),
    // Closed before close times were recorded: its answer's time says.
    q("q3", 20),
    { id: "o", type: "owner", kind: "answer", at: iso(26), answers: [{ id: "q3" }] },
    // Closed, and nothing says when: left out.
    q("q4", 30),
    // Still open: waiting until now.
    { id: "q5", type: "question", at: iso(40), open: true },
  ]).view({ now: T0 + 45 * min });
  assert.equal(v.totals.waiting, (12 + 6 + 5) * min);
});

test("paused and held time, from the marks; in a room from before them, from its pause and resume sentences", () => {
  const mark = (id, what, m) => ({ id, type: "mark", what, at: iso(m) });
  const v = timeline([mark("m1", "paused", 0), mark("m2", "resumed", 10), mark("m3", "held", 20), mark("m4", "free", 25), mark("m5", "stopped", 30)]).view({ now: T0 + 40 * min });
  assert.equal(v.totals.paused, (10 + 5 + 10) * min);
  const said = (id, text, m) => ({ id, type: "system", text, at: iso(m) });
  const older = timeline([said("s1", "Pausing: the current turn finishes, nothing new starts.", 0), said("s2", "Resumed.", 3), said("s3", "Waiting: you hold Claude. It goes on when that ends.", 5)]).view({ now: T0 + 10 * min });
  assert.equal(older.totals.paused, 3 * min, "a hold's end isn't known in older rooms: not counted");
});

test("a pause ends however the room goes on: Resume, a message to a stopped room (older rooms too), or work it sent after", () => {
  const said = (id, text, m) => ({ id, type: "system", text, at: iso(m) });
  const stop = said("s1", "Stopped. Nothing runs until you resume or start something new.", 0);
  assert.equal(timeline([stop, said("s2", "Resumed by your message.", 4)]).view({ now: T0 + 10 * min }).totals.paused, 4 * min);
  // A stop a new build cleared, in a room from before marks: no sentence, but its first turn shows it went on.
  const rebuilt = timeline([stop, turn("b", "build", 6, 9)]);
  assert.equal(rebuilt.view({ now: T0 + 10 * min }).totals.paused, 6 * min);
  assert.deepEqual([timeline([stop]).pausedNow(), rebuilt.pausedNow()], [true, false]);
  // A turn already running when the pause came doesn't end it.
  assert.equal(timeline([turn("a", "build", 0, 5), said("s1", "Pausing: the current turn finishes, nothing new starts.", 2)]).view({ now: T0 + 10 * min }).totals.paused, 8 * min);
  // Nor does following a turn the Codex app already had, after a restart.
  const followed = { ...turn("f", "build", 3, 5), agent: "codexapp", pickedUpAt: iso(3), req: { attach: { marker: "m" } } };
  assert.equal(timeline([stop, followed]).view({ now: T0 + 10 * min }).totals.paused, 10 * min);
  // Nor a handoff brought in to be reviewed first (a build started from finished work while paused): only Resume.
  const mark = (id, what, m) => ({ id, type: "mark", what, at: iso(m) });
  const handedOver = timeline([mark("m1", "paused", 5), { ...turn("h", "build", 10, 10), imported: true }]);
  assert.deepEqual([handedOver.view({ now: T0 + 15 * min }).totals.paused, handedOver.pausedNow()], [10 * min, true]);
  assert.deepEqual([handedOver.view({ now: T0 + 15 * min }).totals.build, handedOver.view({ now: T0 + 15 * min }).segments.length], [0, 0], "no work done here");
  handedOver.add(mark("m2", "resumed", 20));
  assert.deepEqual([handedOver.view({ now: T0 + 25 * min }).totals.paused, handedOver.pausedNow()], [15 * min, false]);
});

test("long stretches with nothing running are breaks, labelled waiting for you or idle; the totals don't change", () => {
  const v = timeline([
    turn("a", "build", 0, 10),
    { id: "q", type: "question", at: iso(10), open: false, closedAt: iso(100) },
    turn("b", "build", 100, 110),
    turn("c", "build", 300, 305),
  ]).view({ now: T0 + 305 * min });
  assert.deepEqual(v.breaks.map((b) => [(b.from - T0) / min, (b.to - T0) / min, b.why]), [[10, 100, "waiting"], [110, 300, "idle"]]);
  assert.equal(v.totals.build, 25 * min);
  assert.equal(timeline([turn("a", "build", 0, 10), turn("b", "build", 10 + BREAK_MS / min - 1, 50)]).view({ now: T0 + 50 * min }).breaks.length, 0, "a shorter gap stays as it is");
});

test("in words: durations, and the session in a sentence", () => {
  assert.deepEqual([12_000, 22 * min, 190 * min, 52 * 60 * min].map(durationWords), ["12 s", "22 min", "3 h 10", "2 d 4 h"]);
  const v = timeline([turn("a", "build", 0, 190), turn("b", "review", 190, 255), { id: "q", type: "question", at: iso(255), open: true }]).view({ now: T0 + 320 * min });
  assert.equal(sessionWords(v), "This session, 5 h 20: building 3 h 10, reviewing 1 h 05, waiting for you 1 h 05.");
  assert.equal(sessionWords(timeline([]).view({ now: T0 })), "This session, 0 s, nothing run yet.");
  // A little work, under a second: said, not taken for nothing.
  const tiny = timeline([{ ...turn("a", "chat", 0, 0), endedAt: new Date(T0 + 300).toISOString() }]).view({ now: T0 + 400 });
  assert.equal(sessionWords(tiny), "This session, 0 s, under a second of work so far.");
});

test("a room with thousands of events: each one taken in on its own, and the view stays quick", () => {
  const t = new Timeline();
  const events = [];
  for (let i = 0; i < 6000; i++) events.push(i % 3 === 0 ? turn(`t${i}`, i % 2 ? "build" : "review", i, i + 1) : { id: `s${i}`, type: "system", text: "A note.", at: iso(i) });
  const started = performance.now();
  for (const e of events) t.add(e);
  const took = performance.now() - started;
  const v0 = performance.now();
  // A change to one event is one add, then a view: nothing else is read again.
  t.add(turn("t3", "build", 3, 5));
  const v = t.view({ now: T0 + 6001 * min });
  const viewed = performance.now() - v0;
  assert.ok(took < 500, `adding 6000 events took ${took} ms`);
  assert.ok(viewed < 100, `a change and a view took ${viewed} ms`);
  assert.ok(v.totals.build > 0 && v.totals.review > 0);
});
