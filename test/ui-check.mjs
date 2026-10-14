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
    { agent: "codex", match: "Slow build of the parser", delayMs: 6000, reply: "Built the parser.\nTORYO: OWNER Ship it?" },
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
  desk = spawn(node, [join(root, "bin", "toryo.mjs"), "--port", String(port)], {
    env: { ...process.env, TORYO_HOME: home, TORYO_WEB_DIR: web, FAKE_SCRIPT: join(base, "script.json"), CODEX_HOME: join(base, "codex") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => desk.stdout.on("data", (d) => /Toryo is running/.test(d) && resolve()));
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

  // 0. Usage meters: each window says how old its own reading is, and a limit that resets while the page
  // sits idle (no readings, no events, no navigation) shows as reset rather than keeping its old percentage.
  const idle = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  idle.on("pageerror", (e) => errors.push(String(e)));
  await idle.clock.install();
  await idle.goto(url);
  await idle.waitForSelector(".limits[data-agent=codex] [data-window=five_hour]");
  const meter = (type) => idle.innerText(`.limits[data-agent=codex] [data-window=${type}]`);
  assert.match(await meter("five_hour"), /64%[\s\S]*just now/);
  assert.match(await meter("weekly"), /30%[\s\S]*6 h ago/);
  await idle.clock.fastForward("15:00");
  await idle.waitForFunction(() => /reset/.test(document.querySelector(".limits[data-agent=codex] [data-window=five_hour]")?.innerText ?? ""));
  assert.doesNotMatch(await meter("five_hour"), /64%/);
  assert.match(await meter("five_hour"), /waiting for a new reading/);
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
