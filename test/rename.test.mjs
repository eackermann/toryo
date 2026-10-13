import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStatus } from "../src/protocol.mjs";
import { createServer } from "../src/server.mjs";
import { toryoHome } from "../src/util.mjs";
import { setup } from "./helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Toryo was called Foreman until 13 Oct 2026. Sessions, pages and data from then must keep working.

test("status lines written as FOREMAN: still drive the relay", () => {
  assert.deepEqual(parseStatus("Done.\nTORYO: REVIEW Slice 1 | h.md"), { status: "REVIEW", detail: "Slice 1 | h.md" });
  assert.deepEqual(parseStatus("Done.\nFOREMAN: REVIEW Slice 1 | h.md"), { status: "REVIEW", detail: "Slice 1 | h.md" });
});

test("data from before the rename is used until it moves to ~/.toryo", () => {
  const home = mkdtempSync(join(tmpdir(), "toryo-home-"));
  const saved = { HOME: process.env.HOME, TORYO_HOME: process.env.TORYO_HOME, FOREMAN_HOME: process.env.FOREMAN_HOME };
  try {
    delete process.env.TORYO_HOME;
    delete process.env.FOREMAN_HOME;
    process.env.HOME = home;
    assert.equal(toryoHome(), join(home, ".toryo"));
    mkdirSync(join(home, ".foreman"));
    assert.equal(toryoHome(), join(home, ".foreman"));
    mkdirSync(join(home, ".toryo"));
    assert.equal(toryoHome(), join(home, ".toryo"));
    process.env.FOREMAN_HOME = join(home, "custom");
    assert.equal(toryoHome(), join(home, "custom"));
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  }
});

test("pages and scripts from before the rename can still talk to the desk", async () => {
  const t = await setup([]);
  const app = createServer({ engine: t.engine, webDir: join(root, "web"), port: 0 });
  const { port } = await app.listen();
  try {
    const post = (headers) => fetch(`http://127.0.0.1:${port}/api/agents/refresh`, { method: "POST", headers }).then((r) => r.status);
    assert.equal(await post({}), 403);
    assert.equal(await post({ "x-toryo": "1" }), 200);
    assert.equal(await post({ "x-foreman": "1" }), 200);
  } finally {
    await app.close();
    t.cleanup();
  }
});
