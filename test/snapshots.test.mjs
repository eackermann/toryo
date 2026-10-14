import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshots } from "../src/snapshots.mjs";
import { setup, turns, waitFor } from "./helpers.mjs";

/** A disposable repository, with its first commit (unless `unborn`). */
function repo(base, name, { unborn = false } = {}) {
  const path = join(base, name);
  git(base, "init", "-q", path);
  git(path, "config", "user.email", "t@t");
  git(path, "config", "user.name", "t");
  if (!unborn) {
    writeFileSync(join(path, "README.md"), "# readme\n");
    git(path, "add", ".");
    git(path, "commit", "-qm", "init");
  }
  return path;
}
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const shadow = (snaps, project, ...args) => execFileSync("git", ["--git-dir", snaps.gitDir(project), ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
/** The snapshot's files: { path: { mode, size, content } }. */
function files(snaps, project, tree) {
  const out = {};
  for (const line of shadow(snaps, project, "ls-tree", "-r", "-l", "-z", tree).toString().split("\0").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    const [mode, , oid, size] = meta.split(/\s+/);
    out[path] = { mode, size: Number(size), blob: oid };
  }
  return out;
}
const blob = (snaps, project, oid) => shadow(snaps, project, "cat-file", "blob", oid);

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "toryo-snap-"));
  return { base, home: join(base, "home"), done: () => rmSync(base, { recursive: true, force: true }) };
}

test("a snapshot holds the working files exactly: staged and unstaged edits, untracked files, deletions, modes, links, binaries and large files; ignored files stay out; the project's index, HEAD and branches are untouched", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "work");
    writeFileSync(join(path, "a.txt"), "v1\n");
    writeFileSync(join(path, "run.sh"), "echo hi\n");
    writeFileSync(join(path, "gone.txt"), "bye\n");
    writeFileSync(join(path, "big.bin"), "small\n");
    writeFileSync(join(path, ".gitignore"), "secret.env\n");
    git(path, "add", ".");
    git(path, "commit", "-qm", "files");
    // Staged v2, then v3 on top unstaged: the working file is v3.
    writeFileSync(join(path, "a.txt"), "v2\n");
    git(path, "add", "a.txt");
    writeFileSync(join(path, "a.txt"), "v3\n");
    writeFileSync(join(path, "new.txt"), "new\n");
    writeFileSync(join(path, "secret.env"), "TOKEN=x\n");
    unlinkSync(join(path, "gone.txt"));
    chmodSync(join(path, "run.sh"), 0o755);
    symlinkSync("a.txt", join(path, "link"));
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    writeFileSync(join(path, "bytes.dat"), bytes);
    writeFileSync(join(path, "big.bin"), Buffer.alloc(21 * 1024 * 1024, 7));
    // (`git status` itself can refresh the index: it runs first, and the index is read after it.)
    const status = git(path, "status", "--porcelain");
    const before = { index: readFileSync(join(path, ".git", "index")), head: git(path, "rev-parse", "HEAD"), refs: git(path, "for-each-ref"), status };
    // A file written again with the same contents: Git, reading the folder, would want to refresh its index entry.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(path, "README.md"), "# readme\n");
    const snaps = new Snapshots(s.home);
    const project = { id: "work", path };
    const r = await snaps.capture(project, "test");
    assert.equal(r.ok, true, r.reason);
    const f = files(snaps, project, r.tree);
    assert.equal(blob(snaps, project, f["a.txt"].blob).toString(), "v3\n");
    assert.equal(blob(snaps, project, f["new.txt"].blob).toString(), "new\n");
    assert.equal(f["secret.env"], undefined, "ignored: left out");
    assert.equal(f["gone.txt"], undefined, "deleted");
    assert.equal(f["run.sh"].mode, "100755");
    assert.deepEqual([f.link.mode, blob(snaps, project, f.link.blob).toString()], ["120000", "a.txt"]);
    assert.ok(blob(snaps, project, f["bytes.dat"].blob).equals(bytes));
    assert.equal(f["big.bin"].size, 21 * 1024 * 1024, "the whole of a file over 20 MB");
    assert.equal(f["README.md"].size, 9);
    // Nothing of the project's own Git changed.
    assert.ok(readFileSync(join(path, ".git", "index")).equals(before.index), "the project's index, byte for byte");
    assert.deepEqual([git(path, "rev-parse", "HEAD"), git(path, "for-each-ref"), git(path, "status", "--porcelain")], [before.head, before.refs, before.status]);
    // The engine's way still works: take, changes, diff.
    const again = await snaps.take(project, "again");
    assert.equal(again.tree, r.tree);
    writeFileSync(join(path, "a.txt"), "v4\n");
    const later = await snaps.take(project, "later");
    assert.deepEqual(await snaps.changes(project, again.commit, later.commit), [{ status: "M", path: "a.txt" }]);
    assert.match(await snaps.diff(project, again.commit, later.commit, "a.txt"), /-v3\n\+v4/);
  } finally {
    s.done();
  }
});

test("an unborn repository, and a project below its repository's top, are taken whole", async () => {
  const s = scratch();
  try {
    const snaps = new Snapshots(s.home);
    // No commit yet: staged and untracked files.
    const unborn = repo(s.base, "unborn", { unborn: true });
    writeFileSync(join(unborn, "staged.txt"), "s\n");
    git(unborn, "add", "staged.txt");
    writeFileSync(join(unborn, "loose.txt"), "l\n");
    const u = await snaps.capture({ id: "unborn", path: unborn }, "test");
    assert.equal(u.ok, true, u.reason);
    assert.deepEqual(Object.keys(files(snaps, { id: "unborn", path: unborn }, u.tree)).sort(), ["loose.txt", "staged.txt"]);
    // A project in a folder of the repository: the snapshot is the repository's working files, all of them.
    const path = repo(s.base, "mono");
    mkdirSync(join(path, "app"));
    mkdirSync(join(path, "lib"));
    writeFileSync(join(path, "app", "main.js"), "1\n");
    writeFileSync(join(path, "lib", "util.js"), "2\n");
    const below = { id: "app", path: join(path, "app") };
    const b = await snaps.capture(below, "test");
    assert.equal(b.ok, true, b.reason);
    assert.deepEqual(Object.keys(files(snaps, below, b.tree)).sort(), ["README.md", "app/main.js", "lib/util.js"]);
  } finally {
    s.done();
  }
});

test("two workspaces of one project (its folder and a linked worktree) keep their own snapshots, index and reference", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "main");
    const wt = join(s.base, "room-1");
    git(path, "worktree", "add", "-q", "-b", "room-1", wt);
    writeFileSync(join(path, "only-main.txt"), "m\n");
    writeFileSync(join(wt, "only-room.txt"), "r\n");
    const snaps = new Snapshots(s.home);
    const project = { id: "main", path };
    const [m, w] = await Promise.all([snaps.capture(project, "main"), snaps.capture(project, "room", { id: "room-1", path: wt })]);
    assert.ok(m.ok && w.ok);
    assert.deepEqual(Object.keys(files(snaps, project, m.tree)).sort(), ["README.md", "only-main.txt"]);
    assert.deepEqual(Object.keys(files(snaps, project, w.tree)).sort(), ["README.md", "only-room.txt"]);
    assert.equal(shadow(snaps, project, "rev-parse", "refs/toryo/latest").toString().trim(), m.commit);
    assert.equal(shadow(snaps, project, "rev-parse", "refs/toryo/ws/room-1/latest").toString().trim(), w.commit);
    assert.deepEqual([m.workspace.id, w.workspace.id], ["main", "room-1"]);
    // A room's starting point, pinned: it stays named whatever comes after.
    assert.equal(await snaps.pin(project, "room-1-base", w.commit), true);
    await snaps.capture(project, "later", { id: "room-1", path: wt });
    assert.equal(await snaps.pinned(project, "room-1-base"), w.commit);
  } finally {
    s.done();
  }
});

test("a project's first snapshots, taken in several of its workspaces at once, make its shadow repository once", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "main");
    const rooms = [1, 2, 3, 4, 5].map((n) => {
      const wt = join(s.base, `room-${n}`);
      git(path, "worktree", "add", "-q", "-b", `room-${n}`, wt);
      return { id: `room-${n}`, path: wt };
    });
    const snaps = new Snapshots(s.home);
    const project = { id: "main", path };
    // A slow `git init`, as on a busy machine: every capture asks for the shadow repository before it's there. Two
    // `git init`s of one folder at once trip over each other, and the one that lost said the project wasn't in Git.
    const bin = join(s.base, "bin");
    mkdirSync(bin);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" init "*) sleep 0.3;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    try {
      const all = await Promise.all([snaps.capture(project, "main"), ...rooms.map((w) => snaps.capture(project, "room", w))]);
      assert.deepEqual(all.map((r) => r.reason ?? "ok"), Array(6).fill("ok"));
      assert.equal(snaps.failure(project), null);
    } finally {
      process.env.PATH = before;
    }
  } finally {
    s.done();
  }
});

test("files changing while a snapshot is taken: taken again; changing every time, refused with the reason", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "busy");
    writeFileSync(join(path, "log.txt"), "0\n");
    let changes = 0;
    let every = false;
    const snaps = new Snapshots(s.home, {
      hooks: {
        captured: (root, attempt) => {
          if (attempt === 1 || every) writeFileSync(join(root, "log.txt"), `${++changes}\n`);
        },
      },
    });
    const project = { id: "busy", path };
    const once = await snaps.capture(project, "test");
    assert.equal(once.ok, true, once.reason);
    assert.equal(blob(snaps, project, files(snaps, project, once.tree)["log.txt"].blob).toString(), "1\n", "the files as they were once still");
    every = true;
    const always = await snaps.capture(project, "test");
    assert.deepEqual([always.ok, always.reason], [false, "files kept changing while Toryo took the snapshot"]);
    assert.equal(await snaps.take(project, "test"), null);
    assert.equal(snaps.failure(project), "files kept changing while Toryo took the snapshot");
  } finally {
    s.done();
  }
});

test("a repository a snapshot can't reproduce is refused with the reason, as is a missing folder or one outside Git", async () => {
  const s = scratch();
  try {
    const snaps = new Snapshots(s.home);
    const refused = async (name, prepare, pattern) => {
      const path = repo(s.base, name);
      prepare(path);
      const r = await snaps.capture({ id: name, path }, "test");
      assert.equal(r.ok, false, name);
      assert.equal(r.unsupported, true, name);
      assert.match(r.reason, pattern, name);
    };
    await refused("submodule", (p) => git(p, "update-index", "--add", "--cacheinfo", `160000,${git(p, "rev-parse", "HEAD").trim()},vendored`), /it has submodules/);
    await refused("sparse", (p) => git(p, "config", "core.sparseCheckout", "true"), /sparse checkout/);
    await refused("skip", (p) => git(p, "update-index", "--skip-worktree", "README.md"), /^Git is told to skip a file \(README\.md\), which may not be in the folder/);
    await refused("nested", (p) => {
      git(p, "init", "-q", join(p, "vendor"));
      writeFileSync(join(p, "vendor", "lib.js"), "x\n");
    }, /^there's a repository inside the folder that Git doesn't track \(vendor\/\)/);
    const missing = await snaps.capture({ id: "gone", path: join(s.base, "gone") }, "test", { id: "room", path: join(s.base, "nowhere") });
    assert.deepEqual([missing.ok, missing.reason], [false, `the folder ${join(s.base, "nowhere")} isn't there`]);
    mkdirSync(join(s.base, "plain"));
    const plain = await snaps.capture({ id: "plain", path: join(s.base, "plain") }, "test");
    assert.deepEqual([plain.ok, plain.reason], [false, "the project's folder isn't in a Git repository, so Toryo can't take snapshots of it"]);
  } finally {
    s.done();
  }
});

test("a room keeps its workspace (its project's own folder until rooms get their own), and a snapshot that can't be taken is said in the room once", async () => {
  const t = await setup([{ agent: "codex", reply: "Hi.\nTORYO: REPLY" }]);
  let e = t.engine;
  try {
    const room = e.createRoom({ projectId: "repo", mode: "chat", members: ["codex"], title: "Chat" });
    const root = execFileSync("git", ["-C", t.repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    assert.deepEqual(e.rooms.get(room.id).workspace, { id: "main", kind: "main", root, subdir: "" });
    // A room saved before workspaces gets its project's folder at the next start.
    e.shutdown();
    const saved = e.store.loadRoom(room.id);
    delete saved.workspace;
    e.store.saveRoom(saved);
    e = await t.make();
    assert.equal(e.rooms.get(room.id).workspace.id, "main");
    // Snapshots can't be taken (a file Git is told to skip): said once, not every turn.
    git(t.repo, "update-index", "--skip-worktree", "README.md");
    for (const n of [1, 2]) {
      e.postMessage(room.id, { text: `Hello ${n}.`, to: "codex", answering: false });
      await waitFor(() => turns(e, room.id).filter((x) => x.state === "done").length === n, { label: `reply ${n}` });
    }
    const said = e.roomView(room.id).events.filter((x) => x.type === "system" && /couldn't take a snapshot/.test(x.text));
    assert.equal(said.length, 1);
    assert.match(said[0].text, /^Toryo couldn't take a snapshot of this room's folder: Git is told to skip a file \(README\.md\)/);
    assert.deepEqual([turns(e, room.id).at(-1).snapBefore, turns(e, room.id).at(-1).filesKnown], [undefined, false]);
  } finally {
    e.shutdown();
    t.cleanup();
  }
});

test("the files' own bytes and modes, whatever Git would make of them: filters, line endings, encodings, a file taken as unchanged, core.filemode and core.symlinks off", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "filters");
    // A clean filter that would hide what's in the folder; Windows line endings; UTF-16 kept as UTF-16 in the folder.
    git(path, "config", "filter.hide.clean", "sed s/real/fake/");
    git(path, "config", "filter.hide.smudge", "cat");
    writeFileSync(join(path, ".gitattributes"), "*.cfg filter=hide\n*.crlf text eol=crlf\n*.u16 working-tree-encoding=UTF-16\n");
    writeFileSync(join(path, "secret.cfg"), "real\n");
    writeFileSync(join(path, "lines.crlf"), "one\r\ntwo\r\n");
    const u16 = Buffer.from("\ufeffhi\n", "utf16le");
    writeFileSync(join(path, "text.u16"), u16);
    writeFileSync(join(path, "same.txt"), "kept\n");
    writeFileSync(join(path, "tool.sh"), "echo\n");
    git(path, "add", ".");
    git(path, "commit", "-qm", "attributes");
    // Git says nothing changed in these; the folder says otherwise.
    git(path, "update-index", "--assume-unchanged", "same.txt");
    writeFileSync(join(path, "same.txt"), "changed under Git's nose\n");
    git(path, "config", "core.filemode", "false");
    chmodSync(join(path, "tool.sh"), 0o755);
    const snaps = new Snapshots(s.home);
    const project = { id: "filters", path };
    // Your own Git settings apply everywhere, Toryo's shadow store too: line endings converted on the way in.
    const globalConfig = join(s.base, "gitconfig");
    writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n");
    const was = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    writeFileSync(join(path, "notes.md"), "a\r\nb\r\n");
    const r = await snaps.capture(project, "test");
    if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = was;
    assert.equal(r.ok, true, r.reason);
    const f = files(snaps, project, r.tree);
    assert.equal(blob(snaps, project, f["notes.md"].blob).toString(), "a\r\nb\r\n", "not converted, whatever your own Git settings");
    assert.equal(blob(snaps, project, f["secret.cfg"].blob).toString(), "real\n", "not what the clean filter makes of it");
    assert.equal(blob(snaps, project, f["lines.crlf"].blob).toString(), "one\r\ntwo\r\n", "the line endings as they are");
    assert.ok(blob(snaps, project, f["text.u16"].blob).equals(u16), "UTF-16, as it is in the folder");
    assert.equal(blob(snaps, project, f["same.txt"].blob).toString(), "changed under Git's nose\n");
    assert.equal(f["tool.sh"].mode, "100755", "executable, though Git ignores modes here");
    // core.symlinks off: Git wrote the link as a plain file holding its target; that's what the folder has.
    const links = repo(s.base, "links");
    symlinkSync("README.md", join(links, "link"));
    git(links, "add", "link");
    git(links, "commit", "-qm", "link");
    git(links, "config", "core.symlinks", "false");
    unlinkSync(join(links, "link"));
    git(links, "checkout", "--", "link");
    const l = await snaps.capture({ id: "links", path: links }, "test");
    assert.equal(l.ok, true, l.reason);
    const lf = files(snaps, { id: "links", path: links }, l.tree);
    assert.deepEqual([lf.link.mode, blob(snaps, { id: "links", path: links }, lf.link.blob).toString()], ["100644", "README.md"]);
  } finally {
    s.done();
  }
});

test("failures say what they are: a workspace without its folder never falls back to the main one; a repository appearing inside during the capture; a reference that can't be kept; a file that can't be read", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "fails");
    let nest = false;
    const snaps = new Snapshots(s.home, {
      hooks: {
        captured: (root) => {
          if (nest) git(root, "init", "-q", join(root, "late"));
        },
      },
    });
    const project = { id: "fails", path };
    const main = await snaps.capture(project, "main");
    const nameless = await snaps.capture(project, "room", { id: "room-1" });
    assert.deepEqual([nameless.ok, nameless.reason], [false, "the workspace “room-1” has no folder recorded"]);
    assert.equal(shadow(snaps, project, "rev-parse", "refs/toryo/latest").toString().trim(), main.commit, "the main folder's snapshots untouched");
    assert.equal(snaps.failure(project, { id: "room-1" }), "the workspace “room-1” has no folder recorded");
    // A repository inside the folder, appearing while the snapshot is taken: refused, naming it.
    nest = true;
    writeFileSync(join(path, "late.txt"), "x\n");
    const nested = await snaps.capture(project, "nested");
    assert.equal(nested.ok, false);
    assert.match(nested.reason, /^there's a repository inside the folder that Git doesn't track \(late\/\)/);
    nest = false;
    rmSync(join(path, "late"), { recursive: true, force: true });
    // The reference can't be written (a lock left behind): not a snapshot that stays.
    writeFileSync(join(snaps.gitDir(project), "refs", "toryo", "latest.lock"), "");
    const locked = await snaps.capture(project, "locked");
    assert.equal(locked.ok, false);
    assert.match(locked.reason, /^Toryo couldn't keep the snapshot: /);
    unlinkSync(join(snaps.gitDir(project), "refs", "toryo", "latest.lock"));
    // A file Toryo can't read: said, with its name, not taken for files changing.
    writeFileSync(join(path, "private.txt"), "x\n");
    chmodSync(join(path, "private.txt"), 0o000);
    const unreadable = await snaps.capture(project, "unreadable");
    chmodSync(join(path, "private.txt"), 0o644);
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.reason, /^Toryo couldn't read private\.txt: .*[Pp]ermission denied/);
  } finally {
    s.done();
  }
});

test("Git stopping early on a long list doesn't bring Toryo down: its own reason is the failure's", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "many");
    // More names than a pipe holds at once.
    const pad = "x".repeat(80);
    for (let i = 0; i < 6000; i++) writeFileSync(join(path, `f-${pad}-${i}.txt`), `${i}\n`);
    const snaps = new Snapshots(s.home);
    const project = { id: "many", path };
    // Git can't store anything (its objects folder made read-only): it stops at the first file, while Toryo is still
    // writing the list.
    await snaps.ensure(project);
    const objects = join(snaps.gitDir(project), "objects");
    chmodSync(objects, 0o555);
    const r = await snaps.capture(project, "test");
    chmodSync(objects, 0o755);
    assert.equal(r.ok, false);
    assert.match(r.reason, /^Toryo couldn't read .*: .*(insufficient permission|[Pp]ermission denied|unable to)/);
    // And a file it can't read, on a long list, is named.
    writeFileSync(join(path, "000-private.txt"), "x\n");
    chmodSync(join(path, "000-private.txt"), 0o000);
    const named = await snaps.capture(project, "test");
    chmodSync(join(path, "000-private.txt"), 0o644);
    assert.equal(named.ok, false);
    assert.match(named.reason, /^Toryo couldn't read 000-private\.txt: .*[Pp]ermission denied/);
  } finally {
    s.done();
  }
});

test("a file rewritten with its old size and modification time put back is read again, also by a desk started since", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "times");
    const file = join(path, "same-size.txt");
    const fixed = new Date("2026-01-01T00:00:00Z");
    const write = (text) => {
      writeFileSync(file, text);
      utimesSync(file, fixed, fixed);
    };
    write("aaaa\n");
    const project = { id: "times", path };
    const content = async (snaps) => {
      const r = await snaps.capture(project, "test");
      assert.equal(r.ok, true, r.reason);
      return blob(snaps, project, files(snaps, project, r.tree)["same-size.txt"].blob).toString();
    };
    const snaps = new Snapshots(s.home);
    assert.equal(await content(snaps), "aaaa\n");
    await new Promise((r) => setTimeout(r, 20));
    write("bbbb\n");
    assert.equal(await content(snaps), "bbbb\n", "read again: its change time moved");
    // A new desk, from the record on disk.
    await new Promise((r) => setTimeout(r, 20));
    write("cccc\n");
    assert.equal(await content(new Snapshots(s.home)), "cccc\n");
  } finally {
    s.done();
  }
});

test("each file under its own name: names Git's lists would read differently, link targets byte for byte; pipes, sockets and names that aren't UTF-8 refused", async () => {
  const s = scratch();
  try {
    const path = repo(s.base, "names");
    writeFileSync(join(path, '"README.md"'), "quoted\n");
    // A name starting with a byte-order mark, beside the same name without one.
    writeFileSync(join(path, "\ufeffREADME.md"), "with a mark\n");
    writeFileSync(join(path, "x.txt"), "plain\n");
    writeFileSync(join(path, "x.txt\r"), "with a carriage return\n");
    const target = Buffer.from([0x74, 0xff, 0x2e, 0x74, 0x78, 0x74]);
    symlinkSync(target, join(path, "odd-link"));
    const snaps = new Snapshots(s.home);
    const project = { id: "names", path };
    const r = await snaps.capture(project, "test");
    assert.equal(r.ok, true, r.reason);
    const f = files(snaps, project, r.tree);
    assert.equal(blob(snaps, project, f['"README.md"'].blob).toString(), "quoted\n");
    assert.equal(blob(snaps, project, f["\ufeffREADME.md"].blob).toString(), "with a mark\n");
    assert.equal(blob(snaps, project, f["README.md"].blob).toString(), "# readme\n");
    assert.equal(blob(snaps, project, f["x.txt"].blob).toString(), "plain\n");
    assert.equal(blob(snaps, project, f["x.txt\r"].blob).toString(), "with a carriage return\n");
    assert.ok(blob(snaps, project, f["odd-link"].blob).equals(target), "the link's target, byte for byte");
    // The marked name alone (no unmarked one beside it): there, under its own name.
    const marked = repo(s.base, "marked");
    writeFileSync(join(marked, "\ufeffnotes.md"), "only one\n");
    const m = await snaps.capture({ id: "marked", path: marked }, "test");
    assert.equal(m.ok, true, m.reason);
    const mf = files(snaps, { id: "marked", path: marked }, m.tree);
    assert.deepEqual(Object.keys(mf).sort(), ["README.md", "\ufeffnotes.md"]);
    assert.equal(blob(snaps, { id: "marked", path: marked }, mf["\ufeffnotes.md"].blob).toString(), "only one\n");
    // A tracked file replaced by a pipe, or by a socket: refused, naming it, not taken for a deletion.
    const special = async (name, make) => {
      const p = repo(s.base, name);
      writeFileSync(join(p, "data"), "x\n");
      git(p, "add", "data");
      git(p, "commit", "-qm", "data");
      unlinkSync(join(p, "data"));
      const cleanup = await make(join(p, "data"));
      const x = await snaps.capture({ id: name, path: p }, "test");
      await cleanup?.();
      return x;
    };
    const fifo = await special("fifo", (at) => void execFileSync("mkfifo", [at]));
    assert.deepEqual([fifo.ok, fifo.unsupported, fifo.reason], [false, true, "data is a pipe, which a snapshot can't hold; Toryo's snapshots don't support that"]);
    const socket = await special("socket", (at) => new Promise((resolve) => {
      const server = createServer().listen(at, () => resolve(() => new Promise((done) => server.close(done))));
    }));
    assert.deepEqual([socket.ok, socket.reason], [false, "data is a socket, which a snapshot can't hold; Toryo's snapshots don't support that"]);
    // A name that isn't UTF-8: refused, never misread as another name (or a deletion).
    const latin = repo(s.base, "latin");
    writeFileSync(Buffer.concat([Buffer.from(join(latin, "caf")), Buffer.from([0xe9]), Buffer.from(".txt")]), "x\n");
    const bad = await snaps.capture({ id: "latin", path: latin }, "test");
    assert.deepEqual([bad.ok, bad.unsupported], [false, true]);
    assert.match(bad.reason, /^a file's name isn't UTF-8/);
  } finally {
    s.done();
  }
});
