import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyInto, findCopies } from "../src/worktrees.mjs";
import { mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const ws = (engine, id) => engine.roomView(id).room.workspace;
const built = (t) => t.calls().filter((c) => /Your role: builder/.test(c.prompt));
const setupEvents = (engine, id) => engine.roomView(id).events.filter((e) => e.type === "gate" && e.setup);

/** The project with private files Git ignores: a .env (private, 0600), a local one, a key in a folder. */
function privateFiles(repo) {
  writeFileSync(join(repo, ".gitignore"), ".env*\n!.env.example\nsecrets/\nnode_modules/\n");
  writeFileSync(join(repo, ".env.example"), "SECRET=\n");
  git(repo, "add", ".gitignore", ".env.example");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore");
  writeFileSync(join(repo, ".env"), "SECRET=hush-1234\n");
  chmodSync(join(repo, ".env"), 0o600);
  writeFileSync(join(repo, ".env.local"), "LOCAL=1\n");
  mkdirSync(join(repo, "secrets"));
  writeFileSync(join(repo, "secrets", "key.json"), '{"key":"hush-5678"}\n');
}

test("a project's private files are copied into a new worktree with their permissions, and never get into its snapshots, diffs or records, even once the room stops ignoring them", async () => {
  const t = await setup(
    [
      // The builder stops ignoring .env and stages it: still nothing of it leaves the worktree.
      { agent: "codex", match: "Your role: builder", write: { path: ".gitignore", content: "node_modules/\n" }, sh: ["git add .env", "echo changed >> .env"], reply: "Built.\nTORYO: OWNER Done?" },
    ],
    { engine: { folderDefault: "own" } },
  );
  const outside = mkdtempSync(join(tmpdir(), "toryo-outside-"));
  try {
    privateFiles(t.repo);
    writeFileSync(join(outside, "x.json"), "{}\n");
    symlinkSync(outside, join(t.repo, "linked"));
    symlinkSync("/etc/hostname", join(t.repo, ".env.link"));
    // Patterns that would reach outside the project's folder are refused when they're saved.
    for (const bad of ["../x", "/etc/passwd", ".git/config", "./x"]) assert.throws(() => t.engine.updateProject("repo", { worktree: { copy: [bad] } }), /Files to copy: /);
    t.engine.updateProject("repo", { worktree: { copy: [".env*", "secrets/*.json", "linked/*.json"] } });
    const preview = await t.engine.worktreeFiles("repo");
    assert.deepEqual(preview.files, [".env", ".env.local", "secrets/key.json"]);
    const why = Object.fromEntries(preview.refused.map((r) => [r.path, r.why]));
    assert.match(why[".env.example"], /one of the project's own files/);
    assert.match(why[".env.link"], /it's a link/);
    assert.match(why["linked/*.json"], /goes through a link \(linked\)/);

    const r = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await waitFor(() => turns(t.engine, r.id).some((e) => e.state === "done"), { label: "built" });
    const w = ws(t.engine, r.id);
    assert.equal(readFileSync(join(w.cwd, "secrets", "key.json"), "utf8"), '{"key":"hush-5678"}\n');
    assert.equal(statSync(join(w.cwd, ".env")).mode & 0o777, 0o600);
    assert.equal(existsSync(join(w.cwd, ".env.link")), false);
    assert.deepEqual(w.private, [".env", ".env.local", "secrets/key.json"]);
    // The room says which files, by name only.
    const said = t.engine.roomView(r.id).events.find((e) => e.type === "system" && /^Copied into the worktree/.test(e.text)).text;
    assert.match(said, /\.env, \.env\.local, secrets\/key\.json\. Not copied: .*\.env\.example \(it's one of the project's own files/);
    // The builder un-ignored .env, staged and changed it: the turn's diff has .gitignore, not .env.
    assert.match(git(w.cwd, "diff", "--cached", "--name-only"), /^\.env$/m);
    const turn = turns(t.engine, r.id).find((e) => e.agent === "codex");
    assert.deepEqual((await t.engine.turnDiff(r.id, turn.id)).files.map((f) => f.path), [".gitignore"]);
    const sinceStart = await t.engine.snapshots.changes(t.engine.project("repo"), w.base, turn.snapAfter);
    assert.deepEqual(sinceStart.map((f) => f.path), [".gitignore"]);
    // Nothing of the secrets in the room's records.
    const records = readFileSync(join(t.home, "rooms", r.id, "events.jsonl"), "utf8") + JSON.stringify(t.engine.roomView(r.id));
    assert.equal(/hush-/.test(records), false);
    // The main folder: as it was.
    assert.equal(readFileSync(join(t.repo, ".gitignore"), "utf8"), ".env*\n!.env.example\nsecrets/\nnode_modules/\n");
    assert.equal(readFileSync(join(t.repo, ".env"), "utf8"), "SECRET=hush-1234\n");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    t.cleanup();
  }
});

test("copying stops at a link in the worktree's way, and never writes through it", () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-copy-"));
  try {
    const from = join(base, "from");
    const to = join(base, "to");
    const elsewhere = join(base, "elsewhere");
    for (const d of [join(from, "config"), to, elsewhere]) mkdirSync(d, { recursive: true });
    writeFileSync(join(from, "config", "local.json"), "{}\n");
    symlinkSync(elsewhere, join(to, "config"));
    const r = copyInto(from, to, [{ path: "config/local.json", mode: 0o600 }]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /config in the worktree isn't a folder \(a link or a file\)/);
    assert.equal(existsSync(join(elsewhere, "local.json")), false);
    // Nor over a file that's there.
    writeFileSync(join(to, "x"), "theirs\n");
    writeFileSync(join(from, "x"), "ours\n");
    assert.match(copyInto(from, to, [{ path: "x", mode: 0o644 }]).reason, /there's already a file there/);
    assert.equal(readFileSync(join(to, "x"), "utf8"), "theirs\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a file that changes between being found and being copied isn't copied: made a link, its folder made a link, another file; permissions as they are then", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-copyrace-"));
  try {
    const from = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(join(outside, "secrets"), { recursive: true });
    writeFileSync(join(outside, "secret"), "not the project's\n");
    writeFileSync(join(outside, "secrets", "key.json"), "not the project's\n");
    execFileSync("git", ["init", "-q", from]);
    writeFileSync(join(from, ".gitignore"), ".env\nsecrets/\n");
    git(from, "add", ".gitignore");
    writeFileSync(join(from, ".env"), "A=1\n");
    mkdirSync(join(from, "secrets"));
    writeFileSync(join(from, "secrets", "key.json"), "{}\n");
    const fresh = () => {
      const to = mkdtempSync(join(base, "wt-"));
      return to;
    };
    const find = async () => {
      const r = await findCopies(from, [".env", "secrets/*.json"]);
      assert.equal(r.ok, true);
      return r.files;
    };
    // .env made a link to a file outside, after it was found.
    let files = await find();
    rmSync(join(from, ".env"));
    symlinkSync(join(outside, "secret"), join(from, ".env"));
    let to = fresh();
    let r = copyInto(from, to, files);
    assert.match(r.reason, /couldn't copy \.env: it changed since Toryo looked \(it's a link now\)/);
    assert.equal(existsSync(join(to, ".env")), false);
    rmSync(join(from, ".env"));
    writeFileSync(join(from, ".env"), "A=1\n");
    // Its folder made a link to one outside.
    files = await find();
    execFileSync("mv", [join(from, "secrets"), join(from, "secrets.old")]);
    symlinkSync(join(outside, "secrets"), join(from, "secrets"));
    to = fresh();
    r = copyInto(from, to, files);
    assert.match(r.reason, /couldn't copy secrets\/key\.json: it changed since Toryo looked \(secrets isn't a folder any more\)/);
    assert.equal(existsSync(join(to, "secrets", "key.json")), false);
    rmSync(join(from, "secrets"));
    execFileSync("mv", [join(from, "secrets.old"), join(from, "secrets")]);
    // Another file in its place.
    files = await find();
    rmSync(join(from, ".env"));
    writeFileSync(join(from, ".env"), "B=2\n");
    r = copyInto(from, fresh(), files);
    assert.match(r.reason, /couldn't copy \.env: it changed since Toryo looked \(it's another file now\)/);
    // Permissions tightened after it was found: copied as they are now.
    files = await find();
    chmodSync(join(from, ".env"), 0o600);
    to = fresh();
    assert.equal(copyInto(from, to, files).ok, true);
    assert.equal(statSync(join(to, ".env")).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("every byte is copied however little each write takes, and a write that takes nothing stops the copy", () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-shortwrite-"));
  try {
    const from = join(base, "from");
    mkdirSync(from);
    const content = "0123456789abcdefghij".repeat(5000); // longer than one read buffer
    writeFileSync(join(from, ".env"), content);
    const st = statSync(join(from, ".env"), { bigint: true });
    const file = { path: ".env", dev: String(st.dev), ino: String(st.ino) };
    // Each write takes at most 5 bytes.
    const short = (fd, buf, offset, length) => writeSync(fd, buf, offset, Math.min(5, length));
    const to = join(base, "to");
    mkdirSync(to);
    assert.equal(copyInto(from, to, [file], { write: short }).ok, true);
    assert.equal(readFileSync(join(to, ".env"), "utf8"), content);
    // A write that takes nothing: the copy stops, saying so.
    const stuck = join(base, "stuck");
    mkdirSync(stuck);
    const r = copyInto(from, stuck, [file], { write: () => 0 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /couldn't copy \.env: writing it in the worktree made no progress/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the project's own files don't crowd out a later pattern, and a scan that can't look everywhere says so", async () => {
  const t = await setup([]);
  try {
    writeFileSync(join(t.repo, ".gitignore"), ".env\n");
    for (let i = 0; i < 1001; i++) writeFileSync(join(t.repo, `source${i}.txt`), `${i}\n`);
    git(t.repo, "add", ".");
    git(t.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "many");
    writeFileSync(join(t.repo, ".env"), "A=1\n");
    const r = await findCopies(t.repo, ["source*", ".env"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.map((f) => f.path), [".env"]);
    assert.equal(r.refused.length, 1001);
    assert.match(r.refused[0].why, /one of the project's own files/);
    // Past its limit, the scan fails rather than copy a part.
    const capped = await findCopies(t.repo, ["source*", ".env"], { maxVisits: 100 });
    assert.equal(capped.ok, false);
    assert.match(capped.reason, /the copy pattern “source\*” reaches more than 100 files and folders, so Toryo stopped looking; make it narrower/);
    // So does a path deeper than it looks: a file 42 folders down is never silently missed.
    const deep = Array.from({ length: 42 }, (_, i) => `d${i}`).join("/");
    mkdirSync(join(t.repo, deep), { recursive: true });
    writeFileSync(join(t.repo, deep, ".env"), "A=1\n");
    const tooDeep = await findCopies(t.repo, [".env", `${deep}/.env`]);
    assert.equal(tooDeep.ok, false);
    assert.deepEqual(tooDeep.files, []);
    assert.match(tooDeep.reason, /the copy pattern “d0\/d1\/.*\/d41\/\.env” reaches folders more than 40 deep, so Toryo stopped looking; make it narrower/);
  } finally {
    t.cleanup();
  }
});

test("the setup runs in the worktree before the room's first turn: its changes show, its dependencies stay there, the main folder is untouched", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], { engine: { folderDefault: "own" } });
  try {
    privateFiles(t.repo);
    t.engine.updateProject("repo", { worktree: { copy: [".env"], setup: "pwd > where.txt; test -f .env && echo 'has .env'; mkdir -p node_modules/dep && echo 1 > node_modules/dep/i.js; echo gen > generated.txt" } });
    const r = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await waitFor(() => built(t).length, { label: "built" });
    const w = ws(t.engine, r.id);
    const [run] = setupEvents(t.engine, r.id);
    // Before the first turn, in the worktree, with the copied files there.
    assert.ok(built(t)[0].at >= Date.parse(run.at), "the builder started after the setup ended");
    assert.equal(readFileSync(join(w.cwd, "where.txt"), "utf8").trim(), w.cwd);
    assert.match(run.results[0].output, /has \.env/);
    assert.deepEqual(run.files, ["generated.txt", "where.txt"]);
    assert.equal(w.setup.state, "done");
    assert.equal(w.setup.attempt, 1);
    assert.ok(existsSync(join(w.cwd, "node_modules", "dep", "i.js")));
    // Its changes are part of what the room changed from its starting point (its ignored dependencies aren't).
    const now = await t.engine.snapshots.take(t.engine.project("repo"), "now", { id: w.id, path: w.cwd, exclude: w.private });
    assert.deepEqual((await t.engine.snapshots.changes(t.engine.project("repo"), w.base, now.commit)).map((f) => f.path), ["generated.txt", "where.txt"]);
    for (const f of ["where.txt", "generated.txt", "node_modules"]) assert.equal(existsSync(join(t.repo, f)), false, f);
    assert.equal(t.engine.setupView(r.id).attempts[0].ok, true);
  } finally {
    t.cleanup();
  }
});

test("a failed setup holds the room until retried, with the project's setup as it is then; nothing runs meanwhile", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], { engine: { folderDefault: "own" } });
  try {
    t.engine.updateProject("repo", { worktree: { setup: "echo broken >&2; exit 3" } });
    const r = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await waitFor(() => t.engine.roomView(r.id).questions.some((q) => q.kind === "setup"), { label: "asked" });
    const q = t.engine.roomView(r.id).questions.find((x) => x.kind === "setup");
    assert.match(q.question, /The worktree's setup failed \(attempt 1, exit 3\)\. What it printed is above\. Nothing runs in the room until it has/);
    assert.equal(q.recommendation, "Retry");
    assert.match(setupEvents(t.engine, r.id)[0].results[0].output, /broken/);
    assert.equal(built(t).length, 0, "no turn ran");
    assert.match(t.engine.summary(t.engine.rooms.get(r.id)).blocked.flatMap((b) => b.reasons).join(), /its setup hasn't finished: retry it/);
    // A written answer isn't a Retry: it's kept, the setup isn't run again, and the room isn't asked again.
    t.engine.answer(r.id, { text: "No, don't run it again.", questionId: q.id });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(ws(t.engine, r.id).setup.attempt, 1);
    assert.equal(ws(t.engine, r.id).setup.state, "failed");
    assert.equal(t.engine.roomView(r.id).questions.length, 0);
    assert.equal(t.engine.roomView(r.id).events.find((e) => e.id === q.id).answer, "No, don't run it again.");
    assert.equal(t.engine.setupView(r.id).setup.declined, true);
    assert.equal(built(t).length, 0);
    // Fixed in the project's settings, then retried: the new command runs.
    t.engine.updateProject("repo", { worktree: { setup: "echo fixed" } });
    t.engine.control(r.id, "retry-setup");
    await waitFor(() => built(t).length, { label: "built" });
    const v = t.engine.setupView(r.id);
    assert.deepEqual([v.setup.state, v.setup.attempt, v.setup.command], ["done", 2, "echo fixed"]);
    assert.deepEqual(v.attempts.map((a) => [a.attempt, a.command, a.outcome, a.code]), [[1, "echo broken >&2; exit 3", "failed", 3], [2, "echo fixed", "done", 0]]);
    assert.throws(() => t.engine.control(r.id, "retry-setup"), /has finished; there's nothing to retry/);
  } finally {
    t.cleanup();
  }
});

test("Toryo stopping during the setup: it's interrupted, not run again by itself; Retry runs it", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], { engine: { folderDefault: "own" } });
  try {
    t.engine.updateProject("repo", { worktree: { setup: "echo started >> ran.txt; sleep 30" } });
    const e1 = await t.make({ folderDefault: "own" });
    const r = e1.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await waitFor(() => ws(e1, r.id).setup?.state === "running" && existsSync(join(ws(e1, r.id).cwd, "ran.txt")), { label: "running" });
    e1.shutdown();
    const e2 = await t.make({ folderDefault: "own" });
    assert.equal(ws(e2, r.id).setup.state, "interrupted");
    await waitFor(() => e2.roomView(r.id).questions.some((q) => q.kind === "setup"), { label: "asked" });
    assert.match(e2.roomView(r.id).questions.find((q) => q.kind === "setup").question, /Toryo stopped while the worktree's setup was running \(attempt 1\)\. It doesn't run it again by itself/);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(readFileSync(join(ws(e2, r.id).cwd, "ran.txt"), "utf8"), "started\n", "not run again");
    assert.equal(built(t).length, 0);
    t.engine.updateProject("repo", { worktree: { setup: "echo again >> ran.txt" } });
    e2.updateProject("repo", { worktree: { setup: "echo again >> ran.txt" } });
    e2.control(r.id, "retry-setup");
    await waitFor(() => built(t).length, { label: "built" });
    assert.equal(readFileSync(join(ws(e2, r.id).cwd, "ran.txt"), "utf8"), "started\nagain\n");
    // The interrupted attempt stays in the history, with its own command; the room shows it.
    assert.deepEqual(e2.setupView(r.id).attempts.map((a) => [a.attempt, a.command, a.outcome]), [[1, "echo started >> ran.txt; sleep 30", "interrupted"], [2, "echo again >> ran.txt", "done"]]);
    assert.equal(setupEvents(e2, r.id)[0].results[0].interrupted, true);
    e2.shutdown();
  } finally {
    t.cleanup();
  }
});

test("the running attempt is on disk before its command starts, also with snapshots off: a crash then leaves it interrupted, never run again", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], { engine: { folderDefault: "own" } });
  try {
    // What's on disk the moment the command is launched (before the scheduler's own save).
    let atLaunch = null;
    const e1 = await t.make({ folderDefault: "own", worktreeHooks: { launchingSetup: (room) => (atLaunch = JSON.parse(readFileSync(join(t.home, "rooms", room.id, "room.json"), "utf8"))) } });
    const preview = e1.previewWorkspace("repo");
    const record = join(t.home, "rooms", preview.roomId, "room.json");
    // The command itself reads what's on disk as it starts.
    e1.updateProject("repo", { worktree: { setup: `cat '${record}' > seen.json; echo once >> ran.txt; sleep 30` } });
    const r = e1.createRoom({ projectId: "repo", mode: "build", task: "Build", folder: "own", roomId: preview.roomId, settings: { snapshots: false } });
    const cwd = () => ws(e1, r.id).cwd;
    await waitFor(() => existsSync(join(cwd(), "ran.txt")), { label: "started" });
    assert.equal(atLaunch.workspace.setup.state, "running");
    assert.deepEqual(atLaunch.workspace.setup.attempts.map((a) => [a.n, a.outcome, a.command]), [[1, "running", `cat '${record}' > seen.json; echo once >> ran.txt; sleep 30`]]);
    assert.equal(atLaunch.queue.some((q) => q.kind === "setup"), false, "out of the queue on disk at launch");
    const seen = JSON.parse(readFileSync(join(cwd(), "seen.json"), "utf8"));
    assert.equal(seen.workspace.setup.state, "running");
    assert.deepEqual(seen.workspace.setup.attempts.map((a) => [a.n, a.outcome]), [[1, "running"]]);
    assert.equal(seen.queue.some((q) => q.kind === "setup"), false, "out of the queue on disk");
    e1.shutdown();
    const e2 = await t.make({ folderDefault: "own" });
    assert.equal(ws(e2, r.id).setup.state, "interrupted");
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(readFileSync(join(cwd(), "ran.txt"), "utf8"), "once\n", "not run again");
    assert.equal(built(t).length, 0);
    e2.shutdown();
  } finally {
    t.cleanup();
  }
});

test("a setup whose start can't be saved isn't started", async () => {
  const t = await setup([], { engine: { folderDefault: "own" } });
  try {
    const e = t.engine;
    e.updateProject("repo", { worktree: { setup: "echo ran > ran.txt" } });
    const save = e.store.saveRoom.bind(e.store);
    // The disk refuses the save that says the setup is running.
    e.store.saveRoom = (room) => {
      if (room.workspace?.setup?.state === "running") throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return save(room);
    };
    const r = e.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await waitFor(() => e.roomView(r.id).questions.some((q) => q.kind === "setup"), { label: "asked" });
    e.store.saveRoom = save;
    assert.equal(existsSync(join(ws(e, r.id).cwd, "ran.txt")), false, "not started");
    assert.equal(ws(e, r.id).setup.state, "failed");
    assert.match(e.roomView(r.id).questions.find((q) => q.kind === "setup").question, /couldn't save its record before starting it \(ENOSPC: no space left on device\), so it didn't start/);
    assert.deepEqual(e.setupView(r.id).attempts, []);
  } finally {
    t.cleanup();
  }
});

test("the room's Pause and Pause everything hold the setup back, a hold on agents doesn't; Stop ends it, and it waits for Retry", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], { engine: { folderDefault: "own" } });
  try {
    const e = t.engine;
    e.updateProject("repo", { worktree: { setup: "echo ok" } });
    // Paused before its setup: nothing runs until it's resumed.
    const paused = e.createRoom({ projectId: "repo", mode: "build", task: "Build A" });
    e.control(paused.id, "pause");
    await waitFor(() => ws(e, paused.id).state === "ready", { label: "ready" });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(ws(e, paused.id).setup.state, "pending");
    e.control(paused.id, "resume");
    await waitFor(() => ws(e, paused.id).setup.state === "done", { label: "set up" });
    e.control(paused.id, "stop");
    // Pause everything: held too.
    e.deskControl("pause");
    const desk = e.createRoom({ projectId: "repo", mode: "build", task: "Build B" });
    await waitFor(() => ws(e, desk.id).state === "ready", { label: "ready" });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(ws(e, desk.id).setup.state, "pending");
    assert.ok(e.roomView(desk.id).events.some((x) => x.type === "system" && /Waiting: everything is paused/.test(x.text)));
    assert.match(e.summary(e.rooms.get(desk.id)).blocked.find((b) => b.kind === "setup").reasons.join(), /everything is paused/);
    e.deskControl("resume");
    await waitFor(() => ws(e, desk.id).setup.state === "done", { label: "set up" });
    e.control(desk.id, "stop");
    // A hold on Codex: the setup runs; the builder waits for the hold.
    e.deskControl("hold", { target: "codex" });
    const held = e.createRoom({ projectId: "repo", mode: "build", task: "Build C" });
    await waitFor(() => ws(e, held.id).setup?.state === "done", { label: "set up while held" });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(built(t).filter((c) => /Build C/.test(c.prompt)).length, 0);
    e.deskControl("release", { target: "codex" });
    await waitFor(() => built(t).some((c) => /Build C/.test(c.prompt)), { label: "built after the hold" });
    e.control(held.id, "stop");

    // Stop during the setup: its commands are stopped, it isn't run again on resuming, and Retry runs it.
    e.updateProject("repo", { worktree: { setup: "sleep 30 && echo late > late.txt" } });
    const stopped = e.createRoom({ projectId: "repo", mode: "build", task: "Build D" });
    await waitFor(() => ws(e, stopped.id).setup?.state === "running", { label: "running" });
    e.control(stopped.id, "stop");
    await waitFor(() => ws(e, stopped.id).setup.state === "stopped", { label: "stopped" });
    assert.equal(setupEvents(e, stopped.id).at(-1).results[0].cancelled, true);
    e.control(stopped.id, "resume");
    await waitFor(() => e.roomView(stopped.id).questions.some((q) => q.kind === "setup"), { label: "asked" });
    assert.match(e.roomView(stopped.id).questions.find((q) => q.kind === "setup").question, /was stopped before it finished \(attempt 1\)/);
    assert.equal(ws(e, stopped.id).setup.attempt, 1, "not run again by itself");
    e.updateProject("repo", { worktree: { setup: "echo quick > quick.txt" } });
    e.control(stopped.id, "retry-setup");
    await waitFor(() => ws(e, stopped.id).setup.state === "done", { label: "retried" });
    assert.equal(existsSync(join(ws(e, stopped.id).cwd, "late.txt")), false, "the stopped command never finished");
    assert.ok(existsSync(join(ws(e, stopped.id).cwd, "quick.txt")));
    e.control(stopped.id, "stop");
  } finally {
    t.cleanup();
  }
});

test("a project's worktree settings and a room's setup, through the command line and MCP", async () => {
  await withServer([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], async ({ engine, client, home, repo }) => {
    privateFiles(repo);
    const saved = await client.projectText("repo", { copy: [".env*"], setup: "echo set up" });
    assert.match(saved, /^repo \(.+\): saved\.\nFiles copied into a new worktree: \.env\*; they match now: \.env, \.env\.local\.\nNot copied: \.env\.example \(it's one of the project's own files.*\)\.\nSetup, run there before the first turn: echo set up$/);
    await assert.rejects(client.projectText("repo", { copy: ["../up"] }), /Files to copy: “\.\.\/up” steps out of the project's folder/);
    await client.start({ mode: "build", text: "Build it", folder: "own" });
    const room = engine.state().rooms[0];
    await waitFor(() => engine.state().rooms[0].workspace.setup === "done", { label: "set up" });
    const shown = await client.setupText(room.id);
    assert.match(shown, /Copied into its worktree: \.env, \.env\.local\. Not copied: \.env\.example/);
    assert.match(shown, /Setup: echo set up \(finished, attempt 1\)\.\n  Attempt 1, echo set up: finished in \d+s\.\n    set up/);
    const m = mcp(home);
    try {
      assert.match((await m.call("toryo_setup", { room: room.id })).text, /Setup: echo set up \(finished, attempt 1\)/);
      assert.match((await m.call("toryo_setup", { room: room.id, retry: true })).text, /has finished; there's nothing to retry/);
      assert.match((await m.call("toryo_project", { project: "repo", setup: "" })).text, /No setup runs in a new worktree\./);
      assert.deepEqual(engine.project("repo").worktree, { copy: [".env*"], setup: "" });
    } finally {
      m.close();
    }
    engine.control(room.id, "stop");
  });
});
