import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../src/agents/index.mjs";
import { readOnlySupport } from "../src/agents/readonly.mjs";
import { Engine } from "../src/engine.mjs";
import { Snapshots } from "../src/snapshots.mjs";
import { Store } from "../src/store.mjs";
import { lockReason, undoWorktree } from "../src/worktrees.mjs";
import { mcp, setup, turns, waitFor, withServer } from "./helpers.mjs";

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const commit = (dir, msg) => git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);

/** The main folder with work in progress: a staged and unstaged edit, an untracked file, a deletion, an executable bit, a link. */
function dirty(repo) {
  writeFileSync(join(repo, "gone.txt"), "tracked, then deleted\n");
  writeFileSync(join(repo, "tool.sh"), "#!/bin/sh\n");
  git(repo, "add", ".");
  commit(repo, "more");
  writeFileSync(join(repo, "README.md"), "# staged\n");
  git(repo, "add", "README.md");
  writeFileSync(join(repo, "README.md"), "# staged\nand unstaged\n");
  rmSync(join(repo, "gone.txt"));
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  chmodSync(join(repo, "tool.sh"), 0o755);
  symlinkSync("README.md", join(repo, "link"));
}

/** What must stay the same in the main folder: its status, index (byte for byte), HEAD, branches and commits. */
function mainState(repo) {
  const status = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  return {
    status,
    index: readFileSync(join(repo, ".git", "index")).toString("base64"),
    head: git(repo, "rev-parse", "HEAD"),
    branches: git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").split("\n").filter((l) => l && !l.startsWith("refs/heads/toryo/")),
    commits: git(repo, "rev-list", "--all", "--count"),
    files: readdirSync(repo).sort(),
  };
}

const ws = (engine, id) => engine.roomView(id).room.workspace;
const ready = (engine, id) => waitFor(() => ws(engine, id)?.state === "ready", { label: "worktree ready" });
const done = (engine, id, n = 1) => waitFor(() => turns(engine, id).filter((e) => e.state === "done").length >= n && !engine.running.size, { label: `${n} turn(s) done` });

test("two Build rooms from a dirty main folder each get their own worktree with its files; the main folder is untouched", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Anything else?", write: { path: "room.txt", content: "room\n" } }], { engine: { folderDefault: "own" } });
  try {
    dirty(t.repo);
    const before = mainState(t.repo);
    const a = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build A" });
    const b = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build B" });
    // Two builds in one project, side by side: neither waits for the other.
    assert.equal(a.workspace.kind, "worktree");
    assert.equal(b.workspace.kind, "worktree");
    await done(t.engine, a.id);
    await done(t.engine, b.id);
    const wa = ws(t.engine, a.id);
    const wb = ws(t.engine, b.id);
    assert.equal(wa.root, join(t.home, "worktrees", "repo", a.id));
    assert.equal(wa.branch, `toryo/${a.id}`);
    assert.notEqual(wa.root, wb.root);
    // Each builder worked in its own folder.
    assert.deepEqual(t.calls().map((c) => c.cwd).sort(), [wa.cwd, wb.cwd].sort());

    for (const w of [wa, wb]) {
      // The main folder's files as they were, uncommitted work included.
      assert.equal(readFileSync(join(w.cwd, "README.md"), "utf8"), "# staged\nand unstaged\n");
      assert.equal(readFileSync(join(w.cwd, "notes.txt"), "utf8"), "untracked\n");
      assert.equal(existsSync(join(w.cwd, "gone.txt")), false);
      assert.ok(lstatSync(join(w.cwd, "tool.sh")).mode & 0o100);
      assert.equal(readlinkSync(join(w.cwd, "link")), "README.md");
      // Staged in its own index exactly as the starting snapshot (B), which stays pinned; no commit was made.
      assert.equal(git(w.cwd, "write-tree").trim(), w.baseTree);
      assert.equal(await t.engine.snapshots.pinned(t.engine.project("repo"), `room-${w.id}-base`), w.base);
      assert.equal(git(w.cwd, "rev-parse", "HEAD"), before.head);
      // Plain git diff starts empty: what it inherited is staged, and the room's new file is untracked.
      assert.equal(git(w.cwd, "diff"), "");
      assert.match(git(w.cwd, "status", "--porcelain"), /^\?\? room\.txt$/m);
      assert.match(git(w.cwd, "diff", "--cached", "--name-only"), /README\.md/);
      // The turn's changes are the room's own: its new file, not what it inherited.
      const turn = turns(t.engine, w.id)[0];
      assert.deepEqual((await t.engine.turnDiff(w.id, turn.id)).files, [{ status: "A", path: "room.txt" }]);
    }
    // A later edit of an inherited file shows in plain git diff.
    writeFileSync(join(wa.cwd, "README.md"), "# edited in the room\n");
    assert.equal(git(wa.cwd, "diff", "--name-only").trim(), "README.md");
    assert.equal(git(wb.cwd, "diff"), "", "the other room's worktree is its own");

    // The main folder: same files, index, HEAD, branches and commits. Only the rooms' branches were added.
    assert.deepEqual(mainState(t.repo), before);
    assert.equal(existsSync(join(t.repo, "room.txt")), false);
    assert.deepEqual(git(t.repo, "for-each-ref", "--format=%(refname)", "refs/heads/toryo").trim().split("\n").sort(), [`refs/heads/toryo/${a.id}`, `refs/heads/toryo/${b.id}`].sort());
  } finally {
    t.cleanup();
  }
});

test("the agents' briefing names the room's worktree; the main folder appears only as off-limits", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW Slice 1 | h.md", times: 1 },
      { agent: "codex", reply: "Done.\nTORYO: DONE" },
      { agent: "claude", reply: "Fine.\nTORYO: APPROVED" },
    ],
    { engine: { folderDefault: "own" } },
  );
  try {
    const r = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build it" });
    await waitFor(() => t.engine.rooms.get(r.id).done, { label: "build done" });
    const w = ws(t.engine, r.id);
    const prompt = (e) => readFileSync(join(t.home, "rooms", r.id, "turns", e.id, "prompt.md"), "utf8");
    const all = turns(t.engine, r.id);
    const [first, second] = all.filter((e) => e.agent === "codex");
    const review = all.find((e) => e.agent === "claude");
    const main = t.repo;
    // Codex's first prompt carries the briefing: the worktree is where it works.
    assert.match(prompt(first), new RegExp(`Repository: ${w.cwd}\\. This is this room's own worktree`));
    assert.match(prompt(first), /plain `git diff` shows only the changes made here since/);
    assert.equal(prompt(first).split(main).length - 1, 1, "the main folder is named once");
    assert.match(prompt(first), new RegExp(`The project's main folder, ${main}, is off-limits`));
    // Resumed: no briefing again, and no main folder.
    assert.equal(prompt(second).includes(main), false);
    // Claude's instructions carry the briefing on every turn: the worktree, the main folder only as off-limits.
    assert.match(prompt(review), new RegExp(`Repository: ${w.cwd}\\.`));
    assert.equal(prompt(review).split(main).length - 1, 1);
    // The reviewer read the worktree, read-only there and in the main folder.
    const call = t.calls().find((c) => c.kind === "claude");
    assert.equal(call.cwd, w.cwd);
    assert.ok(call.args.includes(`Edit(/${w.cwd}/**)`));
    assert.ok(call.args.includes(`Edit(/${main}/**)`));
  } finally {
    t.cleanup();
  }
});

test("Claude's writing turns in a worktree can't edit the main folder, which is read-only for their commands; the room's index stays writable", async () => {
  const t = await setup([], { engine: { folderDefault: "own" } });
  try {
    const main = t.repo;
    const script = JSON.parse(readFileSync(process.env.FAKE_SCRIPT, "utf8"));
    script.rules = [
      { agent: "claude", match: "Your role: builder", sh: [`echo x > '${main}/hack.txt'`, "echo y > room-sh.txt", "git add room-sh.txt"], reply: "Tried.\nTORYO: OWNER Done?" },
      { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" },
    ];
    writeFileSync(process.env.FAKE_SCRIPT, JSON.stringify(script));
    const r = t.engine.createRoom({ projectId: "repo", mode: "build", members: ["claude", "codex"], builder: "claude", reviewer: "codex", task: "Try" });
    await done(t.engine, r.id);
    const w = ws(t.engine, r.id);
    const call = t.calls().find((c) => c.kind === "claude");
    assert.equal(call.cwd, w.cwd);
    // Claude's own edit tools are off in the main folder.
    for (const tool of ["Edit", "Write", "NotebookEdit"]) assert.ok(call.args.includes(`${tool}(/${main}/**)`), tool);
    const reply = turns(t.engine, r.id)[0].text;
    if (readOnlySupport().ok) {
      // And the main folder is read-only for its commands, while the room's own folder and Git index aren't.
      assert.match(reply, /\(sh failed \d+: echo x >/);
      assert.match(reply, /\(sh ok: echo y > room-sh\.txt\)/);
      assert.match(reply, /\(sh ok: git add room-sh\.txt\)/);
      assert.equal(existsSync(join(main, "hack.txt")), false);
      assert.match(git(w.cwd, "diff", "--cached", "--name-only"), /room-sh\.txt/);
    } else console.log("# read-only mounts aren't available here: only Claude's own rules were checked");

    // Codex: its sandbox is the worktree, with the room's own Git folders writable, not the main folder.
    const c = t.engine.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build" });
    await done(t.engine, c.id);
    const wc = ws(t.engine, c.id);
    const codex = t.calls().find((x) => x.kind === "codex");
    assert.equal(codex.cwd, wc.cwd);
    assert.equal(codex.args[codex.args.indexOf("-C") + 1], wc.cwd);
    const roots = codex.args.find((a) => a.startsWith("sandbox_workspace_write.writable_roots="));
    assert.ok(roots.includes(join(main, ".git", "worktrees")), roots);
    assert.ok(roots.includes(join(main, ".git", "objects")), roots);
    assert.equal(roots.includes(`"${main}"`), false);
  } finally {
    t.cleanup();
  }
});

test("an unborn repository, with the project below its top and spaces in the path, gets an orphan worktree", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], { engine: { folderDefault: "own" } });
  try {
    const repo = join(t.base, "my repo");
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(join(repo, "app"));
    writeFileSync(join(repo, "top.txt"), "top\n");
    writeFileSync(join(repo, "app", "a.txt"), "a\n");
    const projectId = t.engine.addProject({ path: join(repo, "app"), name: "app" }).id;
    const r = t.engine.createRoom({ projectId, mode: "build", task: "Build" });
    await done(t.engine, r.id);
    const w = ws(t.engine, r.id);
    assert.equal(w.cwd, join(w.root, "app"));
    assert.equal(t.calls()[0].cwd, w.cwd);
    assert.equal(readFileSync(join(w.root, "top.txt"), "utf8"), "top\n");
    assert.equal(readFileSync(join(w.cwd, "a.txt"), "utf8"), "a\n");
    // Its branch has no commit yet, as the main folder's; everything it starts with is staged, and no commit was made.
    assert.equal(git(w.cwd, "symbolic-ref", "HEAD").trim(), `refs/heads/toryo/${r.id}`);
    assert.throws(() => git(w.cwd, "rev-parse", "--verify", "-q", "HEAD"));
    assert.throws(() => git(repo, "rev-parse", "--verify", "-q", "HEAD"));
    assert.deepEqual(git(w.cwd, "diff", "--cached", "--name-only").trim().split("\n").sort(), ["app/a.txt", "top.txt"]);
    assert.equal(git(w.cwd, "diff"), "");
    assert.equal(git(repo, "status", "--porcelain").trim().split("\n").sort().join(","), "?? app/,?? top.txt");
  } finally {
    t.cleanup();
  }
});

test("a worktree that fails to be made, or that Toryo stopped making, runs nothing; Retry undoes it and makes it again", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], { engine: { folderDefault: "own" } });
  try {
    // A step that fails once.
    let failed = false;
    const e1 = await t.make({ folderDefault: "own", worktreeHooks: { step: (name) => { if (name === "stage" && !failed) { failed = true; throw new Error("the disk is full (test)"); } } } });
    const r = e1.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await waitFor(() => ws(e1, r.id).state === "failed", { label: "failed" });
    assert.match(ws(e1, r.id).error, /the disk is full \(test\)/);
    const q = e1.roomView(r.id).questions.find((x) => x.kind === "workspace");
    assert.ok(q, "the room asks to retry");
    assert.equal(q.recommendation, "Retry");
    assert.equal(t.calls().length, 0, "no agent ran");
    e1.answer(r.id, { accept: true, questionId: q.id });
    await done(e1, r.id);
    assert.equal(t.calls()[0].cwd, ws(e1, r.id).cwd);
    assert.equal(git(t.repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 2, "the main folder and this room's, once");

    // Toryo stopping while it writes the files: after the restart, nothing runs until it's made again.
    const e2 = await t.make({ folderDefault: "own", worktreeHooks: { step: (name) => (name === "files" ? new Promise(() => {}) : undefined) } });
    const s = e2.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await waitFor(() => git(t.repo, "worktree", "list").includes(s.id), { label: "registered" });
    const e3 = await t.make({ folderDefault: "own" });
    const view = ws(e3, s.id);
    assert.equal(view.state, "failed");
    assert.equal(view.error, "Toryo stopped while it was making it");
    const q3 = e3.roomView(s.id).questions.find((x) => x.kind === "workspace");
    assert.ok(q3);
    const calls = t.calls().length;
    e3.answer(s.id, { accept: true, questionId: q3.id });
    await ready(e3, s.id);
    await waitFor(() => t.calls().length === calls + 1, { label: "builder ran" });
    assert.equal(t.calls().at(-1).cwd, ws(e3, s.id).cwd);
    assert.equal(git(t.repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 3);
  } finally {
    t.cleanup();
  }
});

test("undoing an unfinished worktree removes only what this attempt provably made, after checking it all; anything else, or unclear, is left", async () => {
  const base = mkdtempSync(join(tmpdir(), "toryo-undo-"));
  try {
    const repo = join(base, "repo");
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    commit(repo, "init");
    const start = git(repo, "rev-parse", "HEAD").trim();
    const listed = () => git(repo, "worktree", "list", "--porcelain");
    const branch = (b) => git(repo, "for-each-ref", "--format=%(objectname)", `refs/heads/${b}`).trim() || null;
    const lock = (name, token = "tok") => ["--lock", "--reason", lockReason(name, token)];
    // As Toryo makes one: locked with this attempt's reason, on its own new branch.
    const ours = (name, from = start) => git(repo, "worktree", "add", "-q", "--no-checkout", ...lock(name), "-b", `toryo/${name}`, join(base, name), from);
    const undo = (name, extra = {}) => undoWorktree({ source: repo, path: join(base, name), branch: `toryo/${name}`, start, workspaceId: name, token: "tok", ...extra });
    const kept = (name) => assert.ok(listed().includes(join(base, name)), `${name} is still registered`);

    // Not made for this attempt: someone's worktree at the path (on its branch, even named like this room's), or one
    // made by an earlier attempt.
    git(repo, "worktree", "add", "-q", "-b", "toryo/w1", join(base, "w1"));
    assert.match((await undo("w1")).reason, /wasn't made by Toryo for this room; Toryo leaves it/);
    kept("w1");
    ours("w2");
    assert.match((await undo("w2", { token: "older" })).reason, /wasn't made by Toryo for this room/);
    kept("w2");
    // Locked as this attempt's, but on another branch, or with no branch: left.
    git(repo, "worktree", "add", "-q", ...lock("w3"), "-b", "theirs", join(base, "w3"));
    assert.match((await undo("w3")).reason, /on another branch \(theirs\), not this room's/);
    kept("w3");
    git(repo, "worktree", "add", "-q", ...lock("w4"), "--detach", join(base, "w4"));
    assert.match((await undo("w4")).reason, /with no branch, not this room's/);
    kept("w4");
    // This attempt's, but its branch moved, or is gone: left, worktree (and branch).
    ours("w5");
    git(repo, "update-ref", `refs/heads/toryo/w5`, git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit-tree", "-p", start, "-m", "moved", `${start}^{tree}`).trim());
    assert.match((await undo("w5")).reason, /the branch toryo\/w5 isn't where Toryo started it \(it has moved\)/);
    kept("w5");
    ours("w6");
    git(repo, "update-ref", "-d", "refs/heads/toryo/w6");
    assert.match((await undo("w6")).reason, /isn't where Toryo started it \(it's gone\)/);
    kept("w6");
    // An unregistered folder at the path: not this room's.
    mkdirSync(join(base, "w7"));
    assert.match((await undo("w7")).reason, /there's a folder at .*w7 that isn't this room's worktree/);
    assert.ok(existsSync(join(base, "w7")));
    // Nothing registered there: nothing was made, and a branch of that name (someone else's, made between Toryo's
    // check and Git's) is never touched, even where Toryo's would have started.
    git(repo, "branch", "toryo/w8");
    assert.deepEqual(await undo("w8"), { ok: true });
    assert.equal(branch("toryo/w8"), start);

    // This attempt's own, unchanged: removed, worktree and branch. Also with its folder gone, and without pruning
    // another worktree whose folder is gone too.
    ours("w9");
    assert.deepEqual(await undo("w9"), { ok: true });
    assert.equal(listed().includes(join(base, "w9")), false);
    assert.equal(existsSync(join(base, "w9")), false);
    assert.equal(branch("toryo/w9"), null);
    ours("w10");
    git(repo, "worktree", "add", "-q", "-b", "stale", join(base, "w11"));
    rmSync(join(base, "w10"), { recursive: true, force: true });
    rmSync(join(base, "w11"), { recursive: true, force: true });
    assert.deepEqual(await undo("w10"), { ok: true });
    assert.equal(listed().includes(join(base, "w10")), false);
    kept("w11");
    // An orphan worktree of an unborn repository: its branch has no commit, as expected; a broken reference for it
    // can't be read, so it's left.
    const unborn = join(base, "unborn");
    execFileSync("git", ["init", "-q", unborn]);
    const orphan = (name) => git(unborn, "worktree", "add", "-q", "--orphan", ...lock(name), "-b", `toryo/${name}`, join(base, name));
    const undoOrphan = (name) => undoWorktree({ source: unborn, path: join(base, name), branch: `toryo/${name}`, start: null, workspaceId: name, token: "tok" });
    orphan("o1");
    mkdirSync(join(unborn, ".git", "refs", "heads", "toryo"), { recursive: true });
    writeFileSync(join(unborn, ".git", "refs", "heads", "toryo", "o1"), "not a commit\n");
    assert.match((await undoOrphan("o1")).reason, /with no branch|Git couldn't read the branch/);
    assert.ok(git(unborn, "worktree", "list").includes(join(base, "o1")));
    // A branch Git can't read (Git stands in here, failing that one lookup) isn't taken for "no commit": left.
    const bin = join(base, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = for-each-ref ] && { echo "fatal: can't read refs (test)" >&2; exit 128; }; done\nexec ${realGit} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    orphan("o3");
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      assert.match((await undoOrphan("o3")).reason, /Git couldn't read the branch toryo\/o3 \(fatal: can't read refs \(test\)\); Toryo leaves it and its worktree/);
    } finally {
      process.env.PATH = path;
    }
    assert.ok(git(unborn, "worktree", "list").includes(join(base, "o3")));
    orphan("o2");
    assert.deepEqual(await undoOrphan("o2"), { ok: true });
    assert.equal(existsSync(join(base, "o2")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a folder or branch already where the worktree goes is left alone, and the room says so", async () => {
  const t = await setup([], { engine: { folderDefault: "own" } });
  try {
    const preview = t.engine.previewWorkspace("repo");
    mkdirSync(preview.own.root, { recursive: true });
    writeFileSync(join(preview.own.root, "mine.txt"), "someone's\n");
    const r = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build", folder: "own", roomId: preview.roomId });
    assert.equal(r.id, preview.roomId);
    await waitFor(() => ws(t.engine, r.id).state === "failed", { label: "failed" });
    assert.match(ws(t.engine, r.id).error, /^there's already something at /);
    // Retrying doesn't remove a folder that isn't this room's worktree.
    t.engine.answer(r.id, { accept: true, questionId: t.engine.roomView(r.id).questions[0].id });
    await waitFor(() => ws(t.engine, r.id).state === "failed" && t.engine.roomView(r.id).questions.length, { label: "failed again" });
    assert.match(ws(t.engine, r.id).error, /isn't this room's worktree/);
    assert.equal(readFileSync(join(preview.own.root, "mine.txt"), "utf8"), "someone's\n");
    // The same id twice: refused.
    assert.throws(() => t.engine.createRoom({ projectId: "repo", mode: "build", task: "Again", folder: "own", roomId: preview.roomId }), /exists already/);

    const p2 = t.engine.previewWorkspace("repo");
    git(t.repo, "branch", p2.own.branch);
    const tip = git(t.repo, "rev-parse", p2.own.branch);
    const s = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build", folder: "own", roomId: p2.roomId });
    await waitFor(() => ws(t.engine, s.id).state === "failed", { label: "failed" });
    assert.match(ws(t.engine, s.id).error, /the branch toryo\/\S+ already exists/);
    assert.equal(git(t.repo, "rev-parse", p2.own.branch), tip);
    // Retrying never removes a branch that was there before (even one where Toryo's would start): it's refused again.
    t.engine.answer(s.id, { accept: true, questionId: t.engine.roomView(s.id).questions[0].id });
    await waitFor(() => t.engine.roomView(s.id).questions.length, { label: "failed again" });
    assert.match(ws(t.engine, s.id).error, /the branch toryo\/\S+ already exists/);
    assert.equal(git(t.repo, "rev-parse", p2.own.branch), tip);
    // A branch someone makes between Toryo's check and Git's: Git refuses, and Retry leaves that branch.
    const e2 = await t.make({ folderDefault: "own", worktreeHooks: { step: (name) => name === "add" && git(t.repo, "branch", `toryo/${raced}`) } });
    const p4 = e2.previewWorkspace("repo");
    const raced = p4.roomId;
    const r4 = e2.createRoom({ projectId: "repo", mode: "build", task: "Build", folder: "own", roomId: p4.roomId });
    await waitFor(() => ws(e2, r4.id).state === "failed", { label: "refused by Git" });
    assert.match(ws(e2, r4.id).error, /Git couldn't make the worktree: .*already exists/);
    const racedTip = git(t.repo, "rev-parse", `toryo/${raced}`);
    e2.answer(r4.id, { accept: true, questionId: e2.roomView(r4.id).questions[0].id });
    await waitFor(() => e2.roomView(r4.id).questions.length, { label: "failed again" });
    assert.match(ws(e2, r4.id).error, /the branch toryo\/\S+ already exists/);
    assert.equal(git(t.repo, "rev-parse", `toryo/${raced}`), racedTip, "the other branch is left");
    // The folder shown before starting is the one a room gets, or it doesn't start.
    const p3 = t.engine.previewWorkspace("repo");
    assert.throws(() => t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build", folder: "own", roomId: p3.roomId, workspacePath: preview.own.path }), (err) => err.status === 409 && /isn't the one this build would get/.test(err.message));
    assert.equal(t.calls().length, 0);
  } finally {
    t.cleanup();
  }
});

test("links pointing outside are kept as links, and nothing is written through them", async () => {
  const t = await setup([{ agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: OWNER Done?" }], { engine: { folderDefault: "own" } });
  try {
    const outside = mkdtempSync(join(tmpdir(), "toryo-outside-"));
    symlinkSync(outside, join(t.repo, "out"));
    symlinkSync("../../elsewhere/secret", join(t.repo, "up"));
    const r = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build" });
    await done(t.engine, r.id);
    const w = ws(t.engine, r.id);
    assert.equal(readlinkSync(join(w.cwd, "out")), outside);
    assert.equal(readlinkSync(join(w.cwd, "up")), "../../elsewhere/secret");
    assert.deepEqual(readdirSync(outside), []);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    t.cleanup();
  }
});

/**
 * A stand-in Codex app (as in appthread.test.mjs): a codex.exe whose `queue` logs the thread and finishes the turn in
 * its session log at once, and the app's thread list (state_5.sqlite) with the folder each thread was opened in.
 */
async function fakeApp(base, threads) {
  const home = join(base, "codex-home");
  const day = join(home, "sessions", "2026", "10", "14");
  mkdirSync(day, { recursive: true });
  for (const id of Object.keys(threads)) writeFileSync(join(day, `rollout-2026-10-14T00-00-00-${id}.jsonl`), "");
  const log = join(base, "queued.log");
  const exe = join(base, "codex.exe");
  writeFileSync(
    exe,
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const thread = a[a.indexOf("--thread") + 1];
const msg = a[a.indexOf("--message") + 1];
fs.appendFileSync(${JSON.stringify(log)}, thread + "\\n");
const lines = [{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: msg }] } }, { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Answered.\\nTORYO: REPLY" } }];
const file = fs.readdirSync(${JSON.stringify(day)}).find((n) => n.includes(thread));
fs.appendFileSync(${JSON.stringify(day)} + "/" + file, lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
`,
  );
  chmodSync(exe, 0o755);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("create table threads (id text, name text, preview text, cwd text, updated_at_ms integer, archived integer, source text)");
  // A thread given no folder (undefined) has a session log but isn't in the list.
  for (const [id, cwd] of Object.entries(threads)) if (cwd !== undefined) db.prepare("insert into threads values (?, ?, '', ?, 0, 0, 'vscode')").run(id, id, cwd);
  db.close();
  const move = (id, cwd) => {
    const d = new DatabaseSync(join(home, "state_5.sqlite"));
    d.prepare("update threads set cwd = ? where id = ?").run(cwd, id);
    d.close();
  };
  return { cfg: { exe, codexHome: home, openThread: "never", pollMs: 50 }, queued: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []), move };
}

test("the Codex app stays in the project's folder, and gets nothing when its thread works in another folder", async () => {
  const t = await setup([], { engine: { folderDefault: "own" } });
  // The thread's folder is a WSL path from Windows: Toryo runs in that distribution here, whatever this machine is.
  const was = process.env.WSL_DISTRO_NAME;
  process.env.WSL_DISTRO_NAME = "Ubuntu";
  try {
    const thread = "0aaaaaaa-0000-0000-0000-00000000000a";
    const elsewhere = join(t.base, "elsewhere");
    mkdirSync(elsewhere);
    // The app records a WSL folder the Windows way.
    const app = await fakeApp(t.base, { [thread]: `\\\\wsl.localhost\\Ubuntu${elsewhere.replace(/\//g, "\\")}` });
    const e = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: { ...ADAPTERS.codexapp, detect: async () => ({ installed: true }), currentLimits: () => null } } });
    await e.init({ detect: false });
    e.updateConfig({ agents: { codexapp: app.cfg } });
    // A crew with the Codex app can't have its own worktree; by default it builds in the project's folder.
    assert.throws(() => e.createRoom({ projectId: "repo", mode: "build", members: ["codexapp", "claude"], builder: "codexapp", task: "x", appThread: thread, folder: "own" }), /The Codex app works in the project's own folder only/);
    const chat = e.createRoom({ projectId: "repo", mode: "chat", members: ["codexapp"], appThread: thread, text: "Hello?", to: "codexapp" });
    assert.equal(chat.workspace.kind, "shared");
    // Tried twice (a failed turn is tried once more), then the room asks.
    await waitFor(() => !e.running.size && e.roomView(chat.id).questions.some((x) => x.kind === "error"), { label: "asked to retry" });
    const failedTurn = turns(e, chat.id).find((x) => x.state === "failed");
    assert.match(failedTurn.error, new RegExp(`works in ${elsewhere}, not in this room's folder`));
    assert.deepEqual(app.queued(), [], "nothing was sent to the app");
    // A folder this machine doesn't have can't be checked: refused too.
    app.move(thread, join(t.base, "not-here"));
    e.answer(chat.id, { accept: true, questionId: e.roomView(chat.id).questions[0].id });
    await waitFor(() => !e.running.size && e.roomView(chat.id).questions.some((x) => x.kind === "error"), { label: "refused again" });
    assert.match(turns(e, chat.id).filter((x) => x.state === "failed").at(-1).error, /not-here, which isn't a folder on this machine, so Toryo can't check it's this room's folder/);
    assert.deepEqual(app.queued(), []);
    // A thread opened in this folder gets the message.
    app.move(thread, t.repo);
    e.answer(chat.id, { accept: true, questionId: e.roomView(chat.id).questions[0].id });
    await waitFor(() => app.queued().length === 1, { label: "sent" });
    await waitFor(() => turns(e, chat.id).some((x) => x.state === "done"), { label: "answered" });
    e.shutdown();
  } finally {
    if (was === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = was;
    t.cleanup();
  }
});

test("a thread whose folder Toryo can't tell gets nothing: not listed, no folder, the list unreadable, another WSL distribution, a path it can't find", async () => {
  const t = await setup([]);
  const was = process.env.WSL_DISTRO_NAME;
  process.env.WSL_DISTRO_NAME = "Ubuntu";
  try {
    const listed = "0aaaaaaa-0000-0000-0000-00000000000a";
    const unlisted = "0bbbbbbb-0000-0000-0000-00000000000b";
    const app = await fakeApp(t.base, { [listed]: t.repo, [unlisted]: undefined });
    const send = async (thread) => {
      const turnDir = mkdtempSync(join(t.base, "turn-"));
      // The engine's check: the room's folder only.
      return ADAPTERS.codexapp.run({ cfg: { ...app.cfg, thread }, prompt: "Hi.", sessionId: thread, turnDir, folderProblem: (p) => (p === t.repo ? null : `works in ${p}`), timeoutMs: 20_000 });
    };
    const refused = async (thread, why) => {
      const r = await send(thread);
      assert.match(r.error, why);
      assert.match(r.error, /Toryo sent it nothing/);
    };
    await refused(unlisted, /the Codex app doesn't list this thread/);
    app.move(listed, "");
    await refused(listed, /the Codex app doesn't record a folder for this thread/);
    app.move(listed, `\\\\wsl.localhost\\Debian${t.repo.replace(/\//g, "\\")}`);
    await refused(listed, /is in another WSL distribution \(Debian; Toryo runs in Ubuntu\)/);
    app.move(listed, "projects\\mine");
    await refused(listed, /isn't a path Toryo can find here/);
    writeFileSync(join(app.cfg.codexHome, "state_5.sqlite"), "not a database");
    await refused(listed, /Toryo couldn't read the Codex app's list of threads/);
    rmSync(join(app.cfg.codexHome, "state_5.sqlite"));
    await refused(listed, /the Codex app's list of threads isn't there/);
    assert.deepEqual(app.queued(), [], "nothing was queued");
  } finally {
    if (was === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = was;
    t.cleanup();
  }
});

test("the Codex app can't join a room with its own worktree, being made or ready; one saved with it gets nothing", async () => {
  const t = await setup([{ agent: "codex", reply: "Built.\nTORYO: OWNER Done?" }]);
  try {
    let sent = 0;
    const app = { ...ADAPTERS.codexapp, detect: async () => ({ installed: true }), currentLimits: () => null, run: async () => (sent++, { text: "Hi.\nTORYO: REPLY" }) };
    let release;
    const e = new Engine({ store: new Store(t.home), snapshots: new Snapshots(t.home), notifier: { send() {} }, adapters: { ...ADAPTERS, codexapp: app }, worktreeHooks: { step: (name) => (name === "files" ? new Promise((r) => (release = r)) : undefined) } });
    await e.init({ detect: false });
    e.updateConfig({ agents: { codexapp: { thread: "t-1" } } });
    const r = e.createRoom({ projectId: "repo", mode: "build", members: ["codex", "claude"], task: "Build" });
    await waitFor(() => release, { label: "being made" });
    const addApp = () => e.control(r.id, "members", { members: ["codex", "claude", "codexapp"], appThread: "t-1" });
    assert.throws(addApp, /The Codex app works in the project's own folder only, and this room works in its own worktree/);
    release();
    await ready(e, r.id);
    assert.throws(addApp, /can't join this crew/);
    assert.deepEqual(e.roomView(r.id).room.crew.members, ["codex", "claude"]);
    // A refused change changes nothing: replacing an agent that has work queued keeps that agent, and its work.
    const swapping = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex", "claude", "cursor"] });
    e.control(swapping.id, "pause");
    e.postMessage(swapping.id, { text: "For Cursor.", to: "cursor" });
    const before = e.roomView(swapping.id).room.queue.map((q) => q.agent);
    assert.ok(before.includes("cursor"));
    e.updateConfig({ agents: { codexapp: { thread: null } } });
    assert.throws(() => e.control(swapping.id, "members", { members: ["codex", "claude", "codexapp"] }), /Choose the Codex app thread/);
    assert.deepEqual(e.roomView(swapping.id).room.crew.members, ["codex", "claude", "cursor"]);
    assert.deepEqual(e.roomView(swapping.id).room.queue.map((q) => q.agent), before);
    assert.equal(e.roomView(swapping.id).room.sessions.codexapp, undefined);
    e.updateConfig({ agents: { codexapp: { thread: "t-1" } } });
    // Saved that way anyway (by an older version, say): its turns there fail, and nothing is sent.
    await waitFor(() => !e.running.size && e.roomView(r.id).questions.length, { label: "built" });
    const room = e.rooms.get(r.id);
    room.crew.members.push("codexapp");
    room.sessions.codexapp = "t-1";
    e.postMessage(r.id, { text: "Hello app.", to: "codexapp" });
    await waitFor(() => e.roomView(r.id).questions.some((q) => q.kind === "error"), { label: "refused" });
    assert.match(e.roomView(r.id).questions.find((q) => q.kind === "error").question, /The Codex app works in the project's own folder only/);
    assert.equal(sent, 0);
    e.shutdown();
  } finally {
    t.cleanup();
  }
});

test("worktrees aren't made inside the project's folder: Toryo's data folder there (also through a link) means shared builds", async () => {
  const t = await setup([]);
  try {
    writeFileSync(join(t.repo, ".gitignore"), ".desk/\n");
    symlinkSync(t.repo, join(t.base, "alias"));
    for (const home of [join(t.repo, ".desk"), join(t.base, "alias", ".desk")]) {
      const e = new Engine({ store: new Store(home), snapshots: new Snapshots(home), notifier: { send() {} } });
      await e.init({ detect: false });
      const p = e.addProject({ path: t.repo, name: "repo" }).id;
      assert.throws(() => e.createRoom({ projectId: p, mode: "build", task: "x", folder: "own" }), /inside the project's own folder .*keep Toryo's data folder \(TORYO_HOME\) outside the project/);
      assert.equal(e.previewWorkspace(p).own, null);
      assert.match(e.previewWorkspace(p).why, /inside the project's own folder/);
      const r = e.createRoom({ projectId: p, mode: "build", task: "x" });
      assert.equal(r.workspace.kind, "shared");
      e.control(r.id, "stop");
      e.shutdown();
    }
    assert.equal(existsSync(join(t.repo, ".desk", "worktrees")), false);
  } finally {
    t.cleanup();
  }
});

test("checks, the file viewer, the plan and read-only turns use the room's worktree; a worktree that's gone isn't swapped for the main folder", async () => {
  const t = await setup(
    [
      { agent: "codex", match: "Your role: builder", reply: "Built.\nTORYO: REVIEW Slice 1: One | h.md", write: { path: "room.txt", content: "from the room\n" }, times: 1 },
      { agent: "claude", reply: "Changes.\nTORYO: CHANGES" , times: 1 },
      { agent: "codex", reply: "Fixed.\nTORYO: OWNER Done?" },
    ],
    { gates: [{ name: "where", command: "pwd; cat room.txt" }], engine: { folderDefault: "own" } },
  );
  try {
    mkdirSync(join(t.repo, "docs", "plans"), { recursive: true });
    writeFileSync(join(t.repo, "docs", "plans", "p.md"), "# Plan\n\n### Slice 1: One\n\nDo one.\n");
    const r = t.engine.createRoom({ projectId: "repo", mode: "build", task: "Build", planPath: "docs/plans/p.md" });
    await waitFor(() => t.engine.roomView(r.id).questions.length, { label: "asked" });
    const w = ws(t.engine, r.id);
    // The checks ran in the worktree.
    const gate = t.engine.roomView(r.id).events.find((e) => e.type === "gate");
    assert.match(gate.results[0].output, new RegExp(`${w.cwd}\\n+from the room`));
    // The reviewer read the worktree, read-only.
    const review = t.calls().find((c) => c.kind === "claude");
    assert.equal(review.cwd, w.cwd);
    // Files and the plan: the worktree's, even after the main folder's change.
    writeFileSync(join(t.repo, "docs", "plans", "p.md"), "# Plan\n\n### Slice 1: One\n\n### Slice 2: Two\n");
    writeFileSync(join(t.repo, "README.md"), "# main changed\n");
    assert.equal(t.engine.readRoomFile(r.id, "README.md").content, "# test repo\n");
    assert.equal(t.engine.readProjectFile("repo", "README.md").content, "# main changed\n");
    assert.equal(t.engine.readRoomFile(r.id, "room.txt").content, "from the room\n");
    assert.deepEqual(t.engine.planView(r.id).slices.map((s) => s.name), ["One"]);
    assert.throws(() => t.engine.readRoomFile(r.id, "../repo/README.md"), /outside/);

    // The worktree is removed behind Toryo's back: the next turn fails, and nothing runs in the main folder.
    const calls = t.calls().length;
    rmSync(w.root, { recursive: true, force: true });
    const q = t.engine.roomView(r.id).questions[0];
    t.engine.answer(r.id, { text: "Carry on.", questionId: q.id });
    await waitFor(() => t.engine.roomView(r.id).events.some((e) => e.type === "turn" && e.state === "failed") || t.engine.roomView(r.id).questions.some((x) => x.kind === "error"), { label: "failed" });
    await waitFor(() => t.engine.roomView(r.id).questions.some((x) => x.kind === "error"), { label: "error asked" });
    assert.match(t.engine.roomView(r.id).questions.find((x) => x.kind === "error").question, /isn't there; Toryo won't run the turn in the project's main folder/);
    assert.equal(t.calls().length, calls);
    assert.throws(() => t.engine.readRoomFile(r.id, "README.md"), /This room's worktree .* is missing/);
  } finally {
    t.cleanup();
  }
});

test("choosing where a build works: defaults, a room moving to its own worktree, and what's refused", async () => {
  const t = await setup([{ agent: "codex", reply: "Hi.\nTORYO: REPLY" }], { engine: { folderDefault: "own" } });
  try {
    // A folder outside Git: shared only.
    const plain = mkdtempSync(join(tmpdir(), "toryo-plain-"));
    const pid = t.engine.addProject({ path: plain, name: "plain" }).id;
    assert.throws(() => t.engine.createRoom({ projectId: pid, mode: "build", task: "x", folder: "own" }), /isn't in a Git repository, so a room can't have a worktree/);
    const plainRoom = t.engine.createRoom({ projectId: pid, mode: "build", task: "x" });
    assert.equal(plainRoom.workspace.kind, "shared");
    t.engine.control(plainRoom.id, "stop");
    assert.equal(t.engine.previewWorkspace(pid).own, null);
    assert.throws(() => t.engine.createRoom({ projectId: "repo", mode: "build", task: "x", folder: "elsewhere" }), /Choose where it works/);

    // A room that exists stays where it is unless you choose its own worktree (a chat room's first build too).
    const stays = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], text: "Hello", to: "codex" });
    await done(t.engine, stays.id);
    assert.equal(t.engine.roomWorkspace(stays.id).defaultFolder, "shared");
    t.engine.startBuild(stays.id, { task: "Build" });
    assert.equal(ws(t.engine, stays.id).kind, "main");
    t.engine.control(stays.id, "stop");
    await waitFor(() => !t.engine.running.size, { label: "stopped" });
    // Asked: it moves to its own worktree, and its agents start fresh there.
    const chat = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], text: "Hello", to: "codex" });
    await done(t.engine, chat.id);
    const shown = t.engine.roomWorkspace(chat.id).own;
    t.engine.startBuild(chat.id, { task: "Build", folder: "own", workspacePath: shown.path });
    const moved = ws(t.engine, chat.id);
    assert.equal(moved.cwd, shown.path);
    assert.equal(moved.kind, "worktree");
    await waitFor(() => t.calls().some((c) => c.cwd === moved.cwd), { label: "built" });
    const builder = t.calls().find((c) => c.cwd === moved.cwd);
    assert.equal(builder.cwd, moved.cwd);
    assert.equal(builder.args.includes("resume"), false, "a new session in the new folder");
    assert.match(builder.prompt, /This room now works in its own worktree, a different folder/);
    // It stays there.
    assert.throws(() => t.engine.startBuild(chat.id, { task: "Again", folder: "shared" }), /stays there/);
    assert.equal(t.engine.roomWorkspace(chat.id).fixed, true);
    t.engine.control(chat.id, "stop");

    // A room that built in the project's folder stays there by default.
    const shared = t.engine.createRoom({ projectId: "repo", mode: "build", task: "x", folder: "shared" });
    assert.equal(shared.workspace.kind, "shared");
    t.engine.control(shared.id, "stop");
    assert.equal(t.engine.roomWorkspace(shared.id).defaultFolder, "shared");

    // A room with a turn running doesn't move: not when asked, and not by default (it stays, and its turn with it).
    const script = JSON.parse(readFileSync(process.env.FAKE_SCRIPT, "utf8"));
    script.rules.unshift({ agent: "codex", match: "Hang on", hang: true });
    writeFileSync(process.env.FAKE_SCRIPT, JSON.stringify(script));
    const busy = t.engine.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], text: "Hang on", to: "codex" });
    await waitFor(() => turns(t.engine, busy.id).some((e) => e.state === "running"), { label: "running" });
    assert.throws(() => t.engine.startBuild(busy.id, { task: "x", folder: "own" }), /has work going on in its folder/);
    assert.equal(ws(t.engine, busy.id).kind, "main");
    t.engine.startBuild(busy.id, { task: "x", wait: true });
    assert.equal(ws(t.engine, busy.id).kind, "main");
    t.engine.control(busy.id, "stop");
    rmSync(plain, { recursive: true, force: true });
  } finally {
    t.cleanup();
  }
});

test("where a room works shows in its summary, on Home, in toryo status and through MCP", async () => {
  await withServer([{ agent: "codex", reply: "Built.\nTORYO: OWNER Done?" }], async ({ engine, client, home }) => {
    const said = await client.start({ mode: "build", text: "Build it", folder: "own" });
    const room = engine.state().rooms[0];
    await waitFor(() => engine.state().rooms[0].workspace.state === "ready", { label: "ready" });
    const w = engine.state().rooms[0].workspace;
    assert.match(said, new RegExp(`It works in its own worktree: ${w.path} \\(branch toryo/${room.id}\\)`));
    assert.equal(w.kind, "worktree");
    assert.equal(w.main, engine.project("repo").path);
    const onHome = engine.home().rooms.concat(engine.home().working).find((x) => (x.id ?? x.room) === room.id);
    assert.equal(onHome.workspace.kind, "worktree");
    assert.equal(onHome.folder, w.path);
    assert.match(await client.statusText(), new RegExp(`own worktree: ${w.path}, branch toryo/${room.id}; main folder `));
    assert.match(await client.roomText(room.id), /^Own worktree: /m);
    // A shared folder shows the other rooms using it.
    await client.start({ mode: "chat", text: "Hello" });
    await client.start({ mode: "chat", text: "Hello again" });
    assert.match(await client.statusText(), /shared folder: .*; also used by “Hello/);
    const m = mcp(home);
    try {
      const r = await m.call("toryo_start", { mode: "build", text: "Another", folder: "own" });
      assert.match(r.text, /It works in its own worktree: /);
      const s = await m.call("toryo_start", { mode: "build", text: "Shared one", folder: "shared" });
      assert.doesNotMatch(s.text, /own worktree/);
    } finally {
      m.close();
    }
  });
});
