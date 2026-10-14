import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultGuard, evaluate, expire, holdsFor, parseGuard, setPolicy } from "../src/guard.mjs";
import { parseDesk } from "../src/desk.mjs";
import { mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const HOUR = 3_600_000;
const iso = (t) => new Date(t).toISOString();
const w = (type, used, resetsAt, agent = "codex") => ({ type, used, resetsAt: resetsAt == null ? null : iso(resetsAt), agent });

// ---------------------------------------------------------------- the rules, on a fixed clock

test("at the threshold exactly, the guard holds; just under, it doesn't; a late reading of a window that has reset holds nothing", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const g = defaultGuard();
  assert.deepEqual(evaluate(g, "openai", [w("weekly", 89.9, now + HOUR)], now), []);
  const [c] = evaluate(g, "openai", [w("weekly", 90, now + HOUR)], now);
  assert.equal(c.kind, "hold");
  assert.equal(holdsFor(g, "openai", now).length, 1);
  // A reading that arrives after its window reset: about a window that's over.
  const late = defaultGuard();
  assert.deepEqual(evaluate(late, "openai", [w("weekly", 99, now - 1)], now), []);
});

test("both windows can hold at once; the 5-hour one resetting leaves the weekly one holding", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const g = defaultGuard();
  evaluate(g, "anthropic", [w("five_hour", 95, now + HOUR, "claude"), w("weekly", 91, now + 50 * HOUR, "claude")], now);
  assert.equal(holdsFor(g, "anthropic", now).length, 2);
  const changes = expire(g, now + HOUR);
  assert.deepEqual(changes.map((c) => [c.kind, c.why, c.key]), [["end", "reset", "anthropic:five_hour"]]);
  assert.deepEqual(holdsFor(g, "anthropic", now + HOUR).map((h) => h.type), ["weekly"]);
});

test("a hold with no known reset is never released by guesswork: a fresh reading under the threshold ends it", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const g = defaultGuard();
  evaluate(g, "openai", [w("weekly", 95, null)], now);
  assert.deepEqual(expire(g, now + 1000 * HOUR), []);
  assert.equal(holdsFor(g, "openai", now + 1000 * HOUR).length, 1);
  assert.deepEqual(evaluate(g, "openai", [w("weekly", 3, null)], now + 1000 * HOUR).map((c) => [c.kind, c.why]), [["end", "fell"]]);
});

test("with automatic release off, a reset makes the hold ready for you, and nothing lets the work go by itself", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const g = defaultGuard();
  setPolicy(g, "openai", { autoRelease: false });
  evaluate(g, "openai", [w("weekly", 93, now + HOUR)], now);
  assert.deepEqual(expire(g, now + HOUR).map((c) => c.kind), ["ready"]);
  assert.equal(holdsFor(g, "openai", now + HOUR)[0].state, "ready");
  // A fresh reading of the new window, under the threshold: still waits for you.
  assert.deepEqual(evaluate(g, "openai", [w("weekly", 2, now + 169 * HOUR)], now + 2 * HOUR).map((c) => c.kind), []);
  assert.equal(holdsFor(g, "openai", now + 2 * HOUR).length, 1);
  // Turning automatic release back on lets it go.
  setPolicy(g, "openai", { autoRelease: true });
  assert.deepEqual(expire(g, now + 2 * HOUR).map((c) => [c.kind, c.why]), [["end", "reset"]]);
});

test("changing a rule looks again at that rule only: off or above the reading ends its hold, lower creates one", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const g = defaultGuard();
  const windows = [w("five_hour", 95, now + HOUR), w("weekly", 80, now + 50 * HOUR)];
  evaluate(g, "openai", windows, now);
  assert.deepEqual(Object.keys(g.holds), ["openai:five_hour"]);
  setPolicy(g, "openai", { rules: { weekly: { at: 75 } } });
  assert.deepEqual(evaluate(g, "openai", windows, now, { types: ["weekly"], settings: true }).map((c) => [c.kind, c.key]), [["hold", "openai:weekly"]]);
  setPolicy(g, "openai", { rules: { five_hour: { enabled: false } } });
  assert.deepEqual(evaluate(g, "openai", windows, now, { types: ["five_hour"], settings: true }).map((c) => [c.kind, c.why]), [["end", "off"]]);
  assert.deepEqual(Object.keys(g.holds), ["openai:weekly"]);
  setPolicy(g, "openai", { rules: { weekly: { at: 85 } } });
  assert.deepEqual(evaluate(g, "openai", windows, now, { types: ["weekly"], settings: true }).map((c) => [c.kind, c.why]), [["end", "raised"]]);
  assert.throws(() => setPolicy(g, "openai", { rules: { weekly: { at: 150 } } }), /from 1 to 100/);
  // What changed: only rules that really did, and a rule for a window that had none.
  assert.deepEqual(setPolicy(g, "openai", { rules: { weekly: { at: 85 }, "5-hour": { enabled: false } } }), []);
  assert.deepEqual(setPolicy(g, "openai", { rules: { weekly: { at: 86 }, "5-hour": { enabled: false } } }), ["weekly"]);
  assert.deepEqual(setPolicy(g, "openai", { rules: { "weekly-opus": { at: 90 } } }), ["weekly_opus"]);
  assert.deepEqual(setPolicy(g, "openai", { autoRelease: false }), []);
});

test("pausing a window's guard until its reset lets the allowance run until then, and it guards again after", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const g = defaultGuard();
  evaluate(g, "openai", [w("weekly", 93, now + HOUR)], now);
  g.exceptions["openai:weekly"] = { until: iso(now + HOUR), at: iso(now) };
  assert.deepEqual(holdsFor(g, "openai", now), []);
  // The hold ends at the reset, and takes its exception with it.
  assert.deepEqual(expire(g, now + HOUR).map((c) => [c.kind, c.why]), [["end", "reset"]]);
  assert.deepEqual(g.exceptions, {});
  // The new window over the threshold: held again.
  evaluate(g, "openai", [w("weekly", 91, now + 169 * HOUR)], now + 2 * HOUR);
  assert.equal(holdsFor(g, "openai", now + 2 * HOUR).length, 1);
});

test("desk.json: version 1 gets the guard with its notice; version 2 keeps your settings; anything invalid is refused, never dropped", () => {
  const v1 = parseDesk({ version: 1, paused: null, holds: { claude: { at: "2026-10-13T08:00:00.000Z" } } }, "desk.json", ["codex", "claude"]);
  assert.equal(v1.migrated, true);
  assert.deepEqual(Object.keys(v1.desk.holds), ["claude"], "your holds stay");
  assert.equal(v1.desk.guard.notice.pending, true);
  assert.deepEqual(v1.desk.guard.policies, {});
  const yours = { notice: { pending: false, at: "2026-10-13T09:00:00.000Z" }, policies: { anthropic: { autoRelease: false, rules: { five_hour: { enabled: false, at: 90 }, weekly: { enabled: true, at: 95 } } } }, holds: {}, exceptions: {} };
  const v2 = parseDesk({ version: 2, holds: {}, guard: yours }, "desk.json", ["codex", "claude"]);
  assert.equal(v2.migrated, false);
  assert.deepEqual(v2.desk.guard, yours);
  assert.match(parseDesk({ version: 2, guard: { holds: { "openai:weekly": { group: "openai" } } } }, "desk.json", []).problem, /the guard's hold “openai:weekly” isn't valid/);
  assert.throws(() => parseGuard({ policies: { openai: { autoRelease: "yes", rules: {} } } }), /settings for “openai”/);
});

// ---------------------------------------------------------------- the desk, with fake agents and its own clock

/** A clock the test moves, and an engine that decides by it. */
async function guarded(rules) {
  const clock = { now: Date.now() };
  const t = await setup(rules, { engine: { now: () => clock.now, guardPollMs: 0 } });
  return { t, clock };
}

/** An agent reports usage, as Codex's logs do between turns: `windows` [{ type, used, resetsAt }]. */
async function report(e, clock, agent, windows) {
  clock.now += 1000;
  const reading = { status: "allowed", sourceAt: iso(clock.now), windows: windows.map((x) => ({ minutes: x.type === "weekly" ? 10080 : 300, ...x, resetsAt: x.resetsAt == null ? null : iso(x.resetsAt) })) };
  e.adapters = { ...e.adapters, [agent]: { ...e.adapters[agent], currentLimits: () => reading } };
  e.agentStatus = { ...e.agentStatus, [agent]: { installed: true } };
  await e.refreshUsage();
}

const summary = (e, id) => e.summary(e.rooms.get(id));

test("a new desk starts with the guard on at 90% of both windows, and says so once; an existing desk keeps your holds and gets the same", async () => {
  const { t } = await guarded([]);
  try {
    const desk = JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8"));
    assert.equal(desk.version, 2);
    assert.equal(desk.guard.notice.pending, true);
    const view = t.engine.deskView().guard;
    assert.ok(view.policies.every((p) => p.autoRelease && p.rules.every((r) => r.enabled && r.at === 90)));
    assert.deepEqual(view.policies.find((p) => p.group === "openai").agents.sort(), ["codex", "codexapp"]);
    // Read once: noted, and it stays noted after a restart.
    t.engine.deskControl("guard-ok");
    t.engine.shutdown();
    t.engine = await t.make();
    assert.equal(t.engine.deskView().guard.notice.pending, false);
    // An existing desk from before the guard: your hold stays, and the guard comes with its notice.
    t.engine.shutdown();
    writeFileSync(join(t.home, "desk.json"), JSON.stringify({ version: 1, paused: null, holds: { claude: { at: "2026-10-13T08:00:00.000Z" } } }));
    t.engine = await t.make();
    assert.deepEqual(t.engine.deskView().holds.map((h) => h.key), ["claude"]);
    assert.equal(t.engine.deskView().guard.notice.pending, true);
    assert.equal(JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8")).version, 2, "saved as migrated");
    // Switched on with a reading already over the threshold (Claude said 95% before the guard existed): held at once.
    t.engine.shutdown();
    writeFileSync(join(t.home, "limits.json"), JSON.stringify({ version: 2, agents: { claude: { status: "allowed", windows: { weekly: { type: "weekly", minutes: 10080, used: 95, resetsAt: iso(Date.now() + 50 * HOUR), sourceAt: iso(Date.now() - HOUR), receivedAt: iso(Date.now() - HOUR) } } } } }));
    writeFileSync(join(t.home, "desk.json"), JSON.stringify({ version: 1, paused: null, holds: {} }));
    t.engine = await t.make();
    assert.match(t.engine.blockersFor({ agent: "claude", kind: "chat" }).join(), /Claude's weekly limit is at 95%/);
    // Your own settings survive a restart as you left them.
    t.engine.deskControl("guard", { target: "claude", enabled: false });
    t.engine.deskControl("guard", { target: "codex", rules: { weekly: { at: 95 } }, autoRelease: false });
    t.engine.shutdown();
    t.engine = await t.make();
    const p = Object.fromEntries(t.engine.deskView().guard.policies.map((x) => [x.group, x]));
    assert.ok(p.anthropic.rules.every((r) => !r.enabled));
    assert.equal(p.openai.rules.find((r) => r.type === "weekly").at, 95);
    assert.equal(p.openai.autoRelease, false);
    assert.equal(t.engine.deskView().guard.notice.pending, false, "changing the guard counts as having read the notice");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a turn reports 92% and then fails: its automatic retry waits under the guard and runs once after the reset, after your own hold too", async () => {
  const soon = () => Math.round((clock.now + HOUR) / 1000);
  let clock;
  const g = await guarded([]);
  clock = g.clock;
  const { t } = g;
  const rules = [
    { agent: "claude", match: "Plan the export", times: 1, fail: true, rateLimit: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.92, resetsAt: soon() } } } },
    { agent: "claude", match: "Plan the export", reply: "Here's how.\nTORYO: REPLY", rateLimit: null },
  ];
  writeFileSync(process.env.FAKE_SCRIPT, JSON.stringify({ rules, log: join(t.base, "calls.jsonl") }));
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Plan the export.", to: "claude" });
    await waitFor(() => summary(e, room.id).blocked?.length, { label: "the retry held" });
    const [blocked] = summary(e, room.id).blocked;
    assert.equal(blocked.agent, "claude");
    assert.match(blocked.reasons.join(), /Claude's 5-hour limit is at 92% \(the usage guard holds at 90%\) until it resets/);
    assert.equal(t.notes.filter((n) => /Holding Claude/.test(n.t)).length, 1, "one notification for the hold");
    assert.match(e.roomView(room.id).events.filter((x) => x.type === "system").map((x) => x.text).join("\n"), /Retrying once[\s\S]*Waiting: Claude's 5-hour limit/);
    // Your own hold on Claude too; the reset passes with no new reading (Claude reports only while it works).
    e.deskControl("hold", { target: "claude" });
    clock.now += 2 * HOUR;
    e.checkGuards();
    assert.deepEqual(e.deskView().guard.holds, []);
    assert.deepEqual(summary(e, room.id).blocked[0].reasons, ["you hold Claude"]);
    assert.equal(t.notes.filter((n) => /The guard released Claude/.test(n.t)).length, 1);
    e.deskControl("release", { target: "claude" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done" && /Here's how/.test(x.text ?? "")), { label: "the retry ran" });
    assert.equal(t.calls().filter((c) => c.kind === "claude").length, 2, "the failed turn and its one retry");
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("Codex's allowance is shared: a reading from either interface holds both, and the guard's state survives a restart that comes after the reset", async () => {
  const { t, clock } = await guarded([]);
  try {
    let e = t.engine;
    await report(e, clock, "codex", [{ type: "weekly", used: 93, resetsAt: clock.now + 5 * HOUR }]);
    for (const agent of ["codex", "codexapp"]) assert.match(e.blockersFor({ agent, kind: "build" }).join(), /Codex's weekly limit is at 93%/);
    assert.deepEqual(e.blockersFor({ agent: "claude", kind: "review" }), []);
    assert.deepEqual(e.blockersFor({ agent: "toryo", kind: "gates" }), [], "the project's checks aren't held by the guard");
    // Stopped, and started again after the reset (a laptop that slept through it): released before anything starts.
    e.shutdown();
    clock.now += 6 * HOUR;
    e = t.engine = await t.make();
    assert.deepEqual(e.deskView().guard.holds, []);
    assert.deepEqual(JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8")).guard.holds, {});
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a Codex turn whose session log says 91% weekly holds both Codex interfaces as soon as the turn ends", async () => {
  const later = Math.round((Date.now() + 50 * HOUR) / 1000);
  const { t } = await guarded([
    { agent: "codex", match: "Which database", reply: "SQLite.\nTORYO: REPLY", codexUsage: { primary: { used_percent: 40, window_minutes: 300, resets_at: later - 40 * 3600 }, secondary: { used_percent: 91, window_minutes: 10080, resets_at: later } } },
  ]);
  try {
    const e = t.engine;
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], text: "Which database?", to: "codex" });
    await waitFor(() => turns(e, room.id).some((x) => x.state === "done"), { label: "Codex's reply" });
    assert.equal(e.limits.codex.windows.find((x) => x.type === "weekly").used, 91);
    assert.deepEqual(e.deskView().guard.holds.map((h) => [h.group, h.type, h.used]), [["openai", "weekly", 91]]);
    for (const agent of ["codex", "codexapp"]) assert.match(e.blockersFor({ agent, kind: "chat" }).join(), /Codex's weekly limit is at 91%/);
    assert.equal(t.notes.filter((n) => /Holding Codex: its weekly limit is at 91%/.test(n.t)).length, 1);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a desk that slept through a reset decides it before starting anything: the next room starts at once, with the held one, before any timer", async () => {
  const { t, clock } = await guarded([{ agent: "claude", reply: "Hello.\nTORYO: REPLY", rateLimit: null }]);
  try {
    const e = t.engine;
    await report(e, clock, "claude", [{ type: "five_hour", used: 99, resetsAt: clock.now + HOUR }]);
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Hi.", to: "claude" });
    assert.equal(summary(e, room.id).status, "held");
    clock.now += 2 * HOUR;
    const next = e.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "Still there?", to: "claude" });
    for (const id of [room.id, next.id]) await waitFor(() => turns(e, id).some((x) => x.state === "done"), { label: "a reply" });
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("Release names every window the guard still holds, with the command and MCP arguments to pause each until its reset", async () => {
  const { t, clock } = await guarded([]);
  try {
    const e = t.engine;
    e.deskControl("hold", { target: "codex" });
    await report(e, clock, "codexapp", [
      { type: "five_hour", used: 95, resetsAt: clock.now + HOUR },
      { type: "weekly", used: 91, resetsAt: clock.now + 50 * HOUR },
    ]);
    const res = e.deskControl("release", { target: "codex" });
    assert.match(res.message, /^Released Codex \(headless and the Codex app\)\./);
    assert.deepEqual(res.offers.map((o) => o.command).sort(), ["toryo guard codex --window five-hour --pause-until-reset", "toryo guard codex --window weekly --pause-until-reset"]);
    assert.deepEqual(res.offers.find((o) => /weekly/.test(o.command)).mcp, { tool: "toryo_guard", arguments: { target: "codex", window: "weekly", action: "pause-until-reset" } });
    assert.match(res.message, /The usage guard still holds Codex: its 5-hour limit is at 95%/);
    assert.match(res.message, /toryo guard codex --window weekly --pause-until-reset \(MCP: toryo_guard \{"target":"codex","window":"weekly","action":"pause-until-reset"\}\)/);
    // Released while you don't hold it: no error, and the same offers.
    assert.match(e.deskControl("release", { target: "codex" }).message, /^You don't hold Codex \(headless and the Codex app\)\. The usage guard still holds Codex/);
    // Pause each window's guard until its reset.
    assert.match(e.deskControl("guard-pause", { target: "codex", window: "weekly" }).message, /lets Codex run until its weekly limit resets .*; then it guards again\. Still held: Codex's 5-hour limit/);
    assert.equal(e.blockersFor({ agent: "codex", kind: "build" }).length, 1);
    e.deskControl("guard-pause", { target: "codex", window: "5-hour" });
    assert.deepEqual(e.blockersFor({ agent: "codex", kind: "build" }), []);
    // The exception lasts until that reset, and survives a restart.
    e.shutdown();
    t.engine = await t.make();
    assert.deepEqual(t.engine.blockersFor({ agent: "codexapp", kind: "build" }), []);
    assert.equal(t.engine.deskView().guard.exceptions.length, 2);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("no known reset: the guard can't be paused until it, says so, and offers turning the rule off instead", async () => {
  const { t, clock } = await guarded([]);
  try {
    const e = t.engine;
    await report(e, clock, "codex", [{ type: "weekly", used: 97, resetsAt: null }]);
    assert.throws(() => e.deskControl("guard-pause", { target: "codex", window: "weekly" }), /has no known reset time, so the guard can't be paused until then\. To stop it holding, turn that rule off: toryo guard codex --weekly off/);
    const [offer] = e.deskControl("release", { target: "codex" }).offers;
    assert.equal(offer.command, "toryo guard codex --weekly off");
    assert.deepEqual(offer.mcp.arguments, { target: "codex", rules: { weekly: { enabled: false } } });
    // Time alone never releases it; a fresh reading under the threshold does.
    clock.now += 1000 * HOUR;
    e.checkGuards();
    assert.equal(e.deskView().guard.holds.length, 1);
    await report(e, clock, "codex", [{ type: "weekly", used: 4, resetsAt: null }]);
    assert.deepEqual(e.deskView().guard.holds, []);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("with automatic release off, the reset waits for you: release refused before it, accepted after", async () => {
  const { t, clock } = await guarded([]);
  try {
    const e = t.engine;
    e.deskControl("guard", { target: "claude", autoRelease: false });
    await report(e, clock, "claude", [{ type: "weekly", used: 90, resetsAt: clock.now + HOUR }]);
    assert.throws(() => e.deskControl("guard-release", { target: "claude", window: "weekly" }), /hasn't reset yet .* To let it run anyway until then: toryo guard claude --window weekly --pause-until-reset/);
    clock.now += 2 * HOUR;
    e.checkGuards();
    assert.match(e.blockersFor({ agent: "claude", kind: "chat" }).join(), /has reset, and the usage guard waits for you to release it/);
    assert.equal(t.notes.filter((n) => /Claude's weekly limit has reset/.test(n.t)).length, 1);
    assert.deepEqual(e.deskControl("release", { target: "claude" }).offers.map((o) => o.command), ["toryo guard claude --window weekly --release-expired-hold"]);
    assert.match(e.deskControl("guard-release", { target: "claude", window: "weekly" }).message, /Released the guard's hold on Claude for its weekly limit\./);
    assert.deepEqual(e.blockersFor({ agent: "claude", kind: "chat" }), []);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a guard hold that can't be saved applies anyway and holds everything until it's saved; a late reading of a window that has reset holds nothing", async () => {
  const { t, clock } = await guarded([]);
  try {
    const e = t.engine;
    await report(e, clock, "codex", [{ type: "weekly", used: 99, resetsAt: clock.now - 1000 }]);
    assert.deepEqual(e.deskView().guard.holds, [], "a reading of a window that has already reset");
    const write = e.store.writeJson.bind(e.store);
    let failing = true;
    e.store.writeJson = (file, value) => {
      if (failing && file.endsWith("desk.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return write(file, value);
    };
    await report(e, clock, "codex", [{ type: "weekly", used: 95, resetsAt: clock.now + HOUR }]);
    assert.equal(e.deskView().guard.holds.length, 1, "held in memory");
    assert.equal(e.deskView().problem.kind, "unsaved");
    assert.ok(e.blockersFor({ agent: "claude", kind: "chat" }).length, "nothing new starts until it's saved");
    failing = false;
    e.deskControl("save");
    assert.equal(e.deskView().problem, null);
    assert.equal(JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8")).guard.holds["openai:weekly"].used, 95);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("changing the rules: a higher threshold or a rule turned off ends that hold at once; turning the guard off ends them all", async () => {
  const { t, clock } = await guarded([]);
  try {
    const e = t.engine;
    await report(e, clock, "codex", [
      { type: "five_hour", used: 92, resetsAt: clock.now + HOUR },
      { type: "weekly", used: 94, resetsAt: clock.now + 50 * HOUR },
    ]);
    assert.equal(e.deskView().guard.holds.length, 2);
    const raised = e.deskControl("guard", { target: "codex", rules: { five_hour: { at: 95 } } });
    assert.match(raised.message, /The usage guard holds Codex at 95% of its 5-hour limit or 90% of its weekly limit, and releases it at reset\. The guard released Codex: its 5-hour limit is under the new threshold\./);
    assert.deepEqual(e.deskView().guard.holds.map((h) => h.type), ["weekly"]);
    const off = e.deskControl("guard", { enabled: false });
    assert.match(off.message, /The usage guard is off for Codex\./);
    assert.deepEqual(e.deskView().guard.holds, []);
    assert.equal(t.notes.filter((n) => /released/.test(n.t)).length, 0, "you did it: no notification");
    const journal = readFileSync(join(t.home, "desk-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(journal.map((j) => j.kind), ["guard-hold", "guard-hold", "guard-end", "guard-end"]);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a hold Toryo couldn't save is back after a restart before the reset: the saved reading is looked at again", async () => {
  const { t, clock } = await guarded([]);
  try {
    const e = t.engine;
    const write = e.store.writeJson;
    e.store.writeJson = function (file, value) {
      if (file.endsWith("desk.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return write.call(this, file, value);
    };
    await report(e, clock, "codex", [{ type: "weekly", used: 95, resetsAt: clock.now + 5 * HOUR }]);
    assert.equal(e.deskView().problem.kind, "unsaved");
    assert.deepEqual(JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8")).guard.holds, {}, "the hold never reached the file");
    e.shutdown();
    e.store.writeJson = write;
    // Started again before the reset: the reading Toryo saved (95%) holds Codex again before anything starts.
    t.engine = await t.make();
    assert.deepEqual(t.engine.deskView().guard.holds.map((h) => [h.key, h.used]), [["openai:weekly", 95]]);
    assert.equal(t.engine.deskView().problem, null);
    assert.match(t.engine.blockersFor({ agent: "codexapp", kind: "build" }).join(), /Codex's weekly limit is at 95%/);
    assert.equal(JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8")).guard.holds["openai:weekly"].used, 95);
    // Your rules and exceptions come through a restart untouched.
    t.engine.deskControl("guard-pause", { target: "codex", window: "weekly" });
    t.engine.shutdown();
    t.engine = await t.make();
    assert.deepEqual(t.engine.blockersFor({ agent: "codex", kind: "build" }), []);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("changing one window's rule leaves the other windows' holds alone, including one waiting for you after its reset", async () => {
  const { t, clock } = await guarded([]);
  try {
    const e = t.engine;
    e.deskControl("guard", { target: "codex", autoRelease: false });
    await report(e, clock, "codex", [{ type: "weekly", used: 93, resetsAt: clock.now + HOUR }]);
    clock.now += 2 * HOUR;
    e.checkGuards();
    // The new window reads low, but with automatic release off the hold waits for you.
    await report(e, clock, "codex", [{ type: "weekly", used: 2, resetsAt: clock.now + 160 * HOUR }]);
    assert.deepEqual(e.deskView().guard.holds.map((h) => [h.type, h.state]), [["weekly", "ready"]]);
    e.deskControl("guard", { target: "codex", rules: { five_hour: { at: 80 } } });
    assert.deepEqual(e.deskView().guard.holds.map((h) => [h.type, h.state]), [["weekly", "ready"]], "the weekly hold is untouched");
    // The weekly rule given again as it was, alone or beside a 5-hour change: nothing changed, so the hold stays.
    e.deskControl("guard", { target: "codex", rules: { weekly: { at: 90 } } });
    e.deskControl("guard", { target: "codex", rules: { "5-hour": { at: 85 }, weekly: { enabled: true, at: 90 } } });
    e.deskControl("guard", { target: "codex", enabled: true });
    assert.deepEqual(e.deskView().guard.holds.map((h) => [h.type, h.state]), [["weekly", "ready"]], "the weekly hold is still waiting for you");
    assert.match(e.blockersFor({ agent: "codex", kind: "build" }).join(), /weekly limit has reset, and the usage guard waits for you/);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a refused change to the rules changes nothing, for one allowance or all of them, in memory or on disk", async () => {
  const { t } = await guarded([]);
  try {
    const e = t.engine;
    const before = JSON.stringify(e.deskView().guard.policies);
    assert.throws(() => e.deskControl("guard", { target: "codex", rules: { five_hour: { enabled: false }, weekly: { at: 101 } } }), /from 1 to 100/);
    assert.throws(() => e.deskControl("guard", { rules: { five_hour: { at: 50 }, weekly: { at: 0 } } }), /from 1 to 100/);
    assert.throws(() => e.deskControl("guard", { target: "codex", rules: { "no such window!": { at: 50 } } }), /no window called/);
    assert.equal(JSON.stringify(e.deskView().guard.policies), before);
    // Another action saves the desk afterwards: the refused changes aren't in it.
    e.deskControl("hold", { target: "claude" });
    assert.deepEqual(JSON.parse(readFileSync(join(t.home, "desk.json"), "utf8")).guard.policies, {});
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

test("a window named as you'd type it (5-hour) sets the rule the readings use, and a reading over it holds", async () => {
  const { t, clock } = await guarded([]);
  try {
    const e = t.engine;
    e.deskControl("guard", { target: "codex", rules: { "5-hour": { at: 80 } } });
    assert.deepEqual(e.deskView().guard.policies.find((p) => p.group === "openai").rules.map((r) => [r.type, r.at]), [["five_hour", 80], ["weekly", 90]]);
    await report(e, clock, "codex", [{ type: "five_hour", used: 85, resetsAt: clock.now + HOUR }]);
    assert.match(e.blockersFor({ agent: "codex", kind: "build" }).join(), /Codex's 5-hour limit is at 85% \(the usage guard holds at 80%\)/);
  } finally {
    t.engine.shutdown();
    t.cleanup();
  }
});

// ---------------------------------------------------------------- the same controls from the API, the terminal and MCP

const TORYO = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "toryo.mjs");

test("the API, the command line and MCP: Pause everything, holds, the guard's rules, and a Release that names each window still held", async () => {
  await withServer([], async (t) => {
    const { engine: e, post, client, home } = t;
    const cli = async (...args) => {
      const { stdout } = await promisify(execFile)(process.execPath, [TORYO, ...args], { env: { ...process.env, TORYO_HOME: home } });
      return stdout.trim();
    };
    // The note about the guard, until it's read.
    assert.match(await cli("status"), /^New: the usage guard is on\. When an agent's 5-hour or weekly usage reaches 90%/);
    assert.match(await cli("guard"), /The usage guard:\n {2}Codex \(headless and the Codex app\): holds at 90% of the 5-hour limit or 90% of the weekly limit, and lets go at reset\.[\s\S]*Holding nothing now\./);
    assert.match(await cli("guard", "ok"), /^Noted\./);
    assert.doesNotMatch(await cli("status"), /the usage guard is on/);
    // Pause everything, from the command line; the room's own pause is still `toryo pause <room>`.
    assert.match(await cli("pause", "--all"), /^Everything is paused\./);
    assert.match(await cli("status"), /Everything is paused/);
    assert.match(await cli("resume", "--all"), /^Everything resumed/);
    // Codex held by you, and by the guard for two windows (Codex's logs say 95% and 91%).
    assert.match(await cli("hold", "codex"), /^Holding Codex \(headless and the Codex app\)/);
    const later = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
    e.adapters = { ...e.adapters, codex: { ...e.adapters.codex, currentLimits: () => ({ status: "allowed", sourceAt: new Date().toISOString(), windows: [{ type: "five_hour", minutes: 300, used: 95, resetsAt: later(1) }, { type: "weekly", minutes: 10080, used: 91, resetsAt: later(50) }] }) } };
    e.agentStatus = { codex: { installed: true } };
    await e.refreshUsage();
    assert.match(await cli("status"), /You hold: Codex \(headless and the Codex app\)[\s\S]*Held by the usage guard: Codex's 5-hour limit is at 95%[\s\S]*Held by the usage guard: Codex's weekly limit is at 91%/);
    // Release: one actionable line per window, the same from each interface.
    const released = await cli("release", "codex");
    for (const w of ["five-hour", "weekly"]) {
      assert.ok(released.includes(`toryo guard codex --window ${w} --pause-until-reset (MCP: toryo_guard {"target":"codex","window":"${w}","action":"pause-until-reset"})`), released);
    }
    const overHttp = await post("/api/desk", { action: "release", target: "codex" });
    assert.equal(overHttp.status, 200);
    assert.equal(overHttp.body.offers.length, 2);
    const m = mcp(home);
    try {
      const fromPhone = await m.call("toryo_desk", { action: "release", target: "codex" });
      assert.ok(!fromPhone.error);
      assert.equal(fromPhone.text, overHttp.body.message);
      // The offer's own MCP arguments, as given: the weekly guard paused until its reset.
      const offer = overHttp.body.offers.find((o) => o.mcp.arguments.window === "weekly");
      assert.match((await m.call(offer.mcp.tool, offer.mcp.arguments)).text, /lets Codex run until its weekly limit resets/);
      assert.match((await m.call("toryo_guard", {})).text, /Holding now:\n {2}Codex's 5-hour limit is at 95%[\s\S]*Paused until its reset: Codex's weekly limit \(91%\)/);
      // Rules: Claude's 5-hour rule off from MCP, Codex's weekly threshold from the command line.
      assert.match((await m.call("toryo_guard", { target: "claude", fiveHour: "off" })).text, /holds Claude at 90% of its weekly limit/);
      assert.match(await cli("guard", "codex", "--weekly", "95", "--no-auto-release"), /holds Codex at 90% of its 5-hour limit or 95% of its weekly limit, and waits for you to release it after the reset/);
      const bad = await m.call("toryo_guard", { target: "codex", weekly: "lots" });
      assert.ok(bad.error);
      assert.match(bad.text, /weekly threshold should be a percentage, or off/);
    } finally {
      m.close();
    }
    // The command line's refusals are in plain words.
    // (The weekly hold ended when its threshold went up to 95%; the 5-hour one still holds.)
    assert.deepEqual(e.deskView().guard.holds.map((h) => h.type), ["five_hour"]);
    await assert.rejects(cli("guard", "codex", "--window", "5-hour", "--release-expired-hold"), /Codex's 5-hour limit hasn't reset yet/);
    assert.equal((await post("/api/desk", { action: "guard-pause", target: "nobody", window: "weekly" })).status, 400);
    assert.deepEqual(e.deskView().guard.policies.find((p) => p.group === "anthropic").rules.map((r) => [r.type, r.enabled]), [["five_hour", false], ["weekly", true]]);
    assert.ok(client);
  });
});

test("for a window of its own (Claude's weekly Opus limit) with no known reset, the command offered to turn its rule off works as given", async () => {
  await withServer([], async (t) => {
    const { engine: e, home } = t;
    const cli = async (args) => (await promisify(execFile)(process.execPath, [TORYO, ...args], { env: { ...process.env, TORYO_HOME: home } })).stdout.trim();
    // From the command line, with the window as you'd type it: --window weekly-opus --at 90.
    assert.match(await cli(["guard", "claude", "--window", "weekly-opus", "--at", "90"]), /90% of its weekly \(Opus\) limit/);
    e.adapters = { ...e.adapters, claude: { ...e.adapters.claude, currentLimits: () => ({ status: "allowed", sourceAt: new Date().toISOString(), windows: [{ type: "weekly_opus", minutes: 10080, used: 96, resetsAt: null }] }) } };
    e.agentStatus = { claude: { installed: true } };
    await e.refreshUsage();
    assert.match(e.blockersFor({ agent: "claude", kind: "chat" }).join(), /Claude's weekly \(Opus\) limit is at 96%/);
    const [offer] = e.deskControl("release", { target: "claude" }).offers;
    assert.equal(offer.command, "toryo guard claude --window weekly-opus --at off");
    assert.throws(() => e.deskControl("guard-pause", { target: "claude", window: "weekly-opus" }), /turn that rule off: toryo guard claude --window weekly-opus --at off/);
    // Run exactly as offered: the rule goes off, and so does the hold.
    assert.match(await cli(offer.command.split(" ").slice(1)), /The guard released Claude: you turned the weekly \(Opus\) rule off/);
    assert.deepEqual(e.blockersFor({ agent: "claude", kind: "chat" }), []);
    // And the MCP arguments offered do the same, on another hold.
    e.deskControl("guard", { target: "claude", rules: { "weekly-opus": { enabled: true } } });
    assert.equal(e.deskView().guard.holds.length, 1);
    const [again] = e.deskControl("release", { target: "claude" }).offers;
    const m = mcp(home);
    try {
      assert.match((await m.call(again.mcp.tool, again.mcp.arguments)).text, /The guard released Claude/);
    } finally {
      m.close();
    }
    assert.deepEqual(e.blockersFor({ agent: "claude", kind: "chat" }), []);
  });
});
