import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { feed, quiet } from "./snapshots.mjs";
import { run } from "./util.mjs";

/**
 * A room's own worktree: an ordinary Git linked worktree of the project, on a branch of its own, in
 * TORYO_HOME/worktrees/<project id>/<room id>, outside the project (no file watcher or snapshot of the project sees
 * it). It starts from a snapshot of the project's main folder (B), uncommitted work included, not from HEAD alone:
 *
 * 1. `git worktree add --no-checkout` makes the folder and its branch, starting at the main folder's HEAD (`start`;
 *    null: an unborn repository, which gets an orphan worktree). That writes Git's own records of it (the
 *    registration, the branch) into the project's .git; the main folder's files, its index, its HEAD and every other
 *    branch are untouched. The worktree is locked with a reason naming this attempt (`lockReason(workspaceId, token)`):
 *    proof that the registration, and the branch Git made with it, are this room's (see undoWorktree).
 * 2. B's files are written in it as they were (see Snapshots.materialize).
 * 3. They're staged in the worktree's own index, as Git would stage them there (`git add` of each), so plain
 *    `git diff` starts empty and `git diff --cached` / `git diff HEAD` show what it inherited. No commit is made.
 * 4. A snapshot of the new worktree must have B's files exactly; otherwise it isn't used.
 *
 * The check is the workspace's first snapshot (`workspaceId`). `hooks.step(name)` is called before each step (tests
 * stop or fail creation there). { ok: true, first } or { ok: false, reason }.
 */
export async function createWorktree({ snapshots, project, source, path, branch, start, base, subdir = "", workspaceId, token, hooks = {} }) {
  const step = async (name) => hooks.step?.(name);
  if (existsSync(path)) return { ok: false, reason: `there's already something at ${path}` };
  const exists = await git(source, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  if (exists.code === 0) return { ok: false, reason: `the branch ${branch} already exists` };
  await step("add");
  mkdirSync(dirname(path), { recursive: true });
  // `-b` makes the branch only with the worktree, and fails if it's there (made by someone else since the check).
  const lock = ["--lock", "--reason", lockReason(workspaceId, token)];
  const add = start
    ? await git(source, ["worktree", "add", "--no-checkout", ...lock, "-b", branch, path, start])
    : await git(source, ["worktree", "add", "--orphan", ...lock, "-b", branch, path]);
  if (add.code !== 0) return { ok: false, reason: `Git couldn't make the worktree: ${gitReason(add.stderr)}` };
  await step("files");
  const written = await snapshots.materialize(project, base.commit, path);
  if (!written.ok) return { ok: false, reason: written.reason };
  const cwd = join(path, subdir);
  mkdirSync(cwd, { recursive: true });
  await step("stage");
  const staged = await stage(path, written.entries);
  if (!staged.ok) return { ok: false, reason: staged.reason };
  // Room for the room's branch in the folders a read-only main folder keeps writable (see `gitPaths`).
  const paths = await gitPaths(path);
  if (paths) for (const dir of [join(paths.common, "refs", "heads", branchDir(branch)), join(paths.common, "logs", "refs", "heads", branchDir(branch))]) mkdirSync(dir, { recursive: true });
  await step("check");
  const check = await snapshots.capture(project, `start of ${branch}`, { id: workspaceId, path: cwd });
  if (!check.ok) return { ok: false, reason: `Toryo couldn't check the new worktree: ${check.reason}` };
  if (check.tree !== base.tree) {
    const differ = await snapshots.changes(project, base.commit, check.commit);
    return { ok: false, reason: `the new worktree doesn't match the snapshot it was made from (${differ.slice(0, 5).map((f) => f.path).join(", ") || "its files differ"})` };
  }
  return { ok: true, first: check.commit };
}

/**
 * Stage these files in a worktree's own index, as `git add` would there (its attributes and filters apply to the
 * staged copy; the files themselves stay as written). Links are staged with their targets.
 */
async function stage(root, entries) {
  const env = quiet();
  const clear = await git(root, ["read-tree", "--empty"]);
  if (clear.code !== 0) return { ok: false, reason: `Toryo couldn't start the worktree's index: ${firstLine(clear.stderr)}` };
  const files = entries.filter((e) => e.mode !== "120000");
  const oids = new Map();
  // A name Git's list would read differently goes on its own, as an argument.
  const odd = (p) => p.includes("\n") || p.endsWith("\r") || p.startsWith('"');
  for (const f of files.filter((x) => odd(x.path))) {
    const one = await run("git", ["-C", root, "hash-object", "-w", "--", f.path], { env });
    if (one.code !== 0) return { ok: false, reason: `Toryo couldn't stage ${JSON.stringify(f.path)}: ${firstLine(one.stderr)}` };
    oids.set(f.path, one.stdout.trim());
  }
  const plain = files.filter((x) => !odd(x.path));
  if (plain.length) {
    const r = await feed(["-C", root, "hash-object", "-w", "--stdin-paths"], { env }, plain.map((f) => f.path).join("\n") + "\n", true);
    const got = r.out.trim().split("\n");
    if (r.code !== 0 || got.length !== plain.length) return { ok: false, reason: `Toryo couldn't stage the files: ${firstLine(r.err)}` };
    plain.forEach((f, i) => oids.set(f.path, got[i]));
  }
  for (const l of entries.filter((e) => e.mode === "120000")) {
    const r = await feed(["-C", root, "hash-object", "-w", "--stdin"], { env }, readlinkSync(join(root, l.path), { encoding: "buffer" }), true);
    if (r.code !== 0) return { ok: false, reason: `Toryo couldn't stage the link ${l.path}: ${firstLine(r.err)}` };
    oids.set(l.path, r.out.trim());
  }
  if (entries.length) {
    const lines = entries.map((e) => `${e.mode} ${oids.get(e.path)}\t${e.path}`);
    const put = await feed(["-C", root, "update-index", "-z", "--index-info"], { env }, lines.join("\0") + "\0");
    if (put.code !== 0) return { ok: false, reason: `Toryo couldn't stage the files: ${firstLine(put.err)}` };
  }
  // Each file's details in the index, so `git diff` and `git status` see them unchanged without reading them again.
  await git(root, ["update-index", "-q", "--refresh"]);
  return { ok: true };
}

/** The lock reason a room's worktree is made with: which room, and which attempt (`token`). */
export const lockReason = (workspaceId, token) => `Toryo room ${workspaceId}, attempt ${token}`;

/**
 * Undo a worktree whose making didn't finish, so it can be made again. Everything is checked before anything is
 * removed, and only what this attempt provably made goes; anything else, or anything Toryo can't tell, is left:
 * - The worktree registered at the path must be locked with this attempt's reason (`lockReason(workspaceId, token)`,
 *   which only Toryo's `git worktree add` for this attempt writes) and be on this room's branch. Not registered: nothing
 *   was made (Git refused it, or it was undone already), and a folder at the path isn't this room's.
 * - The branch must be read without error and be exactly where Toryo started it (`start`), or, for an orphan worktree
 *   (`start` null), have no commit. Gone, moved or unreadable: left, with its worktree.
 * Then the worktree (by its own path, also when its folder is gone; never a repository-wide prune) and the branch
 * (compare-and-delete) are removed. A branch with no registration of this attempt is never touched. { ok } or
 * { ok: false, reason }.
 */
export async function undoWorktree({ source, path, branch, start, workspaceId, token }) {
  const listed = await git(source, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.code !== 0) return { ok: false, reason: `Git couldn't list the project's worktrees: ${firstLine(listed.stderr)}` };
  const mine = parseWorktrees(listed.stdout).find((w) => samePath(w.worktree, path));
  if (!mine) return existsSync(path) ? { ok: false, reason: `there's a folder at ${path} that isn't this room's worktree; move it away, then try again` } : { ok: true };
  if (!token || mine.locked !== lockReason(workspaceId, token)) return { ok: false, reason: `the worktree at ${path} wasn't made by Toryo for this room; Toryo leaves it` };
  if (mine.branch !== `refs/heads/${branch}`)
    return { ok: false, reason: `${path} is a worktree ${mine.branch ? `on another branch (${String(mine.branch).replace("refs/heads/", "")})` : "with no branch"}, not this room's; Toryo leaves it` };
  // The branch as it is: a lookup that fails (or warns, as for a broken reference) isn't taken for "no commit".
  const tip = await git(source, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]);
  if (tip.code !== 0 || tip.stderr.trim()) return { ok: false, reason: `Git couldn't read the branch ${branch} (${firstLine(tip.stderr)}); Toryo leaves it and its worktree` };
  const at = tip.stdout.trim() || null;
  if (at !== (start ?? null))
    return { ok: false, reason: `the branch ${branch} isn't where Toryo started it (${at ? "it has moved" : "it's gone"}); Toryo leaves it and its worktree` };
  const removed = await git(source, ["worktree", "remove", "--force", "--force", path]);
  if (removed.code !== 0) return { ok: false, reason: `Git couldn't remove the unfinished worktree: ${firstLine(removed.stderr)}` };
  if (at) {
    const del = await git(source, ["update-ref", "-d", `refs/heads/${branch}`, at]);
    if (del.code !== 0) return { ok: false, reason: `Git couldn't remove the branch ${branch}: ${firstLine(del.stderr)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- files copied into a new worktree

/** At most this many files are copied into a worktree (patterns are for a few private files, not folders of them). */
const MAX_COPIES = 500;
/** A scan looks at no more than this many files and folders; past it, it says so rather than copy a part. */
const MAX_VISITS = 50_000;
/** Nor deeper than this many folders: deeper, it says so too. */
const MAX_DEPTH = 40;

/**
 * Why a copy pattern can't be used, or null. Patterns are relative to the project's folder (`.env*`,
 * `config/*.local.json`, `**` for any folders in between); never absolute, never `..`, never into `.git`.
 */
export function copyPatternProblem(pattern) {
  const p = String(pattern ?? "").trim();
  if (!p) return "a pattern is empty";
  if (p.startsWith("/") || /^[a-z]:[\\/]/i.test(p) || p.startsWith("~")) return `“${p}” isn't relative to the project's folder`;
  if (p.includes("\\")) return `“${p}” has a backslash: use / between folders`;
  const parts = p.split("/").filter(Boolean);
  if (parts.some((x) => x === "..")) return `“${p}” steps out of the project's folder (..)`;
  if (parts.some((x) => x === ".")) return `“${p}” has a ./ in it: write the path from the project's folder`;
  if (parts.some((x) => x.toLowerCase() === ".git")) return `“${p}” is inside .git`;
  return null;
}

const globRe = (seg) => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);

/**
 * The files the project's copy patterns match in its folder (`folder`, the project's own), to copy into a new
 * worktree. Only regular files that Git ignores and doesn't track count, never one of the project's own files (those
 * come with the snapshot); nothing reached through a link, and no folders. `top` is the folder's Git top (`subdir`: the
 * folder inside it). Each pattern's matches are sorted as it's scanned, so the project's own files never crowd out a
 * later pattern. { ok: true, files: [{ path, size, dev, ino }], refused: [{ path, why }] }, paths relative to the
 * folder; or { ok: false, reason, refused } when it can't say for all of them (too many, or Git couldn't tell): a part
 * is never taken for the whole.
 */
export async function findCopies(folder, patterns, { top = folder, subdir = "", maxVisits = MAX_VISITS } = {}) {
  const found = new Map();
  const refused = [];
  const refusedPaths = new Set();
  const refuse = (path, why) => {
    if (refusedPaths.has(path)) return;
    refusedPaths.add(path);
    refused.push({ path, why });
  };
  const inTop = (p) => (subdir ? `${subdir}/${p}` : p);
  let visits = 0;
  for (const pattern of patterns ?? []) {
    const bad = copyPatternProblem(pattern);
    if (bad) {
      refuse(String(pattern), bad);
      continue;
    }
    const segs = String(pattern).trim().split("/").filter(Boolean);
    const candidates = new Map();
    let tooMany = false;
    let tooDeep = false;
    const walk = (rel, i, depth = 0) => {
      if (tooMany || ++visits > maxVisits) return (tooMany = true);
      if (depth > MAX_DEPTH) return (tooDeep = true);
      const here = rel ? join(folder, rel) : folder;
      if (i === segs.length) {
        let st;
        try {
          st = lstatSync(here, { bigint: true });
        } catch {
          return;
        }
        if (st.isSymbolicLink()) return refuse(rel, "it's a link, which Toryo doesn't copy");
        if (st.isDirectory()) return refuse(rel, "it's a folder; only files are copied");
        if (!st.isFile()) return refuse(rel, "it isn't a regular file");
        candidates.set(rel, { path: rel, size: Number(st.size), dev: String(st.dev), ino: String(st.ino) });
        return;
      }
      const seg = segs[i];
      if (seg === "**") {
        walk(rel, i + 1, depth);
        for (const d of entries(here)) if (d.isDirectory() && d.name !== ".git") walk(rel ? `${rel}/${d.name}` : d.name, i, depth + 1);
        return;
      }
      const last = i === segs.length - 1;
      const names = /[*?]/.test(seg) ? entries(here).map((d) => d.name).filter((n) => globRe(seg).test(n) && n !== ".git") : [seg];
      for (const name of names) {
        const next = rel ? `${rel}/${name}` : name;
        if (last) {
          walk(next, i + 1, depth);
          continue;
        }
        let st;
        try {
          st = lstatSync(join(folder, next));
        } catch {
          continue;
        }
        // Never through a link to somewhere else.
        if (st.isSymbolicLink()) refuse(`${String(pattern).trim()}`, `it goes through a link (${next})`);
        else if (st.isDirectory()) walk(next, i + 1, depth + 1);
      }
    };
    walk("", 0);
    if (tooMany) return { ok: false, reason: `the copy pattern “${String(pattern).trim()}” reaches more than ${maxVisits.toLocaleString("en")} files and folders, so Toryo stopped looking; make it narrower`, files: [], refused };
    if (tooDeep) return { ok: false, reason: `the copy pattern “${String(pattern).trim()}” reaches folders more than ${MAX_DEPTH} deep, so Toryo stopped looking; make it narrower`, files: [], refused };
    // The project's own files (tracked, or untracked and not ignored) come with the snapshot: never copied over them.
    const paths = [...candidates.keys()].filter((p) => !found.has(p));
    const own = await ownFiles(top, paths.map(inTop));
    if (!own.ok) return { ok: false, reason: `Toryo couldn't tell which of the matching files are the project's own: ${own.reason}`, files: [], refused };
    for (const p of paths) {
      if (own.files.has(inTop(p))) refuse(p, "it's one of the project's own files (not ignored), which the worktree already has");
      else found.set(p, candidates.get(p));
    }
    if (found.size > MAX_COPIES) return { ok: false, reason: `the copy patterns match more than ${MAX_COPIES} files Git ignores; make them narrower`, files: [], refused };
  }
  return { ok: true, files: [...found.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), refused };
}

/** Which of these paths (from the Git top) are the project's own files: tracked, or untracked and not ignored. */
async function ownFiles(top, paths) {
  const files = new Set();
  for (let i = 0; i < paths.length; i += 500) {
    const r = await run("git", ["-C", top, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths.slice(i, i + 500)], { env: { ...quiet(), GIT_LITERAL_PATHSPECS: "1" }, timeout: 60_000 });
    if (r.code !== 0) return { ok: false, reason: firstLine(r.stderr) };
    for (const p of r.stdout.split("\0")) if (p) files.add(p);
  }
  return { ok: true, files };
}

const entries = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/**
 * Copy these files (from findCopies) from the project's folder (`from`) to the same places in a worktree (`to`, the
 * project's place in it). Each is checked again as it's read: every folder on its way still a real folder, the file
 * opened without following a link and still the very file that was found (the same device and inode), its permissions
 * as they are now (a private 0600 file stays private), every byte of it written (`write`: tests write in short pieces).
 * On the worktree's side, a folder in the way that's a link, or a file already there, stops it. Anything changed stops the copy, naming it: { ok, copied } or { ok: false, reason }.
 */
export function copyInto(from, to, files, { write = writeSync } = {}) {
  const copied = [];
  const stop = (reason) => ({ ok: false, reason, copied });
  for (const f of files) {
    const parts = f.path.split("/");
    let src = from;
    for (const part of parts.slice(0, -1)) {
      src = join(src, part);
      let st;
      try {
        st = lstatSync(src);
      } catch {
        return stop(`couldn't copy ${f.path}: ${relative(from, src)} is gone`);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return stop(`couldn't copy ${f.path}: it changed since Toryo looked (${relative(from, src)} isn't a folder any more)`);
    }
    let input;
    try {
      input = openSync(join(from, f.path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      return stop(`couldn't copy ${f.path}: ${error.code === "ELOOP" ? "it changed since Toryo looked (it's a link now)" : (error.code ?? error.message)}`);
    }
    try {
      const st = fstatSync(input, { bigint: true });
      if (!st.isFile() || (f.dev != null && (String(st.dev) !== f.dev || String(st.ino) !== f.ino))) return stop(`couldn't copy ${f.path}: it changed since Toryo looked (it's another file now)`);
      const mode = Number(st.mode & 0o777n);
      let dir = to;
      for (const part of parts.slice(0, -1)) {
        dir = join(dir, part);
        let d = null;
        try {
          d = lstatSync(dir);
        } catch {
          mkdirSync(dir);
          continue;
        }
        if (!d.isDirectory() || d.isSymbolicLink()) return stop(`couldn't copy ${f.path}: ${relative(to, dir)} in the worktree isn't a folder (a link or a file)`);
      }
      let output;
      try {
        output = openSync(join(to, f.path), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
      } catch (error) {
        return stop(`couldn't copy ${f.path}: ${error.code === "EEXIST" ? "there's already a file there in the worktree" : (error.code ?? error.message)}`);
      }
      try {
        const buf = Buffer.alloc(1 << 16);
        // Every byte read is written, however few a write takes at a time; a write that takes none stops the copy.
        for (let n; (n = readSync(input, buf, 0, buf.length, null)) > 0; )
          for (let done = 0; done < n; ) {
            const wrote = write(output, buf, done, n - done);
            if (!(wrote > 0)) return stop(`couldn't copy ${f.path}: writing it in the worktree made no progress`);
            done += wrote;
          }
        fchmodSync(output, mode);
      } finally {
        closeSync(output);
      }
    } finally {
      closeSync(input);
    }
    copied.push(f.path);
  }
  return { ok: true, copied };
}

/** A worktree's Git folders: its own (`gitDir`: its index, HEAD) and the project's shared one (`common`). Null outside Git. */
export async function gitPaths(dir) {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (r.code !== 0) return null;
  const [gitDir, common] = r.stdout.trim().split("\n");
  return { gitDir: real(gitDir), common: real(common) };
}

/**
 * The folders a room's agents may still write in while the main folder is read-only for them: the room's own Git
 * folder (its index, HEAD), the project's objects (what `git add` writes) and the room's branch, inside the
 * project's .git. Not the main folder's index, HEAD or other branches. Only folders that are there.
 */
export function writableGitPaths(paths, branch) {
  if (!paths) return [];
  return [paths.gitDir, join(paths.common, "objects"), join(paths.common, "refs", "heads", branchDir(branch)), join(paths.common, "logs", "refs", "heads", branchDir(branch))].filter((p) => existsSync(p) && lstatSync(p).isDirectory());
}

/** The folder a room's branch lives in under refs/heads ("toryo" for toryo/<room>). */
const branchDir = (branch) => branch.split("/").slice(0, -1).join("/") || ".";

/** The folder a worktree's .git file points to, read directly (no Git needed). */
export function worktreeGitDir(path) {
  try {
    const text = readFileSync(join(path, ".git"), "utf8");
    const m = text.match(/^gitdir: (.+)$/m);
    return m ? resolve(path, m[1].trim()) : null;
  } catch {
    return null;
  }
}

function parseWorktrees(out) {
  const list = [];
  let cur = null;
  for (const field of String(out ?? "").split("\0")) {
    if (!field) {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    const [key, ...rest] = field.split(" ");
    if (key === "worktree") cur = { worktree: rest.join(" ") };
    else if (cur) cur[key] = rest.join(" ") || true;
  }
  if (cur) list.push(cur);
  return list;
}

const samePath = (a, b) => {
  const r = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return r(a) === r(b);
};

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Whether `path` is `folder` or inside it. */
export function inside(path, folder) {
  const rel = relative(folder, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

const git = (dir, args) => run("git", ["-C", dir, ...args], { env: quiet(), timeout: 300_000 });

const firstLine = (s) => String(s ?? "").trim().split("\n")[0] || "no reason given";

/** Git's reason in what it printed: its `fatal:` or `error:` line (progress lines come first), else its last line. */
const gitReason = (s) => {
  const lines = String(s ?? "").trim().split("\n");
  return lines.find((l) => /^(fatal|error): /.test(l)) ?? lines.at(-1) ?? "no reason given";
};
