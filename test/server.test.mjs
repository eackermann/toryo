import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToryoClient } from "../src/client.mjs";
import { createServer } from "../src/server.mjs";
import { setup, waitFor } from "./helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withServer(rules, fn) {
  const t = await setup(rules);
  const app = createServer({ engine: t.engine, webDir: join(root, "web"), port: 0 });
  const addr = await app.listen();
  writeFileSync(join(t.home, "server.json"), JSON.stringify({ port: addr.port, pid: process.pid }));
  try {
    await fn({ ...t, port: addr.port, client: new ToryoClient(t.home) });
  } finally {
    await app.close();
    t.cleanup();
  }
}

test("the API refuses cross-site and foreign-host requests, and serves the app", async () => {
  await withServer([], async ({ port }) => {
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Toryo<\/title>/);
    const noHeader = await fetch(`${base}/api/rooms`, { method: "POST", body: "{}" });
    assert.equal(noHeader.status, 403);
    const crossSite = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "x-toryo": "1", origin: "http://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(crossSite.status, 403);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.config.projects[0].id, "repo");
    const traversal = await fetch(`${base}/api/projects/repo/file?path=../../etc/passwd`);
    assert.equal(traversal.status, 403);
  });
});

test("the CLI client and MCP server can start a room, read it, and answer", async () => {
  await withServer(
    [
      { agent: "codex", match: "Your role: builder", reply: "Question first.\nI recommend tabs.\nTORYO: OWNER Tabs or spaces?" },
      { agent: "codex", match: "The owner answered", reply: "Using tabs.\nTORYO: OWNER anything else?" },
    ],
    async ({ client, home, engine }) => {
      const started = await client.start({ mode: "build", text: "Format the files" });
      assert.match(started, /Started/);
      await waitFor(() => [...engine.rooms.values()][0]?.waiting, { label: "question" });
      const status = await client.statusText();
      assert.match(status, /waiting for you: Codex asks: Tabs or spaces\?/);

      // MCP over stdio, as Claude Code or Codex would run it.
      const mcp = spawn(process.execPath, [join(root, "bin", "toryo.mjs"), "mcp"], { env: { ...process.env, TORYO_HOME: home } });
      const replies = [];
      let buf = "";
      mcp.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          replies.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      });
      const send = (m) => mcp.stdin.write(JSON.stringify(m) + "\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "toryo_room", arguments: {} } });
      await waitFor(() => replies.some((r) => r.id === 3), { label: "room read" });
      assert.match(replies.find((r) => r.id === 3).result.content[0].text, /WAITING FOR YOU: Codex asks: Tabs or spaces\?/);
      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "toryo_answer", arguments: { accept: true } } });
      await waitFor(() => replies.length >= 4, { label: "mcp replies" });
      mcp.kill();
      // Calls run concurrently, so match replies by id rather than by order.
      const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
      assert.equal(byId[1].result.serverInfo.name, "toryo");
      assert.ok(byId[2].result.tools.some((t) => t.name === "toryo_say"));
      assert.match(byId[4].result.content[0].text, /Answered/);
      await waitFor(() => /anything else\?/.test([...engine.rooms.values()][0]?.waiting?.question ?? ""), { label: "answered and continued" });
      const last = (await client.roomText(undefined, { last: 3 })).split("\n");
      assert.ok(last.some((l) => /Go with your recommendation: tabs/i.test(l)));
    },
  );
});

test("the CLI client can start a build that begins with the review", async () => {
  await withServer([{ agent: "codex", match: "Your role: reviewer", reply: "Looks fine.\nTORYO: OWNER Ship it?" }], async ({ client, engine, calls }) => {
    const started = await client.start({ mode: "build", text: "Address the review", builder: "claude", reviewer: "codex", reviewFirst: true, handoff: "Read docs/reviews/x.md" });
    assert.match(started, /Started/);
    const room = [...engine.rooms.values()][0];
    await waitFor(() => room.waiting, { label: "reviewer's question" });
    assert.deepEqual(room.crew, { members: ["codex", "claude"], builder: "claude", reviewer: "codex" });
    assert.match(calls()[0].prompt, /Read docs\/reviews\/x\.md/);
  });
});

test("a second desk on the same data folder refuses to load the rooms, even when it can't reach the first", async () => {
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createServer: netServer } = await import("node:net");
  const { FAKE } = await import("./helpers.mjs");
  const base = mkdtempSync(join(tmpdir(), "toryo-desk-"));
  const home = join(base, "home");
  const freePort = () => new Promise((resolve) => { const s = netServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  // Agents point at the fake, and Codex's usage logs at an empty folder: nothing real is started or read.
  const env = { ...process.env, TORYO_HOME: home, CODEX_HOME: join(base, "codex") };
  const { Store } = await import("../src/store.mjs");
  new Store(home).saveConfig({ version: 1, notify: { windows: false }, agents: { codex: { command: [process.execPath, FAKE, "codex"] }, claude: { command: [process.execPath, FAKE, "claude"] }, codexapp: { exe: "/nonexistent" } }, projects: [] });
  const desk = (port) => {
    const child = spawn(process.execPath, [join(root, "bin", "toryo.mjs"), "--port", String(port)], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    return { child, out: () => out, exit: new Promise((r) => child.once("exit", (code) => r(code))) };
  };
  const first = desk(await freePort());
  try {
    await waitFor(() => /Toryo is running/.test(first.out()), { label: "first desk" });
    // As with a desk on the network whose token the probe lacked: the running desk can't be reached.
    const info = JSON.parse(readFileSync(join(home, "server.json"), "utf8"));
    writeFileSync(join(home, "server.json"), JSON.stringify({ ...info, port: await freePort() }));
    const second = desk(await freePort());
    assert.equal(await second.exit, 1);
    assert.match(second.out(), new RegExp(`Another Toryo \\(pid ${first.child.pid}\\) is using`));
  } finally {
    first.child.kill("SIGTERM");
    await first.exit;
    assert.ok(!existsSync(join(home, "desk.lock")), "the lock goes with the desk");
    rmSync(base, { recursive: true, force: true });
  }
});

test("the desk serves the page it started with, and says when the files on disk have changed", async () => {
  const { cpSync, mkdtempSync, rmSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const web = join(mkdtempSync(join(tmpdir(), "toryo-web-")), "web");
  cpSync(join(root, "web"), web, { recursive: true });
  const t = await setup([]);
  const app = createServer({ engine: t.engine, webDir: web, port: 0 });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const firstState = async () => {
    const res = await fetch(`${base}/api/events`);
    const reader = res.body.getReader();
    let text = "";
    while (!/\n\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    reader.cancel();
    return JSON.parse(text.match(/^data: (.*)$/m)[1]);
  };
  try {
    const original = await (await fetch(`${base}/app.js`)).text();
    assert.match(await (await fetch(`${base}/status.js`)).text(), /statusLineIndex/);
    let st = await firstState();
    assert.equal(st.webOnDisk, st.webVersion);
    // A build room edits the page under the running desk.
    write(join(web, "app.js"), `import "./new.js";\n${original}`);
    write(join(web, "new.js"), "export const x = 1;\n");
    await new Promise((r) => setTimeout(r, 1_100));
    assert.equal(await (await fetch(`${base}/app.js`)).text(), original);
    assert.equal((await fetch(`${base}/new.js`)).status, 404);
    st = await firstState();
    assert.notEqual(st.webOnDisk, st.webVersion, "the page is told the files on disk differ");
  } finally {
    await app.close();
    t.cleanup();
    rmSync(dirname(web), { recursive: true, force: true });
  }
});

test("a page with a missing file stops the desk from starting", async () => {
  const { cpSync, existsSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { loadPage } = await import("../src/page.mjs");
  const base = mkdtempSync(join(tmpdir(), "toryo-web-"));
  const web = join(base, "web");
  cpSync(join(root, "web"), web, { recursive: true });
  try {
    assert.deepEqual(loadPage(web).names, ["/app.js", "/favicon.svg", "/index.html", "/intent.js", "/md.js", "/meters.js", "/status.js", "/styles.css"]);
    rmSync(join(web, "status.js"));
    assert.throws(() => loadPage(web), /Missing in .*: status\.js \(used by app\.js\)/);
    // The desk itself refuses, before it touches any room.
    const home = join(base, "home");
    const desk = spawn(process.execPath, [join(root, "bin", "toryo.mjs"), "--port", "0"], { env: { ...process.env, TORYO_HOME: home, TORYO_WEB_DIR: web } });
    let err = "";
    desk.stderr.on("data", (d) => (err += d));
    const code = await new Promise((r) => desk.once("exit", r));
    assert.equal(code, 1);
    assert.match(err, /Toryo's page is incomplete.*status\.js/);
    assert.ok(!existsSync(join(home, "server.json")));
    rmSync(join(web, "index.html"));
    assert.throws(() => loadPage(web), /index\.html is missing/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the startup check reads every usual way of referring to a page file", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { loadPage } = await import("../src/page.mjs");
  const base = mkdtempSync(join(tmpdir(), "toryo-web-"));
  try {
    for (const [i, tag] of [`<script src='/x.js'></script>`, `<script src="/x.js?v=1"></script>`, `<link rel=stylesheet href=x.js#top>`, `<SCRIPT SRC="./x.js"></SCRIPT>`].entries()) {
      const web = join(base, `web${i}`);
      mkdirSync(web);
      write(join(web, "index.html"), `<!doctype html><a href="#">top</a><a href="https://example.com/">out</a><a href="?token=1">token</a>${tag}`);
      assert.throws(() => loadPage(web), /Missing in .*: x\.js \(used by index\.html\)/, tag);
      write(join(web, "x.js"), "export {};\n");
      assert.deepEqual(loadPage(web).names, ["/index.html", "/x.js"], tag);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
