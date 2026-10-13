import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { claudeLimits } from "../src/agents/claude.mjs";
import { codexCurrentLimits } from "../src/agents/codex.mjs";
import { latestRateLimits, parseRateLimits } from "../src/agents/logtail.mjs";
import { DEFAULT_GROUPS, UsageBook, groupOf, normalizeGroups } from "../src/usage.mjs";
import { limitMeters } from "../web/meters.js";
import { setup, waitFor } from "./helpers.mjs";

const T0 = Date.parse("2026-10-13T08:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const H = 3_600_000;
const reading = (sourceAt, windows, extra = {}) => ({ status: "allowed", sourceAt: sourceAt == null ? null : iso(sourceAt), windows, ...extra });
const weekly = (used, resetsAt) => ({ type: "weekly", minutes: 10080, used, resetsAt: iso(resetsAt) });
const fiveHour = (used, resetsAt) => ({ type: "five_hour", minutes: 300, used, resetsAt: iso(resetsAt) });

test("Codex and Claude usage reports become typed windows; missing or malformed numbers stay unknown, never 0%", () => {
  const resets = T0 / 1000 + 3 * 3600;
  const codex = parseRateLimits(
    {
      primary: { used_percent: 12, window_minutes: 300, resets_at: resets },
      secondary: { used_percent: "lots", window_minutes: 10080, resets_at: resets + 86400 },
      plan_type: "pro",
    },
    { sourceAt: "2026-10-13T08:00:00Z" },
  );
  assert.equal(codex.sourceAt, "2026-10-13T08:00:00.000Z");
  assert.equal(codex.status, "allowed");
  assert.equal(codex.plan, "pro");
  assert.deepEqual(codex.windows[0], { type: "five_hour", label: "5-hour", minutes: 300, used: 12, resetsAt: iso(resets * 1000) });
  assert.equal(codex.windows[1].type, "weekly");
  assert.equal(codex.windows[1].used, null, "a malformed percentage is unknown");
  // A window with neither a percentage nor a reset time says nothing; one without its length can't be identified.
  assert.equal(parseRateLimits({ primary: { window_minutes: 300 }, secondary: { used_percent: 50, resets_at: resets } }), null);
  assert.equal(parseRateLimits(null), null);
  assert.equal(parseRateLimits("nonsense"), null);
  // Which limit was reached is kept as Codex says it.
  const limited = parseRateLimits({ primary: { used_percent: 100, window_minutes: 300, resets_at: resets }, rate_limit_reached_type: "primary" });
  assert.equal(limited.status, "limited");
  assert.equal(limited.reached, "primary");

  const claude = claudeLimits(
    {
      status: "allowed_warning",
      unifiedWindows: {
        five_hour: { resetsAt: resets },
        seven_day: { utilization: 0.775, resetsAt: resets + 86400 },
        seven_day_opus: { utilization: 0.5, resetsAt: resets + 86400 },
        broken: "not a window",
      },
    },
    { sourceAt: "2026-10-13T08:00:00.000Z" },
  );
  assert.equal(claude.status, "allowed_warning");
  assert.deepEqual(
    claude.windows.map((w) => [w.type, w.label, w.minutes, w.used]),
    [
      ["five_hour", "5-hour", 300, null],
      ["weekly", "weekly", 10080, 77.5],
      // A model's own window keeps its identity rather than folding into the general weekly one.
      ["weekly_opus", "weekly (Opus)", 10080, 50],
    ],
  );
  assert.equal(claudeLimits({ status: "allowed" }), null);
});

test("the usage book keeps the newest reading of each window, by when the agent took it", () => {
  let now = T0;
  const book = new UsageBook({ now: () => now });
  const reset = T0 + 3 * H;

  let r = book.accept("codex", reading(T0, [fiveHour(10, reset)]), { receivedAt: iso(T0 + 1000), source: "log" });
  assert.deepEqual([r.changed, r.fresh, r.results[0].reason], [true, true, "new"]);

  // Reading the same log line again is the same measurement: nothing new, only when it was last checked.
  now = T0 + 5 * 60_000;
  r = book.accept("codex", reading(T0, [fiveHour(10, reset)]), { receivedAt: iso(now), source: "log" });
  assert.equal(r.fresh, false);
  assert.equal(r.results[0].reason, "same");
  const kept = book.agents.codex.windows.five_hour;
  assert.equal(kept.receivedAt, iso(T0 + 1000));
  assert.equal(kept.checkedAt, iso(now));

  // A fresh report with an unchanged percentage is a newer measurement.
  r = book.accept("codex", reading(T0 + 10 * 60_000, [fiveHour(10, reset)]), { receivedAt: iso(now) });
  assert.equal(r.results[0].reason, "newer");
  assert.equal(book.agents.codex.windows.five_hour.sourceAt, iso(T0 + 10 * 60_000));

  // A delayed report, taken before the one Toryo has, doesn't replace it.
  r = book.accept("codex", reading(T0 + 2 * 60_000, [fiveHour(55, reset)]), { receivedAt: iso(now) });
  assert.deepEqual([r.changed, r.fresh, r.results[0].reason], [false, false, "older"]);
  assert.equal(book.agents.codex.windows.five_hour.used, 10);

  // After the reset: the old percentage is kept, marked expired, never shown as a fresh 0%.
  now = reset + 60_000;
  const view = book.agentView();
  assert.equal(view.codex.windows[0].used, 10);
  assert.equal(view.codex.windows[0].expired, true);

  // A new window (a later reset) replaces it; a late report from the old window is then ignored.
  const nextReset = reset + 5 * H;
  r = book.accept("codex", reading(now, [fiveHour(2, nextReset)]), { receivedAt: iso(now) });
  assert.equal(r.results[0].reason, "new-window");
  r = book.accept("codex", reading(now + 60_000, [fiveHour(97, reset)]), { receivedAt: iso(now + 60_000) });
  assert.equal(r.results[0].reason, "older-window");
  assert.equal(book.agentView().codex.windows[0].used, 2);
  assert.equal(book.agentView().codex.windows[0].expired, false);

  // A reading's reset time drifting by seconds is still the same window.
  r = book.accept("codex", reading(now + 2 * 60_000, [fiveHour(3, nextReset - 4000)]), { receivedAt: iso(now + 2 * 60_000) });
  assert.equal(r.results[0].reason, "newer");

  // Readings with nothing usable in them change nothing.
  for (const bad of [null, "x", { windows: "x" }, { windows: [] }, { windows: [{ type: "weekly" }] }, { windows: [{ label: "", used: 5 }] }]) {
    r = book.accept("codex", bad);
    assert.equal(r.changed, false);
    assert.equal(r.invalid, true);
  }
  assert.equal(book.accept("../bad", reading(now, [fiveHour(1, nextReset)])).invalid, true);
  assert.equal(book.agentView().codex.windows[0].used, 3);
});

test("Codex and the Codex app share one allowance: the freshest reading wins and they're never added together", () => {
  assert.equal(groupOf("codex"), "openai");
  assert.equal(groupOf("codexapp"), "openai");
  assert.equal(groupOf("claude"), "anthropic");
  const now = T0 + H;
  const book = new UsageBook({ now: () => now });
  const reset = T0 + 3 * 86_400_000;
  book.accept("codex", reading(T0, [weekly(40, reset), fiveHour(20, T0 + 2 * H)]));
  book.accept("codexapp", reading(T0 + 30 * 60_000, [weekly(55, reset)]));
  book.accept("claude", reading(T0, [weekly(70, reset), { type: "weekly_opus", used: 15, resetsAt: iso(reset) }]));
  const { groups, mapping } = book.groupView();
  assert.equal(mapping.codexapp, "openai");
  assert.deepEqual(groups.openai.agents, ["codex", "codexapp"]);
  const openaiWeekly = groups.openai.windows.find((w) => w.type === "weekly");
  assert.equal(openaiWeekly.used, 55, "the newest reading, not 40 + 55");
  assert.equal(openaiWeekly.agent, "codexapp");
  assert.deepEqual(openaiWeekly.others.map((o) => [o.agent, o.used]), [["codex", 40]]);
  assert.ok(groups.openai.windows.some((w) => w.type === "five_hour" && w.agent === "codex"));
  // Model-specific windows stay separate.
  assert.deepEqual(groups.anthropic.windows.map((w) => [w.type, w.used]), [["weekly", 70], ["weekly_opus", 15]]);

  // The mapping can be changed, if the two ever use different accounts; bad entries are ignored or refused.
  const split = normalizeGroups({ codexapp: "work", "Bad Name": "x", claude: 7 });
  assert.equal(split.codexapp, "work");
  assert.equal(split.claude, DEFAULT_GROUPS.claude);
  assert.equal(split["Bad Name"], undefined);
  assert.throws(() => normalizeGroups({ claude: 7 }, { strict: true }), /Invalid allowance mapping/);
  assert.throws(() => normalizeGroups([], { strict: true }), /must be an object/);
  const separate = new UsageBook({ groups: split, now: () => now });
  separate.accept("codex", reading(T0, [weekly(40, reset)]));
  separate.accept("codexapp", reading(T0, [weekly(55, reset)]));
  assert.deepEqual(Object.keys(separate.groupView().groups).sort(), ["openai", "work"]);
});

test("readings stored before 13 Oct are migrated without inventing when they were taken", () => {
  const at = "2026-10-12T20:00:00.000Z";
  const reset = "2026-10-15T08:00:00.000Z";
  const legacy = {
    codex: { at, status: "allowed", plan: "pro", windows: [{ label: "5-hour", used: 30, resetsAt: "2026-10-12T22:00:00.000Z" }, { label: "weekly", used: 50, resetsAt: reset }] },
    claude: { at, status: "allowed", windows: [{ label: "weekly (Opus)", used: 12.5, resetsAt: reset }, { label: "weekly", used: 0, resetsAt: null }] },
    junk: "not an entry",
  };
  const now = Date.parse("2026-10-13T08:00:00.000Z");
  const book = new UsageBook({ now: () => now }).load(legacy);
  const view = book.agentView();
  assert.deepEqual(view.codex.windows.map((w) => [w.type, w.used, w.sourceAt, w.receivedAt, w.source]), [
    ["five_hour", 30, null, at, "migrated"],
    ["weekly", 50, null, at, "migrated"],
  ]);
  assert.equal(view.codex.at, at, "still reported as of when Toryo got it");
  assert.equal(view.codex.windows[0].expired, true);
  assert.deepEqual(view.claude.windows.map((w) => w.type), ["weekly", "weekly_opus"]);
  assert.equal(view.junk, undefined);
  // A dated reading supersedes an undated, migrated one.
  const r = book.accept("codex", reading(now - 60_000, [weekly(52, Date.parse(reset))]));
  assert.equal(r.results[0].reason, "newer");
  // Saved in the new format, and loaded back with its provenance.
  const saved = JSON.parse(JSON.stringify(book.toJSON()));
  assert.equal(saved.version, 2);
  const again = new UsageBook({ now: () => now }).load(saved);
  assert.equal(again.agents.codex.windows.weekly.sourceAt, iso(now - 60_000));
  assert.equal(again.agents.codex.windows.five_hour.source, "migrated");
  // A file from a newer Toryo is left alone.
  const newer = new UsageBook().load({ version: 3, agents: {} });
  assert.equal(newer.writable, false);
});

test("the engine keeps each reading's provenance across restarts, and re-reading Codex's logs isn't news", async () => {
  const resetSoon = Math.round(Date.now() / 1000) + 2 * 3600;
  const t = await setup([
    {
      agent: "claude",
      match: "usage please",
      // A valid report, then a malformed one that must not erase it.
      rateLimit: [
        { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: resetSoon }, seven_day_opus: { utilization: 0.1, resetsAt: resetSoon + 86400 } } },
        { status: "allowed", unifiedWindows: { five_hour: { utilization: "lots" } } },
      ],
      reply: "Done.\nTORYO: REPLY",
    },
  ]);
  try {
    const legacyAt = "2026-10-12T20:00:00.000Z";
    // An old limits.json from before the change: migrated on start.
    writeFileSync(join(t.home, "limits.json"), JSON.stringify({ codexapp: { at: legacyAt, status: "allowed", windows: [{ label: "weekly", used: 33, resetsAt: null }] } }));
    const engine = await t.make();
    assert.equal(engine.limits.codexapp.windows[0].used, 33);
    assert.equal(engine.limits.codexapp.at, legacyAt);
    assert.ok(engine.usageTimer, "re-reading usage between turns");

    const room = engine.createRoom({ projectId: "repo", mode: "chat", members: ["claude"], text: "usage please" });
    await waitFor(() => engine.roomView(room.id).events.some((e) => e.type === "turn" && e.state === "done"), { label: "claude turn" });
    const claude = engine.limits.claude;
    assert.deepEqual(claude.windows.map((w) => [w.type, w.used]), [["five_hour", 30], ["weekly_opus", 10]]);
    assert.equal(claude.windows[0].source, "stream");
    assert.ok(claude.windows[0].sourceAt && claude.windows[0].receivedAt);
    assert.equal(engine.state().usage.groups.anthropic.windows[0].used, 30);

    const stored = JSON.parse(readFileSync(join(t.home, "limits.json"), "utf8"));
    assert.equal(stored.version, 2);
    assert.equal(stored.agents.codexapp.windows.weekly.source, "migrated");

    // Codex's logs, re-read on a timer: the first reading is news, the same line read again isn't.
    let reads = 0;
    const line = { status: "allowed", sourceAt: "2026-10-13T07:59:00.000Z", windows: [{ type: "weekly", minutes: 10080, used: 41, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] };
    engine.adapters = { ...engine.adapters, codex: { ...engine.adapters.codex, currentLimits: () => (reads++, line) } };
    engine.agentStatus = { codex: { installed: true }, claude: { installed: true } };
    let states = 0;
    engine.on("state", () => states++);
    assert.equal(await engine.refreshUsage(), true);
    assert.equal(await engine.refreshUsage(), false);
    assert.equal(reads, 2);
    assert.equal(states, 1);
    assert.equal(engine.limits.codex.windows[0].used, 41);

    // A failing read is shown, not hidden behind the old reading.
    engine.adapters.codex.currentLimits = () => {
      throw new Error("log unreadable");
    };
    assert.equal(await engine.refreshUsage(), true);
    assert.match(engine.state().usage.errors.codex.error, /log unreadable/);
    assert.equal(engine.limits.codex.windows[0].used, 41);

    // Stopping leaves no timer behind.
    engine.shutdown();
    assert.equal(engine.usageTimer, null);

    // A restart loads the same readings, with when they were taken and received.
    const again = await t.make();
    assert.equal(again.limits.claude.windows[0].sourceAt, claude.windows[0].sourceAt);
    assert.equal(again.limits.codex.windows[0].sourceAt, "2026-10-13T07:59:00.000Z");
    again.shutdown();
  } finally {
    t.cleanup();
  }
});

test("a reading taken earlier never replaces a later one, even when it reports a later reset", () => {
  const now = T0 + 2 * H;
  const reset = T0 + 3 * H;
  const at8 = T0;
  const at7 = T0 - H;
  // Codex's reproduction: 80% at 08:00, then a 07:00 reading of 20% whose reset is 30 minutes later.
  const book = new UsageBook({ now: () => now });
  book.accept("codex", reading(at8, [fiveHour(80, reset)]));
  let r = book.accept("codex", reading(at7, [fiveHour(20, reset + 30 * 60_000)]));
  assert.deepEqual([r.fresh, r.results[0].reason], [false, "older"]);
  // An undated reading with a later reset doesn't win either.
  r = book.accept("codex", reading(null, [fiveHour(5, reset + 6 * H)]));
  assert.deepEqual([r.fresh, r.results[0].reason], [false, "older"]);
  assert.equal(book.agentView().codex.windows[0].used, 80);
  // A reading taken later of a later window is the new window.
  r = book.accept("codex", reading(at8 + 60_000, [fiveHour(1, reset + 5 * H)]));
  assert.equal(r.results[0].reason, "new-window");
  // Against an undated, migrated reading, the window decides: one that ended before it is late.
  const migrated = new UsageBook({ now: () => now }).load({ codex: { at: iso(at7), windows: [{ label: "5-hour", used: 50, resetsAt: iso(reset) }] } });
  assert.equal(migrated.accept("codex", reading(at8, [fiveHour(99, reset - 5 * H)])).results[0].reason, "older-window");
  assert.equal(migrated.accept("codex", reading(at8, [fiveHour(51, reset)])).results[0].reason, "newer");

  // Shared readings: the one taken last wins, whichever agent reported first.
  for (const order of [["codex", "codexapp"], ["codexapp", "codex"]]) {
    const shared = new UsageBook({ now: () => now });
    const readings = { codex: reading(at8, [fiveHour(80, reset)]), codexapp: reading(at7, [fiveHour(20, reset + 30 * 60_000)]) };
    for (const agent of order) shared.accept(agent, readings[agent]);
    const w = shared.groupView().groups.openai.windows[0];
    assert.deepEqual([w.agent, w.used], ["codex", 80], `order ${order}`);
    assert.deepEqual(w.others.map((o) => [o.agent, o.used]), [["codexapp", 20]]);
  }
  // A reading taken later, about a window that was already over when it was taken, doesn't win.
  for (const order of [["codex", "codexapp"], ["codexapp", "codex"]]) {
    const shared = new UsageBook({ now: () => now });
    const readings = { codex: reading(at8 + H, [fiveHour(97, at8 + 30 * 60_000)]), codexapp: reading(at8, [fiveHour(15, reset)]) };
    for (const agent of order) shared.accept(agent, readings[agent]);
    assert.deepEqual([shared.groupView().groups.openai.windows[0].agent, shared.groupView().groups.openai.windows[0].used], ["codexapp", 15], `order ${order}`);
  }
  // A dated reading beats an undated one in a shared window too, in either order.
  for (const order of [["codex", "codexapp"], ["codexapp", "codex"]]) {
    const shared = new UsageBook({ now: () => now });
    const readings = { codex: reading(null, [fiveHour(90, reset + 6 * H)]), codexapp: reading(at7, [fiveHour(20, reset)]) };
    for (const agent of order) shared.accept(agent, readings[agent]);
    assert.equal(shared.groupView().groups.openai.windows[0].agent, "codexapp", `order ${order}`);
  }
});

test("a Codex log that can't be read is a failed read, not an empty one, and the last good reading stays", async () => {
  const line = (used, at) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: used, window_minutes: 10080, resets_at: Math.round(Date.now() / 1000) + 86400 } } } });
  const base = mkdtempSync(join(tmpdir(), "toryo-usage-"));
  try {
    // The reader: a log with no reading is null; a missing log or one that can't be read throws.
    const empty = join(base, "empty.jsonl");
    writeFileSync(empty, '{"type":"session_meta"}\n');
    assert.equal(latestRateLimits(empty), null);
    assert.throws(() => latestRateLimits(join(base, "missing.jsonl")), { code: "ENOENT" });
    mkdirSync(join(base, "dir.jsonl"));
    assert.throws(() => latestRateLimits(join(base, "dir.jsonl")), { code: "EISDIR" });

    // The Codex app's passive read, through its own folders: a thread log that can't be read throws.
    const appHome = join(base, "app");
    const day = join(appHome, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-10-13T08-00-00-thread-ok.jsonl"), line(12, "2026-10-13T08:00:00.000Z") + "\n");
    mkdirSync(join(day, "rollout-2026-10-13T08-00-00-thread-bad.jsonl"));
    const app = ADAPTERS.codexapp;
    assert.equal(app.currentLimits({ codexHome: appHome, exe: "/nonexistent" }, { threads: ["thread-ok"] }).windows[0].used, 12);
    assert.equal(app.currentLimits({ codexHome: appHome, exe: "/nonexistent" }, { threads: ["thread-gone"] }), null, "no log for a thread is no reading");
    assert.throws(() => app.currentLimits({ codexHome: appHome, exe: "/nonexistent" }, { threads: ["thread-ok", "thread-bad"] }), { code: "EISDIR" });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  // Headless Codex, through the engine: a good read, then a log that can't be read, then a good read again.
  const t = await setup([]);
  try {
    const codexHome = process.env.CODEX_HOME;
    assert.equal(codexCurrentLimits(), null, "no Codex sessions yet is no reading, not a failure");
    const day = join(codexHome, "sessions", "2026", "10", "13");
    mkdirSync(day, { recursive: true });
    const log = join(day, "rollout-2026-10-13T08-00-00-abc.jsonl");
    writeFileSync(log, line(41, "2026-10-13T07:59:00.000Z") + "\n");
    const engine = await t.make();
    engine.agentStatus = { codex: { installed: true } };
    assert.equal(await engine.refreshUsage(), true);
    assert.equal(engine.limits.codex.windows[0].used, 41);
    assert.equal(engine.limits.codex.error, null);

    rmSync(log);
    mkdirSync(log);
    assert.equal(await engine.refreshUsage(), true);
    const failed = engine.limits.codex;
    assert.equal(failed.windows[0].used, 41, "the last good reading is kept");
    assert.equal(failed.error.error.includes("EISDIR"), true);
    assert.ok(engine.state().usage.errors.codex);
    assert.match(limitMeters(failed, "codex"), /Couldn't read the latest usage just now: .*EISDIR/);

    rmSync(log, { recursive: true });
    writeFileSync(log, line(43, "2026-10-13T08:30:00.000Z") + "\n");
    assert.equal(await engine.refreshUsage(), true);
    assert.equal(engine.limits.codex.error, null);
    assert.equal(engine.limits.codex.windows[0].used, 43);
    engine.shutdown();
  } finally {
    t.cleanup();
  }
});

test("each meter says how old its own reading is, and a limit that resets shows as reset with nothing new arriving", () => {
  const now = T0;
  const usage = {
    windows: [
      // A fresh 5-hour reading next to a six-hour-old weekly one.
      { type: "five_hour", label: "5-hour", used: 64, resetsAt: iso(now + 10 * 60_000), sourceAt: iso(now - 60_000), receivedAt: iso(now - 60_000) },
      { type: "weekly", label: "weekly", used: 30, resetsAt: iso(now + 3 * 86_400_000), sourceAt: iso(now - 6 * H), receivedAt: iso(now - 6 * H) },
      // Kept from before 13 Oct: only when Toryo had it is known.
      { type: "weekly_opus", label: "weekly (Opus)", used: 12, resetsAt: iso(now + 3 * 86_400_000), sourceAt: null, receivedAt: iso(now - 14 * H) },
      { type: "x", label: "<b>odd</b>", used: null, resetsAt: iso(now + H), sourceAt: iso(now - 5 * 60_000) },
    ],
  };
  const html = limitMeters(usage, "codex", now);
  const window = (type, h = html) => h.match(new RegExp(`data-window="${type}".*?</div></div>`))?.[0] ?? "";
  assert.match(window("five_hour"), /64%.*just now/);
  assert.match(window("weekly"), /30%.*6 h ago/);
  assert.match(window("weekly_opus"), /12%.*14 h ago or earlier/);
  assert.match(window("x"), /unknown.*5 min ago/);
  assert.match(html, /&lt;b&gt;odd&lt;\/b&gt;/);
  assert.doesNotMatch(html, /Reported/, "no single age for every window");
  // Fifteen minutes later, with nothing new: the 5-hour limit has reset, and the ages have moved on.
  const later = limitMeters(usage, "codex", now + 15 * 60_000);
  assert.match(window("five_hour", later), /reset.*waiting for a new reading/);
  assert.doesNotMatch(window("five_hour", later), /64%/);
  assert.match(window("five_hour", later), /16 min ago/);
  assert.equal(limitMeters({ windows: [] }, "codex", now), "");
});
