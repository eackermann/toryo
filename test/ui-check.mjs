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
  writeFileSync(join(base, "script.json"), JSON.stringify({ rules: [{ agent: "claude", hang: true }, { agent: "codex", reply: "Which one?\nTORYO: OWNER SQLite or Postgres?" }], log: join(base, "calls.jsonl") }));
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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

  // 4. The room list says who is doing what.
  await page.waitForFunction(() => document.querySelector(".roomlink .mini.avatar"));
  const row = await page.$eval(".roomlink[aria-current=true]", (b) => ({ title: b.title, text: b.querySelector(".m").textContent }));
  assert.match(row.title, /Codex app is building/);
  assert.match(row.text, /CA🔨/);

  // 5. A question asked in chat: "needs you" comes first in the room list.
  const asked = await (await fetch(`${url}api/rooms`, { method: "POST", headers: { "content-type": "application/json", "x-toryo": "1" }, body: JSON.stringify({ projectId: "ui", mode: "chat", members: ["codex"], text: "Ask me something.", to: "codex", title: "Asking room" }) })).json();
  await page.waitForFunction((id) => document.querySelector(`.roomlink[data-room="${id}"]`)?.dataset.state === "waiting", asked.id);
  const ask = await page.$eval(`.roomlink[data-room="${asked.id}"]`, (b) => ({ title: b.title, first: b.querySelector(".m").firstElementChild.className }));
  assert.equal(ask.first, "needs");
  assert.match(ask.title, /Codex is waiting for your answer/);

  // 5b. An agent with a session in a room can be started fresh there.
  await page.click(`.roomlink[data-room="${asked.id}"]`);
  await page.waitForSelector("[data-fresh=codex]");
  await page.click("[data-fresh=codex]");
  await page.waitForFunction(() => /Starts fresh on its next turn/.test(document.querySelector("#crewPane")?.innerText ?? ""));

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
