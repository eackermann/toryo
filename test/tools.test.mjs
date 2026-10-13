import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGates } from "../src/gates.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";

test("stopping the checks ends the running command and starts no more", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toryo-gates-"));
  try {
    const project = {
      path: dir,
      gates: [
        { name: "ignores SIGTERM", command: "trap '' TERM; sleep 30" },
        { name: "second", command: "touch second.flag" },
      ],
    };
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const started = Date.now();
    const results = await runGates(project, { signal: stop.signal, killGraceMs: 300 });
    assert.ok(Date.now() - started < 5_000, "the command that ignores SIGTERM is killed");
    assert.equal(results.cancelled, true);
    assert.equal(results.length, 0);
    assert.ok(!existsSync(join(dir, "second.flag")));
    // Already stopped: nothing runs at all.
    const again = await runGates({ path: dir, gates: [{ command: "touch first.flag" }] }, { signal: stop.signal });
    assert.equal(again.cancelled, true);
    assert.ok(!existsSync(join(dir, "first.flag")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshots before the first commit include staged files and leave the project's index alone", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-snap-"));
  try {
    const repo = join(base, "repo");
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "staged.txt"), "staged");
    execFileSync("git", ["-C", repo, "add", "staged.txt"]);
    writeFileSync(join(repo, "staged.txt"), "staged, then edited");
    writeFileSync(join(repo, "untracked.txt"), "new");
    const index = readFileSync(join(repo, ".git", "index"));
    const snaps = new Snapshots(join(base, "home"));
    const project = { id: "p", path: repo };
    const snap = await snaps.take(project, "t");
    const git = (...a) => execFileSync("git", [`--git-dir=${snaps.gitDir(project)}`, ...a], { encoding: "utf8" });
    assert.deepEqual(git("ls-tree", "-r", "--name-only", snap.commit).trim().split("\n"), ["staged.txt", "untracked.txt"]);
    assert.equal(git("show", `${snap.commit}:staged.txt`), "staged, then edited");
    assert.deepEqual(readFileSync(join(repo, ".git", "index")), index);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("one desk per data folder: of several desks starting at once, exactly one gets the lock", async () => {
  const home = mkdtempSync(join(tmpdir(), "toryo-lock-"));
  // A dead desk's leftover pid file changes nothing: the lock is a socket the kernel freed when it died.
  writeFileSync(join(home, "desk.lock"), "999999");
  const store = new URL("../src/store.mjs", import.meta.url).href;
  const script = `const { Store } = await import(${JSON.stringify(store)});
const lock = await new Store(${JSON.stringify(home)}).lockDesk();
process.stdout.write(JSON.stringify({ ok: lock.ok, pid: lock.pid ?? null }) + "\\n");
setTimeout(() => process.exit(0), 1500);`;
  const contenders = Array.from({ length: 4 }, () => spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] }));
  try {
    const results = await Promise.all(
      contenders.map(
        (c) =>
          new Promise((resolve) => {
            let out = "";
            c.stdout.on("data", (d) => (out += d));
            c.stdout.once("end", () => resolve({ ...JSON.parse(out), self: c.pid }));
          }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1);
    // The others are told which desk holds it.
    for (const r of results.filter((x) => !x.ok)) assert.equal(r.pid, winners[0].self);
    // Once the winner has gone, the next desk gets the lock straight away.
    await new Promise((r) => setTimeout(r, 200));
    const mine = await new Store(home).lockDesk();
    assert.equal(mine.ok, true);
    assert.equal(readFileSync(join(home, "desk.lock"), "utf8"), String(process.pid));
    mine.release();
    assert.ok(!existsSync(join(home, "desk.lock")));
  } finally {
    for (const c of contenders) c.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a check that runs out of time fails, even if it exits cleanly when stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toryo-gates-"));
  try {
    const [r] = await runGates({ path: dir, gates: [{ name: "slow", command: "trap 'exit 0' TERM; while :; do sleep 0.1; done", timeoutMin: 0.005 }] }, { killGraceMs: 2_000 });
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, true);
    assert.equal(r.ok, false);
    assert.match(r.output, /timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
