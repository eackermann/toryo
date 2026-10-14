#!/usr/bin/env node
/**
 * Screenshots of the page at the widths and themes the design covers, plus a check that nothing scrolls sideways
 * on a phone. Like the browser check, it starts its own desk on a free port with a temporary data folder and the
 * fake agents, and needs Playwright, which Toryo doesn't depend on:
 *
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node test/ui-shots.mjs [folder]
 *
 * The pictures go to the folder given (a temporary one otherwise): a build in its second slice, with the first
 * slice's earlier round folded; a question asked in chat; a planning round waiting for your call; and a plan that's
 * ready, talked over with Claude since.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = join(root, "test", "fake-agent.mjs");
const pw = process.env.PLAYWRIGHT_CORE ?? (() => {
  try {
    return dirname(createRequire(join(root, "package.json")).resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
})();
if (!pw || !existsSync(pw)) {
  console.log("Skipped: set PLAYWRIGHT_CORE to a playwright-core folder.");
  process.exit(0);
}
const { chromium } = createRequire(join(pw, "package.json"))("playwright-core");
const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), "toryo-shots-"));
mkdirSync(out, { recursive: true });

const base = mkdtempSync(join(tmpdir(), "toryo-shots-desk-"));
const home = join(base, "home");
const repo = join(base, "repo");
let desk;
try {
  execFileSync("git", ["init", "-q", repo]);
  // A second project whose checks take a while, for the checks' ring.
  const slowRepo = join(base, "slow");
  execFileSync("git", ["init", "-q", slowRepo]);
  mkdirSync(join(repo, "docs", "plans"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# demo\n");
  writeFileSync(join(repo, "docs", "plans", "demo.md"), "# Demo\n\n### Slice 1: Schema\n\n### Slice 2: The API\n\n### Slice 3: Docs\n");
  const rules = [
    // Rooms in every state a ring shows: working, the checks, failed, done.
    { agent: "codex", match: "Busy build", hang: true },
    { agent: "codex", match: "Failing build", fail: true },
    { agent: "codex", match: "Tiny build", reply: "All done.\nTORYO: DONE" },
    { agent: "codex", match: "Checked build", reply: "Built.\nTORYO: REVIEW Slice 1: It | h.md" },
    { agent: "claude", match: "every slice of the plan is done", reply: "The whole plan is done. Approved.\nTORYO: APPROVED" },
    { agent: "codex", match: "continue straight into the next unfinished slice", hang: true },
    { agent: "codex", match: "reviewed your last round", reply: "Fixed: the index now covers both columns, and a test checks it.\nTORYO: REVIEW Slice 1: Schema | docs/reviews/slice-1.md" },
    { agent: "codex", match: "Your role: builder", reply: "Built the schema: three tables and their migrations, with tests.\n\n- `users`, `projects` and `runs`\n- One migration per table\n\nTORYO: REVIEW Slice 1: Schema | docs/reviews/slice-1.md" },
    { agent: "claude", match: "round 2 on this slice", reply: "The index is right now. Approved.\nTORYO: APPROVED" },
    { agent: "claude", match: "Your role: reviewer", reply: "One finding: the index on `runs` misses the project column, so the history page scans the table.\nTORYO: CHANGES" },
    { agent: "codex", match: "Pick a database", reply: "Which one should the history use? I recommend SQLite: one file, nothing to run.\nTORYO: OWNER SQLite or Postgres?" },
    { agent: "codex", match: "step 1 of 4", reply: "Codex proposal: three slices.\n- Q: Keep the old API working? (Recommended: yes, for one release)\nTORYO: PROPOSAL" },
    { agent: "claude", match: "step 1 of 4", reply: "Claude proposal: two slices.\n- Q: Ship a command line too? (Recommended: no, later)\nTORYO: PROPOSAL" },
    { match: "step 2 of 4", reply: "Critique: the other proposal covers migrations better.\nTORYO: CRITIQUE" },
    // A plan Codex writes and Claude approves, then talked over with Claude.
    { agent: "codex", match: "step 3 of 4", write: { path: "docs/plans/export.md", content: "# Export\n\n### Slice 1: The format\n\n### Slice 2: The command\n" }, reply: "Written: two slices, the format first.\nTORYO: REVIEW docs/plans/export.md" },
    { agent: "claude", match: "step 4 of 4", reply: "Checked: every decision is there, and each slice can be tested on its own.\nTORYO: APPROVED" },
    { agent: "claude", match: "Is anything missing", reply: "One thing: the plan doesn't say how someone reading an old export learns that the format changed. A line in slice 1 would do.\nTORYO: REPLY" },
    { reply: "Noted.\nTORYO: REPLY" },
  ];
  writeFileSync(join(base, "script.json"), JSON.stringify({ rules, log: join(base, "calls.jsonl") }));
  mkdirSync(home, { recursive: true });
  const node = process.execPath;
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      version: 1,
      notify: { windows: false },
      agents: { codex: { command: [node, FAKE, "codex"] }, claude: { command: [node, FAKE, "claude"] }, codexapp: { exe: join(base, "none") } },
      projects: [
        { id: "demo", name: "Demo", path: repo, rules: "", decisions: "", agents: {}, gates: [{ name: "Tests", command: "true" }] },
        { id: "slow", name: "Slow checks", path: slowRepo, rules: "", decisions: "", agents: {}, gates: [{ name: "Tests", command: "sleep 300" }] },
      ],
    }),
  );
  const now = Date.now();
  const w = (type, label, minutes, used, inMin) => ({ type, label, minutes, used, resetsAt: new Date(now + inMin * 60_000).toISOString(), sourceAt: new Date(now - 60_000).toISOString(), receivedAt: new Date(now - 60_000).toISOString(), source: "log" });
  writeFileSync(join(home, "limits.json"), JSON.stringify({ version: 2, agents: { codex: { status: "allowed", windows: { five_hour: w("five_hour", "5-hour", 300, 46, 112), weekly: w("weekly", "weekly", 10080, 84, 3900) } } } }));

  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  desk = spawn(node, [join(root, "bin", "toryo.mjs"), "--port", String(port)], {
    env: { ...process.env, TORYO_HOME: home, FAKE_SCRIPT: join(base, "script.json"), CODEX_HOME: join(base, "codex") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => desk.stdout.on("data", (d) => /Toryo is running/.test(d) && resolve()));
  const url = `http://localhost:${port}/`;
  const post = async (path, body) => (await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-toryo": "1" }, body: JSON.stringify(body) })).json();
  const view = async (id) => (await fetch(`${url}api/rooms/${id}`)).json();
  const until = async (fn, what) => {
    for (let i = 0; i < 300; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  const build = await post("api/rooms", { projectId: "demo", mode: "build", task: "Build the history.", planPath: "docs/plans/demo.md", title: "History build", members: ["codex", "claude"], builder: "codex", reviewer: "claude" });
  const chat = await post("api/rooms", { projectId: "demo", mode: "chat", members: ["codex"], text: "Pick a database for the history.", to: "codex", title: "Database chat" });
  const plan = await post("api/rooms", { projectId: "demo", mode: "plan", topic: "The public API", members: ["codex", "claude"], title: "API plan" });
  await until(async () => (await view(build.id)).live.length === 1 && (await view(build.id)).room.build?.approved?.length === 1, "the build's second slice");
  await until(async () => (await view(chat.id)).questions.length === 1, "the chat question");
  // A note with code and a quotation, which the bubble must keep readable.
  await post(`api/rooms/${chat.id}/messages`, { text: "Use `sqlite3` for now:\n\n```\nCREATE TABLE runs (id INTEGER);\n```\n\n> Keep it in one file.", to: "codex", answering: false });
  await until(async () => (await view(chat.id)).live.length === 0 && (await view(chat.id)).events.some((e) => e.type === "turn" && /Noted/.test(e.text ?? "")), "the reply to the note");
  // The planning room is now the latest active, though its question is newer than the chat's.
  await post(`api/rooms/${plan.id}/messages`, { text: "Thinking it over.", to: "everyone", answering: false });
  await until(async () => (await view(plan.id)).live.length === 0 && (await view(plan.id)).events.filter((e) => e.type === "turn" && /Noted/.test(e.text ?? "")).length === 2, "the planners' replies");
  await until(async () => (await view(plan.id)).questions.some((q) => q.kind === "plan-checkpoint"), "the planning checkpoint");
  // A plan that's ready, which you've talked over with Claude since: its card, and Claude's reply offering to send
  // that discussion to Codex.
  const ready = await post("api/rooms", { projectId: "demo", mode: "plan", topic: "Export", members: ["codex", "claude"], title: "Export plan", planPath: "docs/plans/export.md" });
  await until(async () => (await view(ready.id)).questions.some((q) => q.kind === "plan-checkpoint"), "the export plan's checkpoint");
  await post(`api/rooms/${ready.id}/control`, { action: "accept-checkpoint", questionId: (await view(ready.id)).questions[0].id, synthesizer: "codex" });
  await until(async () => (await view(ready.id)).questions.some((q) => q.kind === "plan-ready"), "the export plan ready");
  await post(`api/rooms/${ready.id}/messages`, { text: "Is anything missing before we build?", to: "claude", answering: false });
  await until(async () => (await view(ready.id)).live.length === 0 && (await view(ready.id)).events.some((e) => e.type === "turn" && /old export/.test(e.text ?? "")), "Claude's reply");

  // A room in every state a ring shows, and several rooms working at once.
  // Each build in a project of its own (a Git folder of its own): one builder per folder.
  const own = async (name) => {
    const path = join(base, name.replace(/\W+/g, "-").toLowerCase());
    execFileSync("git", ["init", "-q", path]);
    return (await post("api/projects", { path, name, gates: [{ name: "Tests", command: "true" }] })).id;
  };
  const room = async (body) => post("api/rooms", { mode: "build", members: ["codex", "claude"], builder: "codex", reviewer: "claude", ...body, projectId: body.projectId === "demo" ? await own(body.title) : body.projectId });
  const busy = [];
  for (let i = 1; i <= 4; i++) busy.push(await room({ projectId: "demo", task: `Busy build ${i}`, title: `Busy build ${i}` }));
  const checked = await room({ projectId: "slow", task: "Checked build", title: "Checked build" });
  const failing = await room({ projectId: "demo", task: "Failing build", title: "Failing build" });
  const tiny = await room({ projectId: "demo", task: "Tiny build", title: "Tiny build" });
  const paused = await post("api/rooms", { projectId: "demo", mode: "chat", members: ["codex"], title: "Paused chat" });
  await post(`api/rooms/${paused.id}/control`, { action: "pause" });
  const status = async (id) => (await (await fetch(`${url}api/state`)).json()).rooms.find((r) => r.id === id);
  await until(async () => (await status(checked.id)).working?.[0]?.kind === "gates", "the slow checks");
  await until(async () => (await status(failing.id)).questions?.some((q) => q.kind === "error"), "the failed turn");
  await until(async () => (await status(tiny.id)).status === "done", "the finished build");
  // A room in its second session: the first folds in its transcript, and its strip starts again.
  const sprint = await room({ projectId: "demo", task: "Tiny build", title: "Sprint room" });
  await until(async () => (await status(sprint.id)).status === "done", "the sprint room's first session");
  await post(`api/rooms/${sprint.id}/control`, { action: "new-session", ends: 1 });
  await until(async () => (await Promise.all(busy.map((b) => status(b.id)))).every((r) => r.running.length), "the busy rooms");
  // Held: Claude is held, and the room's builder is Claude.
  await post("api/desk", { action: "hold", target: "claude" });
  const held = await room({ projectId: "demo", task: "Held build", title: "Held build", builder: "claude", reviewer: "codex" });
  await until(async () => (await status(held.id)).status === "held", "the held room");

  const browser = await chromium.launch();
  // Each room's tile wears the ring for its state; the logo breathes for the building going on; and with several
  // rooms working at once, the page keeps up (frames timed for three seconds).
  {
    const expected = { "History build": "build", "Busy build 1": "build", "Busy build 2": "build", "Busy build 3": "build", "Busy build 4": "build", "API plan": "needs", "Export plan": "needs", "Database chat": "needs", "Checked build": "checks", "Failing build": "error", "Tiny build": "done", "Paused chat": "paused", "Held build": "held" };
    for (const theme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: theme });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${url}#/r/${build.id}`);
      await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "History build");
      await page.evaluate(() => document.fonts.ready);
      const rings = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".roomlink[data-room]")].map((b) => [b.querySelector(".ri-name").textContent, b.querySelector(".tile").dataset.ring])));
      assert.deepEqual(Object.fromEntries(Object.keys(expected).map((k) => [k, rings[k]])), expected);
      assert.ok(await page.$(".roomlink .tile[data-ring=build] canvas.sparkler"), "a working room's tile has its sparkler");
      assert.ok(await page.$(".roomlink .tile[data-ring=done] .badge"), "a finished room's tile has its check");
      assert.ok(await page.$(".roomlink .tile[data-ring=held] .badge"), "a held room's tile has its lock");
      assert.ok(await page.$(".turn.live .avatar[data-ring=build] canvas.sparkler"), "the working agent wears its ring");
      assert.match(await page.$eval("#liveMark", (m) => m.style.animation), /mk-build/);
      // The sparklers on the screen are being drawn (one loop for all of them).
      await page.waitForFunction(() => [...document.querySelectorAll(".roomlink canvas.sparkler")].some((c) => c.width !== 300));
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(out, `rings-1440-${theme}.png`) });
      if (theme === "light") {
        // Drawing the rail again (any room changing) keeps a tile that shows the same thing: the same element, so its
        // sparkler doesn't start over; and every tile's animations take their delay from the shared clock.
        await page.evaluate(() => (document.querySelector(".roomlink[aria-current=true] .tile").dataset.mark = "kept"));
        await post(`api/rooms/${paused.id}/messages`, { text: "Later.", to: "codex", answering: false });
        await page.waitForTimeout(800);
        assert.equal(await page.evaluate(() => document.querySelector(".roomlink[aria-current=true] .tile").dataset.mark), "kept");
        const delays = await page.$eval(".roomlink .tile[data-ring=build]", (t) => ["--phb", "--phn", "--phm"].map((v) => parseFloat(t.style.getPropertyValue(v))));
        assert.ok(delays.every((d) => d <= 0 && d > -3200), `negative delays from the clock: ${delays}`);
        const frames = await page.evaluate(() => new Promise((resolve) => {
          const gaps = [];
          let last = performance.now();
          const end = last + 3000;
          const step = (t) => {
            gaps.push(t - last);
            last = t;
            if (t < end) requestAnimationFrame(step);
            else resolve(gaps);
          };
          requestAnimationFrame(step);
        }));
        frames.sort((a, b) => a - b);
        const p95 = frames[Math.floor(frames.length * 0.95)];
        const sparklers = await page.$$eval("canvas.sparkler", (c) => c.length);
        console.log(`${sparklers} sparklers: ${frames.length} frames in 3 s, 95% within ${p95.toFixed(1)} ms`);
        assert.ok(p95 < 34, `the page keeps up with ${sparklers} sparklers (95% of frames within ${p95.toFixed(1)} ms)`);
        // The pixel ratio changes (zooming, a window moved to another screen): each sparkler's bitmap follows it,
        // up to 2, in both directions.
        const cdp = await page.context().newCDPSession(page);
        for (const ratio of [2, 3, 1]) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: ratio, mobile: false });
          await page.waitForFunction((r) => {
            const c = document.querySelector("#roomTile canvas.sparkler");
            return c.width === Math.round(parseFloat(c.style.width) * Math.min(2, r));
          }, ratio);
        }
        await cdp.send("Emulation.clearDeviceMetricsOverride");
      }
      await ctx.close();
    }
  }
  const errors = [];
  const shoot = async ({ width, height = 900, theme, motion = "no-preference", room, pane = "room", tab, sheet, file }) => {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: motion });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    if (pane === "home") {
      await page.goto(`${url}#/`);
      await page.waitForSelector(".home .hero");
    } else {
      await page.goto(`${url}#/r/${room}`);
      await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent);
    }
    await page.evaluate(() => document.fonts.ready);
    if (pane === "rooms") await page.click("#tabbar [data-view=rooms]");
    if (tab) await page.click(width > 1180 ? `[data-sidetab=${tab}]` : `[data-roomtab=${tab}]`);
    if (sheet) {
      if (width <= 760 && sheet === "#newRoomBtn") await page.click("#tabbar [data-view=rooms]");
      // One button, or several in turn (a sheet opened from another).
      for (const button of [].concat(sheet)) await page.click(button);
      await page.waitForSelector("#sheet:not([hidden])");
    }
    await page.waitForTimeout(400);
    // The composer stays in view below the timeline, however long it is.
    if (pane === "room" && !sheet && !(tab && width <= 1180)) {
      const box = await page.evaluate(() => { const r = document.querySelector("#composer").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight }; });
      assert.ok(box.bottom <= box.h + 1 && box.bottom - box.top > 40, `${file}: the composer is in view (${JSON.stringify(box)})`);
    }
    // A message's text flows across its card, in one column.
    const squeezed = await page.evaluate(() => [...document.querySelectorAll(".turn .body")].filter((b) => b.checkVisibility() && (getComputedStyle(b).display === "grid" || b.clientWidth < b.closest(".turn").clientWidth * 0.8)).length);
    assert.equal(squeezed, 0, `${file}: message text squeezed`);
    // Every text that's on the screen, as drawn (backgrounds and opacity composited), passes WCAG AA.
    assert.deepEqual(await page.evaluate(contrastProblems, Boolean(sheet)), [], `${file}: contrast`);
    // Nothing scrolls sideways: the page, and every scrolling area in it.
    const wide = await page.evaluate(() => {
      const over = [document.documentElement, ...document.querySelectorAll(".log, .side, .rail, .sheet, .homeview")].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== "hidden");
      return over.map((n) => `${n.className || n.tagName}: ${n.scrollWidth} > ${n.clientWidth}`);
    });
    assert.deepEqual(wide, [], `${file}: sideways scrolling`);
    await page.screenshot({ path: join(out, `${file}.png`) });
    // Home scrolls inside its own area: a second picture, the whole of it.
    if (pane === "home") {
      await page.addStyleTag({ content: ".app { height: auto !important; min-height: 0 !important; } .desk, #view, .homeview { height: auto !important; overflow: visible !important; }" });
      await page.screenshot({ path: join(out, `${file}-full.png`), fullPage: true });
    }
    await ctx.close();
  };
  // The top bar's count opens the room with the oldest question (the chat's; the planning room's came later).
  {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${url}#/r/${build.id}`);
    await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "History build");
    await page.click("[data-next-ask]");
    await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "Database chat");
    // It shows the question, and still does once the room has settled (with messages below it).
    const question = (await view(chat.id)).questions[0].id;
    await page.waitForTimeout(1000);
    const seen = await page.evaluate((id) => {
      const card = document.querySelector(`#log [data-id="${id}"]`).getBoundingClientRect();
      const log = document.querySelector("#log").getBoundingClientRect();
      return card.top >= log.top - 1 && card.bottom <= log.bottom + 1;
    }, question);
    assert.ok(seen, "the oldest question is in view");
    await page.close();
  }
  for (const theme of ["light", "dark"]) {
    await shoot({ width: 1440, theme, pane: "home", file: `home-1440-${theme}` });
    await shoot({ width: 1024, theme, pane: "home", file: `home-1024-${theme}` });
    await shoot({ width: 390, height: 844, theme, pane: "home", file: `home-390-${theme}` });
    await shoot({ width: 1440, theme, room: build.id, file: `build-1440-${theme}` });
    await shoot({ width: 1440, theme, room: build.id, tab: "crew", file: `crew-1440-${theme}` });
    await shoot({ width: 1440, theme, room: chat.id, file: `chat-1440-${theme}` });
    await shoot({ width: 1440, theme, room: plan.id, file: `plan-1440-${theme}` });
    await shoot({ width: 1440, theme, room: ready.id, file: `ready-plan-1440-${theme}` });
    await shoot({ width: 390, height: 844, theme, room: ready.id, file: `ready-plan-390-${theme}` });
    await shoot({ width: 1024, theme, room: build.id, file: `build-1024-${theme}` });
    await shoot({ width: 1024, theme, room: build.id, tab: "plan", file: `plan-tab-1024-${theme}` });
    await shoot({ width: 390, height: 844, theme, room: build.id, file: `build-390-${theme}` });
    await shoot({ width: 390, height: 844, theme, room: chat.id, file: `chat-390-${theme}` });
    await shoot({ width: 390, height: 844, theme, room: build.id, pane: "rooms", file: `rooms-390-${theme}` });
  }
  await shoot({ width: 1440, theme: "light", motion: "reduce", room: build.id, file: "build-1440-reduced-motion" });
  // With reduced motion: the rings stay, solid; no sparkler is drawn and nothing pulses.
  {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })).newPage();
    await page.goto(`${url}#/r/${build.id}`);
    await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "History build");
    await page.waitForTimeout(800);
    const still = await page.evaluate(() => ({
      rings: document.querySelectorAll(".tile[data-ring=build]").length,
      shown: [...document.querySelectorAll("canvas.sparkler")].filter((c) => getComputedStyle(c).display !== "none").length,
      drawn: [...document.querySelectorAll("canvas.sparkler")].filter((c) => c.width !== 300).length,
      moving: document.getAnimations().filter((a) => a.playState === "running").length,
    }));
    assert.ok(still.rings > 0);
    assert.deepEqual({ shown: still.shown, drawn: still.drawn, moving: still.moving }, { shown: 0, drawn: 0, moving: 0 });
    // Reduced motion turned off: the sparklers start at once, though nothing on the page changes. (In the finished
    // build's room, where no timer ticks.)
    await page.goto(`${url}#/r/${tiny.id}`);
    await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "Tiny build");
    await page.waitForTimeout(1000);
    assert.equal(await page.$$eval("canvas.sparkler", (cs) => cs.filter((c) => c.width !== 300).length), 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => [...document.querySelectorAll(".roomlink canvas.sparkler")].some((c) => c.width !== 300), null, { timeout: 500 });
    await page.close();
  }
  // Sheets: a new room, and the settings.
  for (const [width, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [320, "dark"]]) {
    await shoot({ width, height: width > 400 ? 900 : 700, theme, room: build.id, sheet: "#newRoomBtn", file: `sheet-new-room-${width}-${theme}` });
    await shoot({ width, height: width > 400 ? 900 : 700, theme, room: build.id, sheet: "#settingsBtn", file: `sheet-settings-${width}-${theme}` });
    await shoot({ width, height: width > 400 ? 900 : 700, theme, room: sprint.id, sheet: ["#roomBtn", "[data-new-session]"], file: `sheet-new-session-${width}-${theme}` });
    await shoot({ width, height: width > 400 ? 900 : 700, theme, room: sprint.id, file: `sprint-${width}-${theme}` });
  }
  await shoot({ width: 1440, theme: "light", motion: "reduce", pane: "home", file: "home-1440-reduced-motion" });
  for (const width of [320, 390]) {
    await shoot({ width, height: 700, theme: "light", pane: "home", file: `home-${width}` });
    await shoot({ width, height: 700, theme: "light", room: build.id, tab: "crew", file: `crew-${width}` });
    await shoot({ width, height: 700, theme: "light", room: plan.id, file: `plan-${width}` });
    await shoot({ width, height: 700, theme: "light", room: ready.id, file: `ready-plan-${width}` });
  }
  await browser.close();
  assert.deepEqual(errors, []);
  console.log(`Screenshots in ${out}`);
} finally {
  desk?.kill("SIGTERM");
  await new Promise((r) => (desk ? desk.once("exit", r) : r()));
  rmSync(base, { recursive: true, force: true });
}

/** In the page: every visible text whose contrast with what's behind it, as drawn, is below WCAG AA. */
function contrastProblems(inSheet) {
  const parse = (c) => {
    let m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    m = c.match(/^color\(srgb ([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
    }
    return null;
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const behind = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    return layers.reverse().reduce((bg, layer) => over(layer, bg), [255, 255, 255, 1]);
  };
  const lum = (c) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const problems = [];
  const seen = new Set();
  const walk = document.createTreeWalker(inSheet ? document.querySelector("#sheet") : document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const text = walk.currentNode;
    const el = text.parentElement;
    if (!text.textContent.trim() || seen.has(el)) continue;
    seen.add(el);
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest("[disabled], option, script, style, .sr")) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    const color = parse(cs.color);
    if (!color) continue;
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const bg = behind(el);
    const fg = over([color[0], color[1], color[2], color[3] * opacity], bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
    const r = ratio(fg, bg);
    if (r < (large ? 3 : 4.5)) problems.push(`${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).replace(/\s+/g, ".")}` : ""} “${text.textContent.trim().slice(0, 40)}” ${r.toFixed(2)}:1`);
  }
  return problems;
}
