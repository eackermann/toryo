#!/usr/bin/env node
/**
 * A check of the page in a real browser, outside the test suite because it needs Playwright, which
 * Toryo doesn't depend on. It starts its own desk on a free port with a temporary data folder, the
 * fake agents and a fake Codex app (its own thread list and logs; the real app is never touched).
 *
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node test/ui-check.mjs
 *
 * Without PLAYWRIGHT_CORE it uses a playwright-core that Node can find from here, if there is one.
 */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/engine.mjs";

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

const base = mkdtempSync(join(tmpdir(), "toryo-ui-"));
const home = join(base, "home");
const repo = join(base, "repo");
const codexHome = join(base, "codex-home");
const THREADS = [
  { id: "0aaaaaaa-0000-0000-0000-00000000000a", name: "Main build thread" },
  { id: "0bbbbbbb-0000-0000-0000-00000000000b", name: "Side experiments" },
];
let desk;
try {
  // The project, the fake agents' script, and a fake Codex app.
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "# ui\n");
  const rules = [
    { agent: "codex", match: "step 1 of 4", reply: "Codex proposal.\n- Q: Use SQLite? (Recommended: yes)\nTORYO: PROPOSAL" },
    { agent: "claude", match: "step 1 of 4", reply: "Claude proposal.\n- Q: Ship a CLI too? (Recommended: no)\nTORYO: PROPOSAL" },
    { match: "step 2 of 4", reply: "Critique.\nTORYO: CRITIQUE" },
    { agent: "claude", match: "Both of you", reply: "TORYO: OWNER Which host?" },
    // A plan Codex writes and Claude approves (step 5q), then a change forwarded from your talk with Claude.
    { agent: "codex", match: "step 3 of 4", write: { path: "docs/plans/ui.md", content: "# Exports\n\n### Slice 1: One\n" }, reply: "Written.\nTORYO: REVIEW docs/plans/ui.md" },
    { agent: "claude", match: "step 4 of 4|Check the revised plan", reply: "Fine.\nTORYO: APPROVED" },
    { agent: "claude", match: "Anything missing", reply: "Slice 1 needs a test.\nTORYO: REPLY" },
    { agent: "codex", match: "The owner asked for changes to the plan", write: { path: "docs/plans/ui.md", content: "# Exports\n\n### Slice 1: One, tested\n" }, reply: "Added it.\nTORYO: REVIEW docs/plans/ui.md" },
    { agent: "codex", match: "Slow build of the parser", delayMs: 6000, reply: "Built the parser.\nTORYO: OWNER Ship it?" },
    // Step 5t: a Codex turn whose session log puts both its limits over the guard (with resets), and a Claude turn
    // whose 5-hour limit is over it with no reset time.
    { agent: "codex", match: "Use it all up", codexUsage: { primary: { used_percent: 96, window_minutes: 300, resets_at: Math.round(Date.now() / 1000) + 3600 }, secondary: { used_percent: 95, window_minutes: 10080, resets_at: Math.round(Date.now() / 1000) + 86400 } }, reply: "Used.\nTORYO: REPLY" },
    { agent: "claude", match: "Unknown reset", rateLimit: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.97 } } }, reply: "OK.\nTORYO: REPLY" },
    // Step 5u: a turn long enough to watch on the session's strip. Step 5v: a build whose checks it watches.
    { agent: "codex", match: "Strip turn", progress: "npm test", workMs: 3000, reply: "Done.\nTORYO: REPLY" },
    { agent: "codex", match: "Strip checks", reply: "Built.\nTORYO: REVIEW Slice 1: It | h.md" },
    // Step 5x: a turn that keeps a room busy, then the first message of a new session.
    { agent: "codex", match: "Hold this", hang: true },
    { agent: "codex", match: "Next sprint", workMs: 1200, reply: "Ready.\nTORYO: REPLY" },
    // Step 5s: a turn that takes a while to start (preparing), then works, saying what it runs.
    { agent: "codex", match: "Phases for Home", delayMs: 2500, progress: "npm run build", workMs: 4000, reply: "Built.\nTORYO: REPLY" },
    { agent: "codex", match: "Slow review of the (lexer|docs)", delayMs: 6000, reply: "Built it.\nTORYO: REVIEW Slice 1: It | h.md" },
    { agent: "claude", hang: true },
    { agent: "codex", reply: "Which one? I recommend SQLite.\nTORYO: OWNER SQLite or Postgres?" },
  ];
  writeFileSync(join(base, "script.json"), JSON.stringify({ rules, log: join(base, "calls.jsonl") }));
  // The desk serves a copy of the page, so this check can change files under it.
  const web = join(base, "web");
  cpSync(join(root, "web"), web, { recursive: true });
  const day = join(codexHome, "sessions", "2026", "10", "13");
  mkdirSync(day, { recursive: true });
  for (const t of THREADS) writeFileSync(join(day, `rollout-2026-10-13T00-00-00-${t.id}.jsonl`), "");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  db.exec("create table threads (id text, name text, preview text, cwd text, updated_at_ms integer, archived integer, source text)");
  for (const t of THREADS) db.prepare("insert into threads values (?, ?, '', ?, ?, 0, 'vscode')").run(t.id, t.name, repo, Date.now());
  db.close();
  const exe = join(base, "codex.exe");
  writeFileSync(exe, "#!/bin/sh\nexit 0\n"); // queues nothing: the app's turn just waits
  chmodSync(exe, 0o755);
  mkdirSync(home, { recursive: true });
  const node = process.execPath;
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      version: 1,
      notify: { windows: false },
      agents: {
        codex: { command: [node, FAKE, "codex"] },
        claude: { command: [node, FAKE, "claude"] },
        codexapp: { exe, codexHome, thread: THREADS[0].id, openThread: "never" },
      },
      projects: [{ id: "ui", name: "ui", path: repo, rules: "", decisions: "", agents: {}, gates: [{ name: "Slow check", command: "true", timeoutMin: 45 }] }],
    }),
  );

  // Codex's usage as last read: a fresh 5-hour reading that resets in 10 minutes, and a six-hour-old weekly one.
  const seededAt = Date.now();
  const usageWindow = (type, label, minutes, used, resetsAt, sourceAt) => ({ type, label, minutes, used, resetsAt: new Date(resetsAt).toISOString(), sourceAt: new Date(sourceAt).toISOString(), receivedAt: new Date(sourceAt).toISOString(), source: "log" });
  writeFileSync(
    join(home, "limits.json"),
    JSON.stringify({ version: 2, agents: { codex: { status: "allowed", windows: { five_hour: usageWindow("five_hour", "5-hour", 300, 64, seededAt + 10 * 60_000, seededAt - 60_000), weekly: usageWindow("weekly", "weekly", 10080, 30, seededAt + 3 * 86_400_000, seededAt - 6 * 3_600_000) } } } }),
  );

  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  // This check's own desk (its own port and folder); step 5s stops it and starts it again.
  const startDesk = async () => {
    desk = spawn(node, [join(root, "bin", "toryo.mjs"), "--port", String(port)], {
      env: { ...process.env, TORYO_HOME: home, TORYO_WEB_DIR: web, FAKE_SCRIPT: join(base, "script.json"), CODEX_HOME: join(base, "codex") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise((resolve) => desk.stdout.on("data", (d) => /Toryo is running/.test(d) && resolve()));
  };
  await startDesk();
  const url = `http://localhost:${port}/`;

  const browser = await chromium.launch();
  // A context, not a lone page, so a second tab can share its saved drafts (step 5j).
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  const outside = [];
  page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => !r.url().startsWith(url) && outside.push(r.url()));
  await page.goto(url);
  await page.waitForSelector("#newRoomBtn");

  // 0. Usage meters, on Home (the page that opens first): each window of Codex's allowance says how old its own
  // reading is, and a limit that resets while the page sits idle (no readings, no events, no navigation) shows as
  // reset rather than keeping its old percentage.
  const idle = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  idle.on("pageerror", (e) => errors.push(String(e)));
  await idle.clock.install();
  await idle.goto(url);
  await idle.waitForSelector(".home .allow[data-group=openai] .hmeter[data-window=five_hour]");
  const meter = (type) => idle.innerText(`.home .allow[data-group=openai] .hmeter[data-window=${type}]`);
  assert.match(await meter("five_hour"), /64%[\s\S]*resets .* \(in \d+ min\)[\s\S]*read (\d+s|1 min) ago from Codex/);
  assert.match(await meter("weekly"), /30%[\s\S]*read 6 h ago/);
  await idle.clock.fastForward("15:00");
  await idle.waitForFunction(() => /reset/.test(document.querySelector(".home .allow[data-group=openai] .hmeter[data-window=five_hour]")?.innerText ?? ""));
  assert.doesNotMatch(await meter("five_hour"), /64%/);
  assert.match(await meter("five_hour"), /has reset; waiting for a new reading/);
  await idle.close();

  // 1. Settings: saving without changes keeps the check's time limit; the project gets its own default thread.
  await page.click("#settingsBtn");
  await page.waitForFunction(() => document.querySelectorAll("#pAppThread option").length > 1);
  assert.equal(await page.inputValue("input[name=gmin]"), "45");
  await page.selectOption("#pAppThread", THREADS[1].id);
  await page.click("#settingsForm button[type=submit]");
  await page.waitForSelector("#sheet", { state: "hidden" });
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(cfg.projects[0].gates, [{ name: "Slow check", command: "true", timeoutMin: 45 }]);
  assert.equal(cfg.projects[0].agents.codexapp.thread, THREADS[1].id);
  assert.equal(cfg.agents.codexapp.thread, THREADS[0].id);

  // 2. A new room with the Codex app: the form offers the project's default thread.
  await page.click("#newRoomBtn");
  await page.click(".modecard[data-mode=build]");
  await page.selectOption("#nrBuilder", "codexapp");
  await page.waitForFunction(() => !document.querySelector("#nrAppBox").hidden && document.querySelector("#nrThread").value);
  assert.equal(await page.inputValue("#nrThread"), THREADS[1].id);
  await page.fill("#nrTask", "Build it");
  await page.fill("#nrTitle", "App room");
  await page.click("#newRoomForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "App room");

  // 3. The crew card shows the room's thread and won't change it while the app works.
  await page.waitForFunction((n) => document.querySelector("#crewPane")?.innerText.includes(n), THREADS[1].name);
  assert.equal(await page.getAttribute("#crewPane a[href^='codex://']", "href"), `codex://threads/${THREADS[1].id}`);
  assert.equal(await page.isDisabled("[data-change-thread]"), true);

  // 3a. Ask or Tell follows what you write until you choose.
  await page.fill("#msg", "Should we split it?");
  assert.equal(await page.getAttribute("#intent [data-intent=ask]", "aria-pressed"), "true");
  await page.click("#intent [data-intent=tell]");
  await page.fill("#msg", "Why not?");
  assert.equal(await page.getAttribute("#intent [data-intent=tell]", "aria-pressed"), "true", "your choice holds");
  await page.fill("#msg", "");

  // 3b. Enter sends and Shift+Enter starts a new line. A note still queued (the app is busy) can be edited, then withdrawn.
  await page.click("#msg");
  await page.keyboard.type("First line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  assert.equal(await page.inputValue("#msg"), "First line\nsecond line");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".owner .md")].some((m) => /First line[\s\S]*second line/.test(m.innerText)));
  assert.match(await page.locator(".owner", { hasText: "second line" }).last().locator(".to").innerText(), /^Tell/);
  assert.equal(await page.inputValue("#msg"), "");
  const noteId = await page.locator(".owner", { hasText: "second line" }).last().getAttribute("data-id");
  const note = page.locator(`.owner[data-id="${noteId}"]`);
  await note.locator("[data-note-edit]").click();
  await note.locator("textarea.noteedit").fill("Edited note text");
  await note.locator("[data-note-save]").click();
  await page.waitForFunction((id) => {
    const o = document.querySelector(`.owner[data-id="${id}"]`);
    return o && /Edited note text/.test(o.innerText) && /edited/.test(o.querySelector(".to").innerText);
  }, noteId);
  await note.locator("[data-note-cancel]").click();
  await page.waitForFunction((id) => /withdrawn/.test(document.querySelector(`.owner[data-id="${id}"][data-cancelled=true]`)?.innerText ?? ""), noteId);

  // 4. The rail says who is doing what, in one line under the room's name.
  await page.waitForFunction(() => /Codex app building/.test(document.querySelector(".roomlink[aria-current=true] .ri-state")?.textContent ?? ""));
  const row = await page.$eval(".roomlink[aria-current=true]", (b) => ({ title: b.title, text: b.querySelector(".ri-state").textContent, k: b.querySelector(".ri-state").dataset.k, mono: b.querySelector(".tile").textContent }));
  assert.match(row.title, /Codex app is building/);
  assert.equal(row.text, "Codex app building");
  assert.equal(row.k, "work");
  assert.equal(row.mono, "AR");

  // 5. A question asked in chat: "needs you" comes first in the room list.
  const asked = await (await fetch(`${url}api/rooms`, { method: "POST", headers: { "content-type": "application/json", "x-toryo": "1" }, body: JSON.stringify({ projectId: "ui", mode: "chat", members: ["codex"], text: "Ask me something.", to: "codex", title: "Asking room" }) })).json();
  await page.waitForFunction((id) => document.querySelector(`.roomlink[data-room="${id}"]`)?.dataset.state === "waiting", asked.id);
  const ask = await page.$eval(`.roomlink[data-room="${asked.id}"]`, (b) => ({ title: b.title, state: b.querySelector(".ri-state").textContent, k: b.querySelector(".ri-state").dataset.k }));
  assert.equal(ask.k, "you");
  assert.match(ask.state, /^Needs you/);
  assert.match(ask.title, /Codex is waiting for your answer/);

  // 5b. An agent with a session in a room can be started fresh there.
  await page.click(`.roomlink[data-room="${asked.id}"]`);
  await page.click("[data-sidetab=crew]");
  await page.waitForSelector("[data-fresh=codex]");
  await page.click("[data-fresh=codex]");
  await page.waitForFunction(() => /Starts fresh on its next turn/.test(document.querySelector("#crewPane")?.innerText ?? ""));

  // 5c. "Write my own answer" names that card's question. Answered elsewhere first (another tab, the phone) and the
  // agent asks again: the note isn't sent, so it never lands on the newer question, and your text stays.
  const post = async (path, body) => (await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-toryo": "1" }, body: JSON.stringify(body) })).json();
  const questions = async (id) => (await (await fetch(`${url}api/rooms/${id}`)).json()).questions;
  const [first] = await questions(asked.id);
  await page.click(`.decision[data-id="${first.id}"] [data-answer-focus]`);
  await page.waitForFunction(() => /your answer to “SQLite or Postgres\?”/.test(document.querySelector("#routeInfo").innerText));
  await post(`api/rooms/${asked.id}/answer`, { questionId: first.id, text: "Postgres." });
  await page.waitForFunction((id) => document.querySelector(`.decision:not(.closed)[data-id]:not([data-id="${id}"]) [data-chat-accept]`), first.id);
  const [second] = await questions(asked.id);
  assert.notEqual(second.id, first.id);
  await page.fill("#msg", "SQLite please.");
  await page.press("#msg", "Enter");
  await page.waitForFunction(() => /already been answered/.test(document.querySelector("#toasts").innerText));
  assert.equal(await page.inputValue("#msg"), "SQLite please.");
  // The browser logs the refusal (409) as a failed request: expected here, and only here.
  const refused = errors.findIndex((e) => /status of 409/.test(e));
  assert.ok(refused >= 0);
  errors.splice(refused, 1);
  assert.deepEqual((await questions(asked.id)).map((q) => q.id), [second.id]);
  // "Use the recommendation" answers its own card's question.
  await page.fill("#msg", "");
  await page.click(`.decision[data-id="${second.id}"] [data-chat-accept]`);
  await page.waitForFunction((id) => /You answered: Go with your recommendation: SQLite/.test(document.querySelector(`.decision.closed[data-id="${id}"]`)?.innerText ?? ""), second.id);
  const asking = await (await fetch(`${url}api/rooms/${asked.id}`)).json();
  assert.ok(!asking.events.some((e) => e.type === "owner" && /SQLite please/.test(e.text)));

  // 5c2. Typing straight into the composer binds the note to the question it shows, and the binding survives a
  // reload. Answered elsewhere while the page reloads, so the reloaded page only ever sees the newer question: Enter
  // is refused. Sent again, it goes as a note and answers nothing.
  await page.waitForFunction(() => document.querySelectorAll(".decision:not(.closed) [data-chat-accept]").length === 1);
  const [third] = await questions(asked.id);
  await page.click("#msg");
  await page.keyboard.type("Postgres, final answer.");
  await page.waitForFunction(() => /your answer to “SQLite or Postgres\?”/.test(document.querySelector("#routeInfo").innerText));
  await post(`api/rooms/${asked.id}/answer`, { questionId: third.id, text: "SQLite." });
  // Waits for a condition on the desk (up to 10 s); not met in time is a failure.
  const until = async (fn, what = "a condition on the desk") => {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  await until(async () => (await questions(asked.id)).some((q) => q.id !== third.id));
  const [fourth] = await questions(asked.id);
  assert.notEqual(fourth.id, third.id);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#msg").value === "Postgres, final answer.");
  await page.waitForFunction(() => /answered meanwhile, so it won't be sent/.test(document.querySelector("#routeInfo").innerText));
  await page.press("#msg", "Enter");
  await page.waitForFunction(() => /Not sent[\s\S]*already been answered/.test(document.querySelector("#toasts").innerText));
  assert.equal(await page.inputValue("#msg"), "Postgres, final answer.");
  assert.deepEqual((await questions(asked.id)).map((q) => q.id), [fourth.id]);
  const refusedAgain = errors.findIndex((e) => /status of 409/.test(e));
  assert.ok(refusedAgain >= 0);
  errors.splice(refusedAgain, 1);
  await page.waitForFunction(() => /a note, not an answer/.test(document.querySelector("#routeInfo").innerText));
  await page.press("#msg", "Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".owner .md")].some((m) => /Postgres, final answer/.test(m.innerText)));
  const noted = (await (await fetch(`${url}api/rooms/${asked.id}`)).json()).events.find((e) => e.type === "owner" && /final answer/.test(e.text));
  assert.equal(noted.kind, undefined);
  assert.equal(noted.answers, undefined);
  assert.ok((await questions(asked.id)).some((q) => q.id === fourth.id), "the newer question is still open");

  // 5d. A planning checkpoint: "Accept all recommendations" records each one as shown, with the author you pick.
  const plan = await post("api/rooms", { projectId: "ui", mode: "plan", topic: "Storage", members: ["codex", "claude"], title: "Plan room" });
  await page.waitForSelector(`.roomlink[data-room="${plan.id}"]`);
  await page.click(`.roomlink[data-room="${plan.id}"]`);
  await page.waitForSelector("[data-checkpoint] [data-accept-checkpoint]");
  await page.selectOption("#cqWho", "claude");
  await page.click("[data-accept-checkpoint]");
  await page.waitForFunction(() => /Use SQLite\? → yes \(Codex's recommendation\)/.test(document.querySelector("#log").innerText));
  const planned = await (await fetch(`${url}api/rooms/${plan.id}`)).json();
  assert.equal(planned.room.plan.synthesizer, "claude");
  assert.match(planned.events.find((e) => e.kind === "decisions").text, /Ship a CLI too\? → no \(Claude's recommendation\)/);

  // 5e. Each room keeps its own draft, tied to its own question: text written in one room never answers another's.
  const view = async (id) => (await fetch(`${url}api/rooms/${id}`)).json();
  const openRoom = async (id, title) => {
    await page.waitForSelector(`.roomlink[data-room="${id}"]`);
    await page.click(`.roomlink[data-room="${id}"]`);
    await page.waitForFunction((t) => document.querySelector("#roomTitle")?.textContent === t, title);
  };
  const other = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], text: "Ask me too.", to: "codex", title: "Second asking room" });
  await until(async () => (await questions(other.id)).length === 1);
  const [otherQ] = await questions(other.id);
  const [firstQ] = await questions(asked.id);
  await openRoom(asked.id, "Asking room");
  await page.fill("#msg", "Draft for the first room.");
  await page.waitForFunction(() => /your answer to/.test(document.querySelector("#routeInfo").innerText));
  await openRoom(other.id, "Second asking room");
  assert.equal(await page.inputValue("#msg"), "", "the first room's text stays in the first room");
  await page.fill("#msg", "Draft for the second room.");
  await openRoom(asked.id, "Asking room");
  await page.waitForFunction(() => document.querySelector("#msg").value === "Draft for the first room.");
  await page.press("#msg", "Enter");
  await until(async () => (await view(asked.id)).events.find((e) => e.id === firstQ.id).open === false);
  assert.equal((await view(asked.id)).events.find((e) => e.id === firstQ.id).answer, "Draft for the first room.");
  assert.deepEqual((await questions(other.id)).map((q) => q.id), [otherQ.id]);
  await openRoom(other.id, "Second asking room");
  await page.waitForFunction(() => document.querySelector("#msg").value === "Draft for the second room.");
  await page.press("#msg", "Enter");
  await until(async () => (await view(other.id)).events.find((e) => e.id === otherQ.id).open === false);
  assert.equal((await view(other.id)).events.find((e) => e.id === otherQ.id).answer, "Draft for the second room.");

  // 5f. A draft keeps its recipient across a reload: with two agents asking, the one you chose gets the answer.
  const two = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex", "claude"], text: "Both of you, ask me something.", to: "everyone", title: "Two askers" });
  await until(async () => (await questions(two.id)).length === 2);
  const [firstAsk, secondAsk] = await questions(two.id);
  await openRoom(two.id, "Two askers");
  await page.click(`#recipients [data-route="${secondAsk.from}"]`);
  await page.fill("#msg", "Yes.");
  const answersSecond = (q) => new RegExp(`your answer to “${q.replace(/[?]/g, "\\?")}”`);
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector("#routeInfo").innerText), answersSecond(secondAsk.question).source);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#msg").value === "Yes.");
  assert.equal(await page.getAttribute(`#recipients [data-route="${secondAsk.from}"]`, "aria-pressed"), "true");
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector("#routeInfo").innerText), answersSecond(secondAsk.question).source);
  await page.press("#msg", "Enter");
  await until(async () => (await view(two.id)).events.find((e) => e.id === secondAsk.id).open === false);
  assert.equal((await view(two.id)).events.find((e) => e.id === secondAsk.id).answer, "Yes.");
  assert.ok((await questions(two.id)).some((q) => q.id === firstAsk.id), "the other agent's question is still open");

  // 5g. A reply that comes after you've switched rooms acts only on the draft it sent. The first room's sends are held
  // back (a slow connection) while you write in the second room.
  const settled = async (id) => (await view(id)).live.length === 0 && (await questions(id)).length > 0;
  await until(async () => (await settled(asked.id)) && (await settled(other.id)));
  let gate = Promise.resolve();
  let release = () => {};
  const holdSends = () => (gate = new Promise((r) => (release = r)));
  await page.route(`**/api/rooms/${asked.id}/messages`, async (route) => {
    await gate;
    await route.continue();
  });
  const clearToasts = () => page.evaluate(() => document.querySelector("#toasts").replaceChildren());
  const toastSays = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#toasts").innerText), re.source);
  const dropRefusal = () => {
    const i = errors.findIndex((e) => /status of 409/.test(e));
    assert.ok(i >= 0);
    errors.splice(i, 1);
  };
  await openRoom(asked.id, "Asking room");
  const [aQ] = await questions(asked.id);
  await page.fill("#msg", "Slow answer for the first room.");
  holdSends();
  await page.press("#msg", "Enter");
  await openRoom(other.id, "Second asking room");
  const [bQ] = await questions(other.id);
  await page.fill("#msg", "Answer for the second room.");
  await page.waitForFunction(() => /your answer to/.test(document.querySelector("#routeInfo").innerText));
  // Both questions are answered elsewhere; the second room's agent asks again.
  await post(`api/rooms/${asked.id}/answer`, { questionId: aQ.id, text: "From the phone." });
  await post(`api/rooms/${other.id}/answer`, { questionId: bQ.id, text: "From the phone." });
  await until(async () => (await questions(other.id)).some((q) => q.id !== bQ.id));
  const newer = (await questions(other.id)).find((q) => q.id !== bQ.id);
  // The first room's refusal arrives here: it names its room, and this room's draft keeps what it answers.
  await clearToasts();
  let reply = page.waitForResponse((res) => res.url().endsWith(`/api/rooms/${asked.id}/messages`));
  release();
  assert.equal((await reply).status(), 409);
  await toastSays(/Not sent[\s\S]*In “Asking room”/);
  dropRefusal();
  assert.equal(await page.inputValue("#msg"), "Answer for the second room.");
  await page.waitForFunction(() => /answered meanwhile, so it won't be sent/.test(document.querySelector("#routeInfo").innerText));
  await clearToasts();
  await page.press("#msg", "Enter");
  await toastSays(/Not sent/);
  dropRefusal();
  assert.ok((await questions(other.id)).some((q) => q.id === newer.id), "the second room's newer question is still open");
  assert.ok(!(await view(other.id)).events.some((e) => e.type === "owner" && /Answer for the second room/.test(e.text)));
  // A late success clears only the first room's draft.
  await openRoom(asked.id, "Asking room");
  assert.equal(await page.inputValue("#msg"), "Slow answer for the first room.", "its refusal kept the first room's text");
  holdSends();
  await page.press("#msg", "Enter");
  await openRoom(other.id, "Second asking room");
  reply = page.waitForResponse((res) => res.url().endsWith(`/api/rooms/${asked.id}/messages`));
  release();
  assert.equal((await reply).status(), 200);
  await page.waitForFunction((id) => !localStorage.getItem(`toryo.draft.${id}`), asked.id);
  assert.equal(await page.inputValue("#msg"), "Answer for the second room.", "the first room's reply left this draft alone");
  await page.unroute(`**/api/rooms/${asked.id}/messages`);
  const slow = (await view(asked.id)).events.find((e) => e.type === "owner" && /Slow answer/.test(e.text));
  assert.equal(slow.answers, undefined, "sent again after its refusal, it went as a note");
  await openRoom(asked.id, "Asking room");
  assert.equal(await page.inputValue("#msg"), "");

  // 5h. A draft saved by an earlier version of the page, with no record of what it answers, comes back as a note: it
  // isn't tied to whatever question is open now.
  await openRoom(two.id, "Two askers");
  const [still] = await questions(two.id);
  await page.evaluate((id) => {
    localStorage.setItem(`toryo.draft.${id}`, "Old draft from before the update.");
    localStorage.removeItem(`toryo.answering.${id}`);
  }, two.id);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#msg").value === "Old draft from before the update.");
  await page.waitForFunction(() => /a note, not an answer/.test(document.querySelector("#routeInfo").innerText));
  await page.press("#msg", "Enter");
  await until(async () => (await view(two.id)).events.some((e) => e.type === "owner" && /Old draft/.test(e.text)));
  assert.equal((await view(two.id)).events.find((e) => e.type === "owner" && /Old draft/.test(e.text)).answers, undefined);
  assert.ok((await questions(two.id)).some((q) => q.id === still.id), "the open question isn't answered by the old draft");

  // 5i. Choosing another question while a send is on its way, with the same words still in the box, makes it a new
  // draft: the late reply, a success or a refusal, leaves it and the question it now answers alone.
  const pending = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], text: "Ask me.", to: "codex", title: "Pending room" });
  const twoOpen = async () => {
    const before = (await questions(pending.id)).length;
    await post(`api/rooms/${pending.id}/messages`, { text: "And another.", to: "codex", answering: false });
    await until(async () => (await questions(pending.id)).length > before && (await view(pending.id)).live.length === 0);
    return questions(pending.id);
  };
  await until(async () => (await questions(pending.id)).length === 1 && (await view(pending.id)).live.length === 0);
  await page.route(`**/api/rooms/${pending.id}/messages`, async (route) => {
    await gate;
    await route.continue();
  });
  const tie = () => page.evaluate((id) => JSON.parse(localStorage.getItem(`toryo.answering.${id}`) ?? "null"), pending.id);
  await openRoom(pending.id, "Pending room");
  for (const [late, word] of [[200, "Yes."], [409, "No."]]) {
    const [qa, qb] = await twoOpen();
    await page.waitForSelector(`.decision[data-id="${qb.id}"] [data-answer-focus]`);
    await page.fill("#msg", word);
    assert.equal((await tie()).byAgent.codex, qa.id);
    holdSends();
    await page.press("#msg", "Enter");
    // While it's on its way: the other card's "Write my own answer", the same words left in the box.
    await page.click(`.decision[data-id="${qb.id}"] [data-answer-focus]`);
    assert.equal((await tie()).byAgent.codex, qb.id);
    if (late === 409) await post(`api/rooms/${pending.id}/answer`, { questionId: qa.id, text: "From the phone." });
    await clearToasts();
    reply = page.waitForResponse((res) => res.url().endsWith(`/api/rooms/${pending.id}/messages`));
    release();
    assert.equal((await reply).status(), late);
    if (late === 409) {
      await toastSays(/Not sent/);
      dropRefusal();
    } else await page.waitForFunction((id) => document.querySelector(`.decision.closed[data-id="${id}"]`), qa.id);
    assert.equal(await page.inputValue("#msg"), word, "the late reply left the new draft in the box");
    assert.equal((await tie()).byAgent.codex, qb.id, "and what it answers");
    assert.equal((await tie()).route, "codex");
    await page.waitForFunction(() => /your answer to “SQLite or Postgres\?”/.test(document.querySelector("#routeInfo").innerText));
    await page.press("#msg", "Enter");
    await until(async () => (await view(pending.id)).events.find((e) => e.id === qb.id).open === false);
    assert.equal((await view(pending.id)).events.find((e) => e.id === qb.id).answer, word);
    await until(async () => (await view(pending.id)).live.length === 0);
  }
  await page.unroute(`**/api/rooms/${pending.id}/messages`);

  // 5j. Two tabs share their saved drafts. A late reply in the first tab never undoes a newer draft the second tab
  // wrote for that room, whether the first tab is still elsewhere or back in the room showing it.
  await page.route(`**/api/rooms/${pending.id}/messages`, async (route) => {
    await gate;
    await route.continue();
  });
  for (const [late, back] of [[200, false], [409, false], [200, true], [409, true]]) {
    const [qa, qb] = await twoOpen();
    await openRoom(pending.id, "Pending room");
    await page.fill("#msg", "Sent from the first tab.");
    holdSends();
    await page.press("#msg", "Enter");
    await openRoom(other.id, "Second asking room");
    const tab = await page.context().newPage();
    tab.on("pageerror", (e) => errors.push(String(e)));
    await tab.goto(`${url}#/r/${pending.id}`);
    await tab.waitForSelector(`.decision[data-id="${qb.id}"] [data-answer-focus]`);
    await tab.fill("#msg", "Newer, from the second tab.");
    await tab.click(`.decision[data-id="${qb.id}"] [data-answer-focus]`);
    if (late === 409) await post(`api/rooms/${pending.id}/answer`, { questionId: qa.id, text: "From the phone." });
    if (back) {
      await openRoom(pending.id, "Pending room");
      await page.waitForFunction(() => document.querySelector("#msg").value === "Newer, from the second tab.");
    }
    await clearToasts();
    reply = page.waitForResponse((res) => res.url().endsWith(`/api/rooms/${pending.id}/messages`));
    release();
    assert.equal((await reply).status(), late);
    if (late === 409) {
      await toastSays(/Not sent/);
      dropRefusal();
    } else await until(async () => (await view(pending.id)).events.find((e) => e.id === qa.id).answer === "Sent from the first tab.", "the first tab's note to answer its question");
    await new Promise((r) => setTimeout(r, 200));
    const saved = await page.evaluate((id) => ({ text: localStorage.getItem(`toryo.draft.${id}`), tie: JSON.parse(localStorage.getItem(`toryo.answering.${id}`) ?? "null") }), pending.id);
    assert.equal(saved.text, "Newer, from the second tab.", `late ${late}, ${back ? "back in the room" : "elsewhere"}: the newer draft stays`);
    assert.equal(saved.tie?.byAgent.codex, qb.id, "and so does what it answers");
    assert.equal(saved.tie?.route, "codex");
    if (back) assert.equal(await page.inputValue("#msg"), "Newer, from the second tab.");
    // The second tab sends its draft: it answers the question it chose.
    await tab.press("#msg", "Enter");
    await until(async () => (await view(pending.id)).events.find((e) => e.id === qb.id).open === false);
    assert.equal((await view(pending.id)).events.find((e) => e.id === qb.id).answer, "Newer, from the second tab.");
    // Its reply has come back (its box is empty, the saved draft gone) before it closes.
    await tab.waitForFunction(() => document.querySelector("#msg").value === "");
    await tab.close();
    await until(async () => (await view(pending.id)).live.length === 0);
  }
  // 5k. The second tab writes first: its newer draft is saved before the first tab sends the older answer it still
  // shows. The first tab's late reply leaves the second tab's draft alone, whether the first tab moved on or stayed.
  for (const [late, stay] of [[200, false], [409, false], [200, true], [409, true]]) {
    const [qa, qb] = await twoOpen();
    // Start from the room's saved draft (the second tab sent the last one).
    await openRoom(other.id, "Second asking room");
    await openRoom(pending.id, "Pending room");
    assert.equal(await page.inputValue("#msg"), "");
    await page.fill("#msg", "Older, from the first tab.");
    assert.equal((await page.evaluate((id) => JSON.parse(localStorage.getItem(`toryo.answering.${id}`)), pending.id)).byAgent.codex, qa.id);
    const tab = await page.context().newPage();
    tab.on("pageerror", (e) => errors.push(String(e)));
    await tab.goto(`${url}#/r/${pending.id}`);
    await tab.waitForSelector(`.decision[data-id="${qb.id}"] [data-answer-focus]`);
    await tab.fill("#msg", "Newer, from the second tab.");
    await tab.click(`.decision[data-id="${qb.id}"] [data-answer-focus]`);
    if (late === 409) await post(`api/rooms/${pending.id}/answer`, { questionId: qa.id, text: "From the phone." });
    holdSends();
    await page.press("#msg", "Enter");
    if (!stay) await openRoom(other.id, "Second asking room");
    await clearToasts();
    reply = page.waitForResponse((res) => res.url().endsWith(`/api/rooms/${pending.id}/messages`));
    release();
    assert.equal((await reply).status(), late);
    if (late === 409) {
      await toastSays(/Not sent/);
      dropRefusal();
    } else await until(async () => (await view(pending.id)).events.find((e) => e.id === qa.id).open === false);
    await new Promise((r) => setTimeout(r, 200));
    const saved = await page.evaluate((id) => ({ text: localStorage.getItem(`toryo.draft.${id}`), tie: JSON.parse(localStorage.getItem(`toryo.answering.${id}`) ?? "null") }), pending.id);
    const what = `late ${late}, first tab ${stay ? "stayed" : "moved on"}`;
    assert.equal(saved.text, "Newer, from the second tab.", `${what}: the second tab's draft stays`);
    assert.equal(saved.tie?.byAgent.codex, qb.id, `${what}: and so does what it answers`);
    assert.equal(saved.tie?.route, "codex");
    // The first tab's own box: emptied once its note went, kept when it was refused.
    if (stay) assert.equal(await page.inputValue("#msg"), late === 200 ? "" : "Older, from the first tab.", what);
    await tab.press("#msg", "Enter");
    await until(async () => (await view(pending.id)).events.find((e) => e.id === qb.id).open === false);
    assert.equal((await view(pending.id)).events.find((e) => e.id === qb.id).answer, "Newer, from the second tab.");
    // Its reply has come back (its box is empty, the saved draft gone) before it closes.
    await tab.waitForFunction(() => document.querySelector("#msg").value === "");
    await tab.close();
    await until(async () => (await view(pending.id)).live.length === 0);
  }
  await page.unroute(`**/api/rooms/${pending.id}/messages`);

  // 5l. A queued note you're changing stays open, with your text and the focus, when a turn ends and the timeline
  // is drawn again: here a note to the reviewer while the builder works.
  const slowRoom = await post("api/rooms", { projectId: "ui", mode: "build", task: "Slow build of the parser", title: "Slow room", members: ["codex", "claude"], builder: "codex", reviewer: "claude" });
  await openRoom(slowRoom.id, "Slow room");
  await page.waitForSelector(".turn.live");
  await page.click("#recipients [data-route=claude]");
  await page.fill("#msg", "Please also check the docs.");
  await page.press("#msg", "Enter");
  const queuedId = await page.locator(".owner", { hasText: "Please also check the docs." }).last().getAttribute("data-id");
  const queued = page.locator(`.owner[data-id="${queuedId}"]`);
  await queued.locator("[data-note-edit]").click();
  await queued.locator("textarea.noteedit").fill("Changed while Codex builds");
  await page.evaluate((id) => document.querySelector(`.owner[data-id="${id}"] textarea.noteedit`).setSelectionRange(5, 5), queuedId);
  await page.waitForSelector(".turn.live", { state: "detached", timeout: 15_000 });
  await page.waitForFunction(() => /Ship it\?/.test(document.querySelector("#log").innerText));
  const editing = await page.evaluate(() => {
    const area = [...document.querySelectorAll(".owner textarea.noteedit")].at(-1);
    return { value: area?.value, focused: document.activeElement === area, cursor: area?.selectionStart };
  });
  // The text, the focus, and the cursor where it was, though the timeline was drawn more than once before a frame.
  assert.deepEqual(editing, { value: "Changed while Codex builds", focused: true, cursor: 5 });
  // Another room, a reload, and back: the editor is still open, with your change.
  await openRoom(asked.id, "Asking room");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "Asking room");
  await openRoom(slowRoom.id, "Slow room");
  assert.equal(await queued.locator("textarea.noteedit:not([readonly])").inputValue(), "Changed while Codex builds");
  assert.equal(await queued.locator("[data-unsaved]").count(), 0);
  await queued.locator("[data-note-save]").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".owner")].some((o) => /Changed while Codex builds/.test(o.innerText) && /edited/.test(o.querySelector(".to").innerText)));

  // 5m. The side panel's tabs: choose Crew as a room tab on a narrower screen, widen the window, then choose Plan.
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.click("[data-roomtab=crew]");
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.click("[data-sidetab=plan]");
  assert.deepEqual(await page.evaluate(() => [document.querySelector("#context").checkVisibility(), document.querySelector("#crewPane").checkVisibility()]), [true, false]);
  await page.click("[data-sidetab=crew]");

  // 5n. A note that goes to the crew while you're changing it: your change can't be saved, but it isn't lost. It
  // stays under the note, whole, across a reload, until you send it as a new note (or dismiss it).
  const longText = "Please also check the docs, the examples and the changelog, and say which of them still mention the old flag. ".repeat(3).trim();
  const lexer = await post("api/rooms", { projectId: "ui", mode: "build", task: "Slow review of the lexer", title: "Lexer room", members: ["codex", "claude"], builder: "codex", reviewer: "claude" });
  await openRoom(lexer.id, "Lexer room");
  await page.waitForSelector(".turn.live");
  await page.click("#recipients [data-route=claude]");
  await page.fill("#msg", "Check the docs.");
  await page.press("#msg", "Enter");
  const lexNote = await page.locator(".owner", { hasText: "Check the docs." }).last().getAttribute("data-id");
  await page.locator(`.owner[data-id="${lexNote}"] [data-note-edit]`).click();
  await page.locator(`.owner[data-id="${lexNote}"] textarea.noteedit`).fill(longText);
  // The builder hands off, and the reviewer starts with the note.
  await page.waitForSelector(`.owner[data-id="${lexNote}"] [data-unsaved]`, { timeout: 20_000 });
  assert.equal(await page.inputValue(`.owner[data-id="${lexNote}"] [data-unsaved] textarea`), longText);
  await page.reload();
  await page.waitForSelector(`.owner[data-id="${lexNote}"] [data-unsaved]`);
  assert.equal(await page.inputValue(`.owner[data-id="${lexNote}"] [data-unsaved] textarea`), longText);
  await page.click(`.owner[data-id="${lexNote}"] [data-unsaved-reuse]`);
  assert.equal(await page.inputValue("#msg"), longText);
  assert.equal(await page.getAttribute("#recipients [data-route=claude]", "aria-pressed"), "true");
  assert.equal(await page.locator("[data-unsaved]").count(), 0);
  await page.fill("#msg", "");

  // 5o. Saving a change while the note goes to the crew: the desk refuses it (delivery came first), and your change
  // stays under the note. Dismissed, it's gone for good.
  const docs = await post("api/rooms", { projectId: "ui", mode: "build", task: "Slow review of the docs", title: "Docs room", members: ["codex", "claude"], builder: "codex", reviewer: "claude" });
  await openRoom(docs.id, "Docs room");
  await page.waitForSelector(".turn.live");
  await page.click("#recipients [data-route=claude]");
  await page.fill("#msg", "Check the examples.");
  await page.press("#msg", "Enter");
  const docsNote = await page.locator(".owner", { hasText: "Check the examples." }).last().getAttribute("data-id");
  await page.locator(`.owner[data-id="${docsNote}"] [data-note-edit]`).click();
  await page.locator(`.owner[data-id="${docsNote}"] textarea.noteedit`).fill("Check the examples and the README.");
  // The save is slow to arrive: by then the reviewer has the note.
  await page.route(`**/api/rooms/${docs.id}/notes/*`, async (route) => {
    await until(async () => (await view(docs.id)).events.find((e) => e.id === docsNote)?.deliveredTo?.includes("claude"), "the note to reach the reviewer");
    await route.continue();
  });
  await clearToasts();
  const saveRefused = page.waitForResponse((res) => res.url().includes(`/api/rooms/${docs.id}/notes/`));
  await page.locator(`.owner[data-id="${docsNote}"] [data-note-save]`).click();
  // While the save is on its way you move to another room; the refusal arrives there; then you reload.
  await openRoom(lexer.id, "Lexer room");
  assert.equal((await saveRefused).status(), 409);
  await toastSays(/already gone to the crew/);
  dropRefusal();
  await page.unroute(`**/api/rooms/${docs.id}/notes/*`);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "Lexer room");
  await openRoom(docs.id, "Docs room");
  await page.waitForSelector(`.owner[data-id="${docsNote}"] [data-unsaved]`);
  assert.equal(await page.inputValue(`.owner[data-id="${docsNote}"] [data-unsaved] textarea`), "Check the examples and the README.");
  assert.equal((await view(docs.id)).events.find((e) => e.id === docsNote).text, "Check the examples.");
  await page.click(`.owner[data-id="${docsNote}"] [data-unsaved-dismiss]`);
  await page.reload();
  await page.waitForSelector(`.owner[data-id="${docsNote}"]`);
  assert.equal(await page.locator("[data-unsaved]").count(), 0);

  // 5p. A save that's slow to come back never drops a newer change: one typed on in this tab, or made in another tab.
  // The newer change stays in the editor, also after a reload. (The note to the reviewer in the slow room is queued.)
  await openRoom(slowRoom.id, "Slow room");
  let saveGate = Promise.resolve();
  let releaseSave = () => {};
  const holdSave = () => (saveGate = new Promise((r) => (releaseSave = r)));
  await page.route(`**/api/rooms/${slowRoom.id}/notes/*`, async (route) => {
    await saveGate;
    await route.continue();
  });
  const editorOf = (p) => p.locator(`.owner[data-id="${queuedId}"] textarea.noteedit:not([readonly])`);
  const noteText = async () => (await view(slowRoom.id)).events.find((e) => e.id === queuedId).text;
  await queued.locator("[data-note-edit]").click();
  await editorOf(page).fill("Version A");
  holdSave();
  let saved = page.waitForResponse((res) => res.url().includes(`/api/rooms/${slowRoom.id}/notes/`));
  await queued.locator("[data-note-save]").click();
  await editorOf(page).fill("Version A, and B");
  releaseSave();
  assert.equal((await saved).status(), 200);
  await until(async () => (await noteText()) === "Version A", "the desk to save version A");
  await page.waitForTimeout(300);
  assert.equal(await editorOf(page).inputValue(), "Version A, and B", "typed on while saving: kept");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "Slow room");
  assert.equal(await editorOf(page).inputValue(), "Version A, and B", "and after a reload");
  // Another tab changes it while this tab's save is on its way.
  await editorOf(page).fill("Version C");
  holdSave();
  saved = page.waitForResponse((res) => res.url().includes(`/api/rooms/${slowRoom.id}/notes/`));
  await queued.locator("[data-note-save]").click();
  const other2 = await page.context().newPage();
  other2.on("pageerror", (e) => errors.push(String(e)));
  await other2.goto(`${url}#/r/${slowRoom.id}`);
  await editorOf(other2).waitFor();
  assert.equal(await editorOf(other2).inputValue(), "Version C");
  await editorOf(other2).fill("Version D");
  releaseSave();
  assert.equal((await saved).status(), 200);
  await until(async () => (await noteText()) === "Version C", "the desk to save version C");
  await page.waitForFunction((id) => document.querySelector(`.owner[data-id="${id}"] textarea.noteedit:not([readonly])`)?.value === "Version D", queuedId);
  await other2.close();
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "Slow room");
  assert.equal(await editorOf(page).inputValue(), "Version D", "the other tab's change, after a reload");
  await page.unroute(`**/api/rooms/${slowRoom.id}/notes/*`);
  // Kept as it was: the change is dropped, and the note reads as last saved.
  await queued.locator("[data-note-keep]").click();
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "Slow room");
  assert.equal(await editorOf(page).count(), 0);
  assert.match(await queued.locator(".md").innerText(), /Version C/);

  // 5q. A ready plan. Its card asks Claude to check it, once however fast you click; your talk with Claude since goes
  // to Codex, the author, from Claude's reply; the room keeps Re-check after changes. On a phone, the card's buttons
  // fill its width and are tall enough to tap.
  const exports = await post("api/rooms", { projectId: "ui", mode: "plan", topic: "Exports", members: ["codex", "claude"], title: "Ready plan", planPath: "docs/plans/ui.md" });
  await openRoom(exports.id, "Ready plan");
  await page.waitForSelector("[data-checkpoint] [data-accept-checkpoint]");
  await page.selectOption("#cqWho", "codex");
  await page.click("[data-accept-checkpoint]");
  const checkBtn = page.locator(".decision [data-plan-check]");
  await checkBtn.waitFor();
  assert.equal((await checkBtn.innerText()).trim(), "Ask Claude to check it");
  const firstCard = (await questions(exports.id)).find((q) => q.kind === "plan-ready");
  assert.match(firstCard.question, /Claude checked it and approved\./);
  const sentChecks = [];
  const onCheck = (r) => /"action":"plan-check"/.test(r.postData() ?? "") && sentChecks.push(r);
  page.on("request", onCheck);
  await checkBtn.dblclick();
  await until(async () => (await questions(exports.id)).some((q) => q.kind === "plan-ready" && q.id !== firstCard.id), "the plan ready again after the check");
  page.off("request", onCheck);
  assert.equal(sentChecks.length, 1, "a double click asks once");
  const calls = () => readFileSync(join(base, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls().filter((c) => /step 4 of 4/.test(c.prompt)).length, 2, "the first check and the one you asked for");
  // Your talk with Claude about the ready plan, sent to Codex from Claude's reply.
  const talk = (await post(`api/rooms/${exports.id}/messages`, { text: "Anything missing?", to: "claude", answering: false })).event;
  const fwd = page.locator(".turn [data-forward]");
  // Drawn as the reply arrives, even before the page's copy of the room knows who wrote the plan: the card says.
  await fwd.waitFor({ timeout: 10_000 });
  assert.equal(await fwd.count(), 1, "on Claude's latest reply only");
  assert.equal((await fwd.innerText()).trim(), "Send this discussion to Codex as a change request");
  // Your note shows it was answered (it grows a line, and the timeline moves): click once that's settled.
  await page.waitForSelector(`.owner[data-id="${talk.id}"] .outcome`);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const forwards = [];
  const onForward = (r) => /"action":"forward-discussion"/.test(r.postData() ?? "") && forwards.push(r);
  page.on("request", onForward);
  await fwd.click();
  await page.waitForFunction(() => [...document.querySelectorAll(".owner .to")].some((x) => /^Change request · You → Codex/.test(x.textContent)));
  page.off("request", onForward);
  assert.equal(forwards.length, 1);
  await page.waitForFunction(() => !document.querySelector(".turn [data-forward]"), null, { timeout: 5000 });
  await until(async () => (await questions(exports.id)).some((q) => q.kind === "plan-ready" && /Claude checked it and approved/.test(q.question)) && calls().some((c) => /Check the revised plan/.test(c.prompt)), "the forwarded change revised and checked");
  const request = (await view(exports.id)).events.find((e) => e.kind === "change-request");
  assert.deepEqual(request.forwarded.map((x) => x.from), ["owner", "claude"]);
  // The setting, on by default; turned off, the plan panel says so.
  await page.click("#roomBtn");
  const recheck = page.locator('#roomForm input[name="recheckAfterChanges"]');
  assert.equal(await recheck.isChecked(), true);
  await recheck.uncheck();
  await page.click('#roomForm button[type="submit"]');
  await until(async () => (await view(exports.id)).room.settings.recheckAfterChanges === false, "the setting saved");
  await page.waitForFunction(() => /After your changes: no check \(Re-check after changes is off\)/.test(document.querySelector(".side")?.innerText ?? ""));
  // On a phone: the Ready card's buttons, and the one under Claude's reply, fit and are tall enough to tap.
  await post(`api/rooms/${exports.id}/messages`, { text: "Anything missing now?", to: "claude", answering: false });
  await fwd.waitFor({ timeout: 10_000 });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(200);
    const phone = await page.evaluate(() => {
      const measure = (card, sel) => {
        card.scrollIntoView();
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll(sel)].map((b) => {
          const r = b.getBoundingClientRect();
          return { text: b.innerText.trim(), height: r.height, inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 };
        });
      };
      const card = [...document.querySelectorAll(".decision")].find((d) => d.querySelector("[data-plan-check]"));
      return { wide: document.documentElement.scrollWidth, buttons: [...measure(card, ".actions .btn"), ...measure(document.querySelector("[data-forward]").closest(".turn"), "[data-forward]")] };
    });
    assert.ok(phone.wide <= width, `${width}px: nothing scrolls sideways (${phone.wide}px)`);
    assert.equal(phone.buttons.length, 5);
    for (const b of phone.buttons) {
      assert.ok(b.inside, `${width}px, ${b.text}: inside its card`);
      assert.ok(b.height >= 44, `${width}px, ${b.text}: tall enough to tap (${b.height}px)`);
    }
  }
  await page.setViewportSize({ width: 1400, height: 900 });

  // 5r. A room fetched again while a question is answered elsewhere: the fetch, sent before the answer and back after
  // everything since, doesn't bring the answered question back (a note would otherwise be tied to it, and refused).
  const lateRoom = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], text: "Ask me.", to: "codex", title: "Late refresh" });
  await until(async () => (await questions(lateRoom.id)).length === 1 && (await view(lateRoom.id)).live.length === 0);
  const [lateQ] = await questions(lateRoom.id);
  await openRoom(lateRoom.id, "Late refresh");
  let fetchedLate;
  const snapshot = new Promise((r) => (fetchedLate = r));
  let letGo;
  const lateHeld = new Promise((r) => (letGo = r));
  let firstFetch = true;
  await page.route(`**/api/rooms/${lateRoom.id}`, async (route) => {
    if (!firstFetch || route.request().method() !== "GET") return route.continue();
    firstFetch = false;
    // The desk's answer as it was now, handed to the page only later.
    const res = await route.fetch();
    fetchedLate();
    await lateHeld;
    await route.fulfill({ response: res });
  });
  // Any change to the room makes the page fetch it again; here, a new name.
  await post(`api/rooms/${lateRoom.id}/control`, { action: "rename", title: "Late refresh room" });
  await snapshot;
  await post(`api/rooms/${lateRoom.id}/answer`, { questionId: lateQ.id, text: "From the phone." });
  await page.waitForSelector(`.decision.closed[data-id="${lateQ.id}"]`);
  // Codex replies (with another question), the page fetches the room again meanwhile, and then all is quiet: the
  // held answer, older than all that, arrives last.
  await until(async () => (await view(lateRoom.id)).live.length === 0 && (await questions(lateRoom.id)).some((q) => q.id !== lateQ.id), "Codex's next question");
  await page.waitForTimeout(600);
  letGo();
  await page.waitForTimeout(800);
  assert.ok(await page.$(`.decision.closed[data-id="${lateQ.id}"]`), "the answered question stays answered");
  await page.unroute(`**/api/rooms/${lateRoom.id}`);

  // 5s. Home. The address decides (#/ is Home, #/r/<id> a room), and Back returns. Its questions come oldest first,
  // each opening its room at that question, by mouse or keyboard. A hostile room title is only text. A turn's times
  // are kept apart (preparing, then working, with its latest output). News in bursts costs a few fetches of the
  // overview, not one per event. Cut off from the desk, it says so.
  await page.click("a.brand");
  await page.waitForFunction(() => location.hash === "#/" && !document.querySelector("#home").hidden && document.querySelector("#main").hidden);
  assert.equal(await page.getAttribute(".roomlink.railhome", "aria-current"), "page");
  const hostile = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], title: '<img src=x onerror="window.__xss=1">', text: "Ask me.", to: "codex" });
  await until(async () => (await questions(hostile.id)).length === 1 && (await view(hostile.id)).live.length === 0);
  const homeData = async () => (await fetch(`${url}api/home`)).json();
  await page.waitForFunction((id) => document.querySelector(`#home .ask a[href="#/r/${id}"]`), hostile.id);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.$$eval("#home img", (imgs) => imgs.length), 0);
  assert.ok((await page.innerText("#home")).includes('<img src=x onerror="window.__xss=1">'), "the title, as text");
  // Oldest first, as the desk has them.
  const shown = await page.$$eval("#home .ask", (cards) => cards.map((c) => c.dataset.q));
  assert.deepEqual(shown, (await homeData()).questions.map((q) => q.id));
  // Open one from Home: its room, at that question. Back: Home again.
  const [hostileQ] = await questions(hostile.id);
  await page.click(`#home .ask[data-q="${hostileQ.id}"] [data-open-question]`);
  await page.waitForFunction((id) => location.hash === `#/r/${id}` && !document.querySelector("#main").hidden, hostile.id);
  await page.waitForFunction((qid) => {
    const card = document.querySelector(`#log [data-id="${qid}"]`)?.getBoundingClientRect();
    const log = document.querySelector("#log").getBoundingClientRect();
    return card && card.top >= log.top - 1 && card.bottom <= log.bottom + 1;
  }, hostileQ.id);
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#/" && !document.querySelector("#home").hidden);
  // By keyboard: the link takes the focus, keeps it while Home is drawn again with news, and Enter opens it.
  await page.focus(`#home .ask[data-q="${hostileQ.id}"] [data-open-question]`);
  const redrawn = page.waitForResponse((r) => r.url().includes("/api/home"));
  await post(`api/rooms/${hostile.id}/messages`, { text: "News while you're focused.", to: "codex", answering: false });
  await redrawn;
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.openQuestion), hostileQ.id, "the focus stays on the link");
  await page.keyboard.press("Enter");
  await page.waitForFunction((id) => location.hash === `#/r/${id}`, hostile.id);
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector("#home").hidden);
  // A turn's times: preparing first (it takes a while to start), then working, with what it runs.
  const phased = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], title: "Phases room", text: "Phases for Home.", to: "codex" });
  const card = `#home .workcard[href="#/r/${phased.id}"]`;
  await page.waitForFunction((sel) => /preparing for \d+:\d\d/.test(document.querySelector(sel)?.innerText ?? ""), card);
  // Its latest output arrives live; the overview that follows says it's working.
  await page.waitForFunction((sel) => /npm run build/.test(document.querySelector(sel)?.innerText ?? ""), card, { timeout: 15_000 });
  await page.waitForFunction((sel) => /working · last output/.test(document.querySelector(sel)?.innerText ?? ""), card);
  const working = await page.innerText(card);
  assert.match(working, /prepared in \d+s/);
  assert.match(working, /working · last output \d+s ago/);
  // Its activity line is part of the card's link: clicking it opens the room, and posts nothing to the desk.
  const deskPosts = [];
  const onDeskPost = (r) => r.method() === "POST" && r.url().includes("/api/desk") && deskPosts.push(r.url());
  page.on("request", onDeskPost);
  await page.click(`${card} .wc-act`);
  await page.waitForFunction((id) => location.hash === `#/r/${id}`, phased.id);
  page.off("request", onDeskPost);
  assert.deepEqual(deskPosts, []);
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector("#home").hidden);
  // A burst of news (eight notes in a row): a few fetches of the overview, and no room fetched whole.
  const fetched = [];
  const onRequest = (r) => /\/api\/(home|rooms\/[\w-]+)(\?|$)/.test(r.url()) && r.method() === "GET" && fetched.push(new URL(r.url()).pathname);
  page.on("request", onRequest);
  for (let i = 0; i < 8; i++) await post(`api/rooms/${hostile.id}/messages`, { text: `Burst ${i}.`, to: "codex", answering: false });
  await page.waitForTimeout(2500);
  page.off("request", onRequest);
  const homeFetches = fetched.filter((p) => p === "/api/home").length;
  assert.ok(homeFetches >= 1 && homeFetches <= 6, `fetches of the overview: ${homeFetches}`);
  assert.deepEqual(fetched.filter((p) => p !== "/api/home"), [], "no room fetched whole");
  // Unseen while Home shows: what came in a room you're not looking at stays unread, so going back says so.
  const away = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], title: "Away room", text: "Ask me.", to: "codex" });
  await until(async () => (await view(away.id)).live.length === 0 && (await questions(away.id)).length === 1);
  await openRoom(away.id, "Away room");
  await page.waitForTimeout(1800);
  await page.click("a.brand");
  await page.waitForFunction(() => !document.querySelector("#home").hidden);
  const doneTurns = async (id) => (await view(id)).events.filter((e) => e.type === "turn" && e.state === "done").length;
  for (const text of ["One more.", "And another."]) {
    const n = await doneTurns(away.id);
    await post(`api/rooms/${away.id}/messages`, { text, to: "codex", answering: false });
    await until(async () => (await doneTurns(away.id)) > n && (await view(away.id)).live.length === 0);
  }
  await page.waitForTimeout(1800);
  await openRoom(away.id, "Away room");
  await page.waitForSelector(".away");
  assert.match(await page.innerText(".away"), /While you were away: 2 turns/);
  await page.click("a.brand");
  await page.waitForFunction(() => !document.querySelector("#home").hidden);

  // Cut off (this check's desk stops): Home says so. Back (it starts again): the note goes, and Home fetches a fresh
  // overview, which shows what changed meanwhile (the rooms whose turns were cut off are paused). The room behind
  // Home isn't fetched: going back to it does that.
  await until(async () => (await view(phased.id)).live.length === 0);
  const errorsBefore = errors.length;
  desk.kill("SIGTERM");
  await new Promise((r) => desk.once("exit", r));
  await page.waitForSelector("#home .offline", { timeout: 15_000 });
  assert.match(await page.innerText("#home .offline"), /Reconnecting to the desk… What you see here may be out of date\./);
  const onReconnect = [];
  const record = (r) => r.method() === "GET" && /\/api\/(home|rooms\/[\w-]+)(\?|$)/.test(r.url()) && onReconnect.push(new URL(r.url()).pathname);
  page.on("request", record);
  await startDesk();
  await page.waitForSelector("#home .offline", { state: "detached", timeout: 20_000 });
  await page.waitForFunction(() => /Paused/.test(document.querySelector("#home")?.innerText ?? ""));
  await page.waitForTimeout(1000);
  page.off("request", record);
  assert.ok(onReconnect.includes("/api/home"), "a fresh overview");
  assert.deepEqual(onReconnect.filter((p) => p !== "/api/home"), [], "no room fetched behind Home");
  // While it was down, the browser's attempts to reconnect failed, as they should.
  errors.splice(errorsBefore).forEach((e) => assert.match(e, /ERR_CONNECTION_REFUSED|Failed to load resource|EventSource/));

  // A new desk with no project yet: the welcome page. Adding the first project opens Home, without a reload.
  // (Another desk of this check's own, with its own folder and port.)
  const home2 = join(base, "home2");
  mkdirSync(home2, { recursive: true });
  writeFileSync(join(home2, "config.json"), JSON.stringify({ version: 1, notify: { windows: false }, agents: { codex: { command: [node, FAKE, "codex"] }, claude: { command: [node, FAKE, "claude"] }, codexapp: { exe, codexHome, openThread: "never" } }, projects: [] }));
  const port2 = await new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const p2 = srv.address().port;
      srv.close(() => resolve(p2));
    });
  });
  const desk2 = spawn(node, [join(root, "bin", "toryo.mjs"), "--port", String(port2)], { env: { ...process.env, TORYO_HOME: home2, TORYO_WEB_DIR: web, FAKE_SCRIPT: join(base, "script.json"), CODEX_HOME: join(base, "codex") }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((resolve) => desk2.stdout.on("data", (d) => /Toryo is running/.test(d) && resolve()));
    const fresh = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    fresh.on("pageerror", (e) => errors.push(String(e)));
    await fresh.goto(`http://localhost:${port2}/`);
    await fresh.waitForSelector("#welcomeForm");
    await fresh.fill("#wPath", repo);
    await fresh.click("#welcomeForm button[type=submit]");
    await fresh.waitForFunction(() => !document.querySelector("#home").hidden && document.querySelector(".home .hero") && document.querySelector("#main").hidden);
    assert.match(await fresh.innerText(".home .hero"), /All quiet/);
    await fresh.close();
  } finally {
    desk2.kill("SIGTERM");
    await new Promise((r) => desk2.once("exit", r));
  }

  // 5t. Home's buttons, with the same actions and question ids as the terminal and MCP.
  const deskNow = async () => (await fetch(`${url}api/desk`)).json();
  const askingRoom = async (title) => {
    const r = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], title, text: "Ask me.", to: "codex" });
    await until(async () => (await questions(r.id)).length === 1 && (await view(r.id)).live.length === 0);
    const [q] = await questions(r.id);
    await page.waitForSelector(`#home .ask[data-q="${q.id}"]`);
    return { room: r, q, card: `#home .ask[data-q="${q.id}"]` };
  };
  await page.click("a.brand");
  await page.waitForFunction(() => !document.querySelector("#home").hidden);
  // The guard's note, until it's read: OK, and it doesn't come back after a reload.
  await page.waitForSelector("#home .notice");
  await page.click('#home .notice [data-do="guard-ok"]');
  await page.waitForSelector("#home .notice", { state: "detached" });
  // Holding Codex: both interfaces, then each alone. Answering while Codex is held: saved, and Home says who gets it
  // and when.
  const heldAsk = await askingRoom("Held answer");
  await page.click('#home .allow[data-group="openai"] > header [data-act="desk"]');
  await until(async () => (await deskNow()).holds.some((h) => h.key === "codex"));
  await page.waitForFunction(() => /Release both/.test(document.querySelector('#home .allow[data-group="openai"] > header')?.innerText ?? ""));
  await page.click(`${heldAsk.card} [data-act="accept"]`);
  await toastSays(/Codex gets it when this ends: you hold Codex/);
  await until(async () => (await view(heldAsk.room.id)).events.find((e) => e.id === heldAsk.q.id).open === false);
  assert.equal((await view(heldAsk.room.id)).live.length, 0, "Codex is held: its reply waits");
  await page.click('#home .allow[data-group="openai"] > header [data-act="desk"]');
  await until(async () => !(await deskNow()).holds.length);
  for (const [agent, key] of [["codex", "codex:headless"], ["codexapp", "codexapp"]]) {
    const row = `#home .allow[data-group="openai"] .agentrow:has(.avatar[data-agent="${agent}"]) [data-act="desk"]`;
    await page.click(row);
    await until(async () => (await deskNow()).holds.map((h) => h.key).join() === key);
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Release", row);
    await page.click(row);
    await until(async () => !(await deskNow()).holds.length);
  }
  // A planning checkpoint: every recommendation as shown, with the author named; the full form stays in the room.
  const homePlan = await post("api/rooms", { projectId: "ui", mode: "plan", topic: "Home plan", members: ["codex", "claude"], title: "Home plan" });
  await until(async () => (await questions(homePlan.id)).some((q) => q.kind === "plan-checkpoint"));
  const [cp] = await questions(homePlan.id);
  const cpCard = `#home .ask[data-q="${cp.id}"]`;
  await page.waitForSelector(`${cpCard} [data-act="accept-checkpoint"]`);
  assert.match(await page.innerText(cpCard), /Use SQLite\? \(Codex\): yes[\s\S]*Ship a CLI too\? \(Claude\): no[\s\S]*Accept all recommendations: Codex writes the plan[\s\S]*Open the form/);
  // With its author held: accepted, and Home says Codex writes it when the hold ends.
  await post("api/desk", { action: "hold", target: "codex" });
  await clearToasts();
  await page.click(`${cpCard} [data-act="accept-checkpoint"]`);
  await toastSays(/Your call is in[\s\S]*Codex gets it when this ends: you hold Codex/);
  await until(async () => (await view(homePlan.id)).room.plan.synthesizer === "codex");
  assert.match((await view(homePlan.id)).events.find((e) => e.kind === "decisions").text, /Use SQLite\? → yes \(Codex's recommendation\)/);
  await post("api/desk", { action: "release", target: "codex" });
  // The plan written: asking Claude to check it while Claude alone is held says Claude, not the plan's author.
  await until(async () => (await questions(homePlan.id)).some((q) => q.kind === "plan-ready"));
  const readyQ = (await questions(homePlan.id)).find((q) => q.kind === "plan-ready");
  await post("api/desk", { action: "hold", target: "claude" });
  await page.waitForSelector(`#home .ask[data-q="${readyQ.id}"] [data-act="plan-check"]`);
  await clearToasts();
  await page.click(`#home .ask[data-q="${readyQ.id}"] [data-act="plan-check"]`);
  await toastSays(/The check is asked for[\s\S]*Claude gets it when this ends: you hold Claude/);
  assert.doesNotMatch(await page.innerText("#toasts"), /Codex gets it/);
  await post("api/desk", { action: "release", target: "claude" });
  // A card answered elsewhere while you write in it: it says so, keeps your text, sends nothing; Dismiss lets it go.
  const staleAsk = await askingRoom("Stale room");
  await page.click(`${staleAsk.card} [data-act="write"]`);
  await page.keyboard.type("My draft answer");
  await post(`api/rooms/${staleAsk.room.id}/answer`, { questionId: staleAsk.q.id, text: "From the phone." });
  // Still typing (the focus never left): the card says it's closed, with Dismiss, and keeps your text and focus.
  await page.waitForSelector(`${staleAsk.card}[data-stale="true"] .stalenote`);
  assert.deepEqual(await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.value]), ["TEXTAREA", "My draft answer"]);
  assert.equal(await page.$(`${staleAsk.card} [data-act="send"]`), null, "nothing to send it to");
  assert.ok(await page.$(`${staleAsk.card} [data-act="dismiss"]`));
  // Ctrl+Enter sends nothing from a closed card.
  const staleSends = [];
  const onStaleSend = (r) => r.method() === "POST" && r.url().includes(`/api/rooms/${staleAsk.room.id}/`) && staleSends.push(r.url());
  page.on("request", onStaleSend);
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(300);
  page.off("request", onStaleSend);
  assert.deepEqual(staleSends, []);
  // Once you leave it, Home draws it again: still closed, still with your text.
  await page.click("#home h1");
  await post(`api/rooms/${heldAsk.room.id}/messages`, { text: "More news.", to: "codex", answering: false });
  await page.waitForTimeout(800);
  assert.ok(await page.$(`${staleAsk.card}[data-stale="true"] .stalenote`));
  assert.equal(await page.inputValue(`${staleAsk.card} textarea`), "My draft answer");
  await page.click(`${staleAsk.card} [data-act="dismiss"]`);
  await page.waitForSelector(staleAsk.card, { state: "detached" });
  // 2. Drafts for questions that closed before a reload, and while the page was closed: back as closed cards.
  const before = await askingRoom("Closed before reload");
  await page.click(`${before.card} [data-act="write"]`);
  await page.keyboard.type("Written before the reload");
  await page.click("#home h1");
  await post(`api/rooms/${before.room.id}/answer`, { questionId: before.q.id, text: "From the phone." });
  await page.reload();
  await page.waitForSelector(`${before.card}[data-stale="true"] .stalenote`);
  assert.equal(await page.inputValue(`${before.card} textarea`), "Written before the reload");
  assert.match(await page.innerText(before.card), /Closed before reload[\s\S]*SQLite or Postgres\?/);
  const awayDraft = await askingRoom("Closed while away");
  await page.click(`${awayDraft.card} [data-act="write"]`);
  await page.keyboard.type("Written before closing the page");
  await page.goto("about:blank");
  await post(`api/rooms/${awayDraft.room.id}/answer`, { questionId: awayDraft.q.id, text: "From the phone." });
  await page.goto(url);
  await page.waitForSelector(`${awayDraft.card}[data-stale="true"] .stalenote`);
  assert.equal(await page.inputValue(`${awayDraft.card} textarea`), "Written before closing the page");
  for (const c of [before.card, awayDraft.card]) await page.click(`${c} [data-act="dismiss"]`);
  // 1. While an answer is on its way: the card is locked (what's sent is what you see), and a second send does nothing.
  const slowAsk = await askingRoom("Slow send");
  let letSendGo;
  const sendGate = new Promise((r) => (letSendGo = r));
  const slowSends = [];
  await page.route(`**/api/rooms/${slowAsk.room.id}/answer`, async (route) => {
    slowSends.push(route.request().postData());
    await sendGate;
    await route.continue();
  });
  await page.click(`${slowAsk.card} [data-act="write"]`);
  await page.keyboard.type("Exactly this");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(`${slowAsk.card}[aria-busy="true"]`);
  await page.keyboard.type(" and more");
  await page.keyboard.press("Control+Enter");
  assert.equal(await page.inputValue(`${slowAsk.card} textarea`), "Exactly this", "nothing typed while it's sent");
  assert.ok(await page.$eval(`${slowAsk.card} [data-act="send"]`, (b) => b.disabled));
  letSendGo();
  await until(async () => (await view(slowAsk.room.id)).events.find((e) => e.id === slowAsk.q.id).answer === "Exactly this");
  assert.equal(slowSends.length, 1, "sent once");
  await page.unroute(`**/api/rooms/${slowAsk.room.id}/answer`);
  await page.waitForSelector(slowAsk.card, { state: "detached" });
  assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem("toryo.homeDrafts") ?? "{}")[id], slowAsk.q.id), undefined);
  // A send that fails keeps your text, with the focus back in it; sent again, by keyboard, it goes.
  const failingAsk = await askingRoom("Fail room");
  await page.route(`**/api/rooms/${failingAsk.room.id}/answer`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The desk had a problem." }) }));
  await page.click(`${failingAsk.card} [data-act="write"]`);
  await page.keyboard.type("Postgres, please.");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(`${failingAsk.card} .err`);
  assert.match(await page.innerText(`${failingAsk.card} .err`), /That didn't work: The desk had a problem\. Your text is kept\./);
  assert.equal(await page.inputValue(`${failingAsk.card} textarea`), "Postgres, please.");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
  errors.splice(errors.findIndex((e) => /status of 500/.test(e)), 1);
  await page.unroute(`**/api/rooms/${failingAsk.room.id}/answer`);
  await page.keyboard.press("Control+Enter");
  await until(async () => (await view(failingAsk.room.id)).events.find((e) => e.id === failingAsk.q.id).answer === "Postgres, please.");
  // Typing while news comes in: the card isn't drawn again (text, cursor and focus stay); a reload brings it back.
  const typingAsk = await askingRoom("Typing room");
  await page.click(`${typingAsk.card} [data-act="write"]`);
  await page.keyboard.type("Half an answ");
  const fetchedHome = page.waitForResponse((r) => r.url().includes("/api/home"));
  await post(`api/rooms/${heldAsk.room.id}/messages`, { text: "Some news.", to: "codex", answering: false });
  await fetchedHome;
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => ({ tag: document.activeElement?.tagName, value: document.activeElement?.value, at: document.activeElement?.selectionStart })), { tag: "TEXTAREA", value: "Half an answ", at: 12 });
  await page.keyboard.type("er");
  await page.reload();
  await page.waitForSelector(`${typingAsk.card} .write:not([hidden]) textarea`);
  assert.equal(await page.inputValue(`${typingAsk.card} textarea`), "Half an answer");
  assert.equal(await page.$("#home .notice"), null, "the guard's note, once read, stays read");
  await page.click(`${typingAsk.card} [data-act="cancel-write"]`);
  // The guard holds Codex for both windows; your own hold on top. Release says what's left, with a button for each.
  const usedUp = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], title: "Used up", text: "Use it all up.", to: "codex" });
  await until(async () => (await deskNow()).guard.holds.filter((h) => h.group === "openai").length === 2);
  await page.click('#home .allow[data-group="openai"] > header [data-act="desk"]');
  await until(async () => (await deskNow()).holds.some((h) => h.key === "codex"));
  await page.waitForSelector('#home .deskbar [data-do="release"]');
  await page.click('#home .deskbar [data-do="release"]');
  await page.waitForSelector("#home .deskresult li");
  assert.match(await page.innerText("#home .deskresult"), /^Released Codex \(headless and the Codex app\)\./);
  assert.equal(await page.$$eval('#home .deskresult [data-do="guard-pause"]', (b) => b.length), 2, "one for each window still held");
  await page.click('#home .deskresult [data-do="guard-pause"][data-window="weekly"]');
  await until(async () => (await deskNow()).guard.exceptions.some((x) => x.key === "openai:weekly"));
  await page.waitForFunction(() => /lets Codex run until its weekly limit resets/.test(document.querySelector("#home .deskresult")?.innerText ?? ""));
  await page.click('#home .deskbar [data-do="guard-pause"][data-window="five-hour"]');
  await until(async () => (await deskNow()).guard.exceptions.length === 2);
  // No reset time known: Home says so, and offers turning that rule off instead.
  const unknown = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["claude"], title: "Unknown reset", text: "Unknown reset.", to: "claude" });
  await until(async () => (await deskNow()).guard.holds.some((h) => h.group === "anthropic"));
  await page.waitForFunction(() => /Its reset time isn't known/.test(document.querySelector("#home .deskbar")?.innerText ?? ""));
  await page.click('#home .deskbar [data-do="rule-off"]');
  await until(async () => !(await deskNow()).guard.holds.some((h) => h.group === "anthropic"));
  // The guard's settings: what you turned off stays off, after a reload too; a change you make is saved.
  await page.click('#home [data-act="guard-sheet"]');
  await page.waitForSelector("#guardForm");
  assert.equal(await page.isChecked('#guardForm fieldset[data-group="anthropic"] input[name=on][data-type="five_hour"]'), false);
  await page.fill('#guardForm fieldset[data-group="openai"] input[name=at][data-type="weekly"]', "99");
  await page.click('#guardForm button[type="submit"]');
  await until(async () => (await deskNow()).guard.policies.find((p) => p.group === "openai").rules.find((r) => r.type === "weekly").at === 99);
  await page.reload();
  await page.waitForSelector('#home [data-act="guard-sheet"]');
  await page.click('#home [data-act="guard-sheet"]');
  await page.waitForSelector("#guardForm");
  assert.equal(await page.isChecked('#guardForm fieldset[data-group="anthropic"] input[name=on][data-type="five_hour"]'), false);
  assert.equal(await page.inputValue('#guardForm fieldset[data-group="openai"] input[name=at][data-type="weekly"]'), "99");
  await page.click("#guardForm [data-close]");
  await until(async () => (await view(usedUp.id)).live.length === 0 && (await view(unknown.id)).live.length === 0);

  // 5u. The session's strip at the top of a room: a lane per phase, the running work growing, each piece a link to
  // its turn, and the totals in words, which open the whole list, also by keyboard.
  const stripRoom = await post("api/rooms", { projectId: "ui", mode: "chat", members: ["codex"], title: "Strip room", text: "Strip turn.", to: "codex" });
  await openRoom(stripRoom.id, "Strip room");
  await page.waitForSelector('#sessionStrip:not([hidden]) .ss-lane[data-lane="other"] .ss-seg');
  const stripSeg = '#sessionStrip .ss-lane[data-lane="other"] .ss-seg';
  assert.match(await page.getAttribute(stripSeg, "title"), /^Codex, reply: \d\d:\d\d–now \(\d+ s\)$/);
  const segWidth = await page.$eval(stripSeg, (a) => a.getBoundingClientRect().width);
  await until(async () => (await view(stripRoom.id)).live.length === 0);
  await page.waitForFunction((sel) => !/now/.test(document.querySelector(sel)?.title ?? "now"), stripSeg);
  assert.ok((await page.$eval(stripSeg, (a) => a.getBoundingClientRect().width)) > segWidth, "it grew while it ran");
  assert.match(await page.innerText("#sessionStrip .ss-words"), /^Other work \d+ s · \d+ s in all$/);
  const stripTurn = (await view(stripRoom.id)).events.find((e) => e.type === "turn");
  // A piece of the strip: its turn, in view.
  await page.evaluate(() => (document.querySelector("#log").scrollTop = 0));
  await page.click(stripSeg);
  await page.waitForFunction((id) => {
    const c = document.querySelector(`#log [data-id="${id}"]`)?.getBoundingClientRect();
    const l = document.querySelector("#log").getBoundingClientRect();
    return c && c.top >= l.top - 1 && c.bottom <= l.bottom + 1;
  }, stripTurn.id);
  // By keyboard: the words open the list; each piece in it goes to its turn. News in the room (a pause, then a
  // resume) redraws the strip without taking the focus from the words.
  await page.focus("#sessionStrip .ss-words");
  await post(`api/rooms/${stripRoom.id}/control`, { action: "pause" });
  await until(async () => (await view(stripRoom.id)).room.paused);
  await post(`api/rooms/${stripRoom.id}/control`, { action: "resume" });
  await page.waitForSelector('#sessionStrip .ss-shade[data-k="paused"]');
  assert.ok(await page.evaluate(() => document.activeElement?.matches("#sessionStrip .ss-words")), "the words keep the focus");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#sheet:not([hidden]) .ss-list a[data-seg]");
  assert.match(await page.innerText("#sheet"), /This session, \d+ s: other work \d+ s(, paused or held \d+ s)?\.[\s\S]*Other work[\s\S]*Codex, reply/);
  await page.focus("#sheet .ss-list a[data-seg]");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#sheet", { state: "hidden" });
  assert.match(await page.evaluate(() => document.activeElement?.tagName ?? ""), /BODY|A|BUTTON|DIV|ARTICLE/);

  // 5v. Checks on the strip: watched as they start (their first news is their output, which doesn't say what they
  // are), and in a room opened while they run. Once done, each page has them once, no longer running.
  const projectGates = (gates) => fetch(`${url}api/projects/ui`, { method: "PATCH", headers: { "content-type": "application/json", "x-toryo": "1" }, body: JSON.stringify({ gates }) });
  await projectGates([{ name: "Slow check", command: "sleep 4", timeoutMin: 45 }]);
  const checksRoom = await post("api/rooms", { projectId: "ui", mode: "build", task: "Strip checks", title: "Checks strip", members: ["codex", "claude"], builder: "codex", reviewer: "claude" });
  await openRoom(checksRoom.id, "Checks strip");
  const checksSeg = '#sessionStrip .ss-lane[data-lane="checks"] .ss-seg';
  const runningChecks = (sel) => [...document.querySelectorAll(sel)].some((x) => /^The checks: .*–now/.test(x.title));
  await page.waitForFunction(runningChecks, checksSeg);
  const during = await page.context().newPage();
  during.on("pageerror", (e) => errors.push(String(e)));
  await during.goto(`${url}#/r/${checksRoom.id}`);
  await during.waitForFunction(runningChecks, checksSeg);
  await until(async () => (await view(checksRoom.id)).events.some((e) => e.type === "gate"));
  for (const p of [page, during])
    await p.waitForFunction((sel) => {
      const pieces = [...document.querySelectorAll(sel)];
      return pieces.length === 1 && /^The checks: \d\d:\d\d–\d\d:\d\d \(\d s\)$/.test(pieces[0].title);
    }, checksSeg);
  await during.close();
  await post(`api/rooms/${checksRoom.id}/control`, { action: "stop" });
  await projectGates([{ name: "Slow check", command: "true", timeoutMin: 45 }]);

  // 5w. A room with thousands of events: a refresh takes in only what changed and draws the strip once, so the
  // page doesn't stall. (A desk of its own, the room written straight into its folder.)
  const home3 = join(base, "home3");
  const longId = "rlongroom0001";
  mkdirSync(join(home3, "rooms", longId), { recursive: true });
  writeFileSync(join(home3, "config.json"), JSON.stringify({ version: 1, notify: { windows: false }, agents: { codex: { command: [node, FAKE, "codex"] } }, projects: [{ id: "ui", name: "ui", path: repo, rules: "", decisions: "", agents: {}, gates: [] }] }));
  const longStart = Date.now() - 3 * 86_400_000;
  const stamp = (m) => new Date(longStart + m * 60_000).toISOString();
  writeFileSync(
    join(home3, "rooms", longId, "room.json"),
    JSON.stringify({ id: longId, projectId: "ui", title: "Long room", mode: "chat", createdAt: stamp(0), updatedAt: stamp(3000), crew: { members: ["codex"], builder: "codex", reviewer: "codex" }, sessions: {}, seen: {}, queue: [], flow: "flong", paused: false, stopped: false, done: false, waiting: null, waitingQueue: [], settings: { ...DEFAULT_SETTINGS }, build: null, plan: null, discuss: null, stats: { turns: 0, agents: {} } }),
  );
  const longEvents = [];
  for (let i = 0; i < 1500; i++) {
    longEvents.push({ id: `t${i}`, type: "turn", agent: "codex", role: "builder", kind: ["build", "review", "plan-proposal"][i % 3], state: "done", at: stamp(2 * i), startedAt: stamp(2 * i), endedAt: stamp(2 * i + 1), text: `Turn ${i}.` });
    longEvents.push({ id: `s${i}`, type: "system", text: `Note ${i}.`, level: "info", at: stamp(2 * i + 1) });
  }
  writeFileSync(join(home3, "rooms", longId, "events.jsonl"), longEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const port3 = await new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const p3 = srv.address().port;
      srv.close(() => resolve(p3));
    });
  });
  const desk3 = spawn(node, [join(root, "bin", "toryo.mjs"), "--port", String(port3)], { env: { ...process.env, TORYO_HOME: home3, TORYO_WEB_DIR: web, FAKE_SCRIPT: join(base, "script.json"), CODEX_HOME: join(base, "codex") }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((resolve) => desk3.stdout.on("data", (d) => /Toryo is running/.test(d) && resolve()));
    const long = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    long.on("pageerror", (e) => errors.push(String(e)));
    await long.goto(`http://localhost:${port3}/#/r/${longId}`);
    await long.waitForSelector('#sessionStrip:not([hidden]) .ss-lane[data-lane="plan"] .ss-seg');
    const longWords = /^Building 8 h 20 · Reviewing 8 h 20 · Planning 8 h 20 · /;
    assert.match(await long.innerText("#sessionStrip .ss-words"), longWords);
    // Any task over 50 ms from here on is noted; the room's news (a rename) makes the page fetch it again.
    await long.evaluate(() => {
      window.longTasks = [];
      new PerformanceObserver((list) => window.longTasks.push(...list.getEntries().map((e) => e.duration))).observe({ type: "longtask" });
    });
    await new Promise((r) => setTimeout(r, 300));
    const refetched = long.waitForResponse((r) => r.url().endsWith(`/api/rooms/${longId}`));
    await fetch(`http://localhost:${port3}/api/rooms/${longId}/control`, { method: "POST", headers: { "content-type": "application/json", "x-toryo": "1" }, body: JSON.stringify({ action: "rename", title: "Long room, renamed" }) });
    await refetched;
    await long.waitForFunction(() => document.querySelector("#roomTitle")?.textContent === "Long room, renamed");
    await new Promise((r) => setTimeout(r, 300));
    const longest = Math.max(0, ...(await long.evaluate(() => window.longTasks)));
    assert.ok(longest < 1000, `a refresh of a room with 3000 events held the page for ${Math.round(longest)} ms`);
    assert.match(await long.innerText("#sessionStrip .ss-words"), longWords);
    await long.close();
  } finally {
    desk3.kill("SIGTERM");
    await new Promise((r) => desk3.once("exit", r));
  }

  // 5x. A new session, from the room's menu. Refused while Codex works, with a way to stop the room; then a double
  // click starts one session, with a first message. The earlier session folds, and the strip can show it.
  await openRoom(stripRoom.id, "Strip room");
  await post(`api/rooms/${stripRoom.id}/messages`, { text: "Hold this.", to: "codex", answering: false });
  await until(async () => (await view(stripRoom.id)).live.length === 1);
  await page.click("#roomBtn");
  await page.click("[data-new-session]");
  await page.waitForSelector("#sessionForm .ns-busy:not([hidden])");
  assert.match(await page.innerText("#sessionForm .ns-busy"), /^Codex is replying\. Wait for it to finish, or stop the room first\./);
  await page.click("#sessionForm [data-ns-stop]");
  await until(async () => (await view(stripRoom.id)).live.length === 0);
  await page.click('#sessionForm .modecard[data-mode="chat"]');
  await page.fill("#nsText", "Next sprint.");
  await page.dblclick("#nsGo");
  await page.waitForSelector("#sheet", { state: "hidden" });
  await page.waitForSelector('#log .sessionmark:has-text("Session 2 started")');
  assert.equal((await view(stripRoom.id)).events.filter((e) => e.type === "session").length, 1, "one session, however many clicks");
  // The earlier session: one closed line, which opens to show it.
  const fold = "#log details.sessionfold";
  assert.match(await page.innerText(`${fold} > summary`), /^Session 1\b/);
  assert.equal(await page.$eval(fold, (d) => d.open), false);
  const oldTurn = (await view(stripRoom.id)).events.find((e) => e.type === "turn");
  assert.equal(await page.isVisible(`#log [data-id="${oldTurn.id}"]`), false);
  // The strip starts again: this session's reply.
  await until(async () => (await view(stripRoom.id)).events.some((e) => e.type === "turn" && /Ready/.test(e.text ?? "")));
  await page.waitForFunction(() => /^Session 2 · Other work \d+ s · \d+ s in all$/.test(document.querySelector("#sessionStrip .ss-words")?.innerText ?? ""));
  // Session 1 on the strip, from the list; a piece of it opens the fold to its turn; then back.
  await page.click("#sessionStrip .ss-words");
  await page.click('#sheet [data-show-session="0"]');
  await page.waitForFunction(() => /^Session 1 \(earlier\) · Other work/.test(document.querySelector("#sessionStrip .ss-words")?.innerText ?? ""));
  assert.equal(await page.isVisible("#sessionStrip .ss-back"), true);
  await page.click(`#sessionStrip .ss-seg[data-seg="${oldTurn.id}"]`);
  await page.waitForFunction((id) => document.querySelector(`#log [data-id="${id}"]`)?.checkVisibility(), oldTurn.id);
  assert.equal(await page.$eval(fold, (d) => d.open), true);
  await page.click("#sessionStrip .ss-back");
  await page.waitForFunction(() => /^Session 2 · /.test(document.querySelector("#sessionStrip .ss-words")?.innerText ?? ""));
  // Started from another client (the terminal, another window) while this page shows the room: session 2 folds as
  // it happens, without a reload.
  const sprintReply = (await view(stripRoom.id)).events.filter((e) => e.type === "turn").at(-1);
  await post(`api/rooms/${stripRoom.id}/control`, { action: "new-session", ends: 2 });
  await page.waitForSelector('#log .sessionmark:has-text("Session 3 started")');
  assert.deepEqual(await page.$$eval("#log details.sessionfold > summary b", (bs) => bs.map((b) => b.textContent)), ["Session 1", "Session 2"]);
  assert.equal(await page.isVisible(`#log [data-id="${sprintReply.id}"]`), false, "session 2's reply is in its fold");
  await page.waitForFunction(() => /^Session 3 · /.test(document.querySelector("#sessionStrip .ss-words")?.innerText ?? ""));

  // 6. A page file changes on disk under the running desk: the page says to restart Toryo (a reload can't help).
  appendFileSync(join(web, "styles.css"), "\n/* edited by a build room */\n");
  await page.waitForSelector(".reloadbar[data-kind=restart]", { timeout: 15_000 });
  assert.match(await page.textContent(".reloadbar"), /Toryo has been updated\. Restart Toryo to use it: toryo quit && toryo/);
  await page.screenshot({ path: join(tmpdir(), "toryo-ui-check.png") });

  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  await browser.close();
  console.log("UI check passed. Screenshot:", join(tmpdir(), "toryo-ui-check.png"));
} finally {
  desk?.kill("SIGTERM");
  await new Promise((r) => (desk ? desk.once("exit", r) : r()));
  rmSync(base, { recursive: true, force: true });
}
