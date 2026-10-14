import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./util.mjs";

/** How many times a capture is tried again when the folder changes while it's taken. */
const ATTEMPTS = 3;

/**
 * Exact snapshots of a project's working files, kept in a shadow git repository under TORYO_HOME (one per project).
 * The project's own .git is only read (borrowed through alternates, with optional locks off); nothing is ever written
 * to it, so the project's index, HEAD and branches are untouched and `git status` there is unaffected.
 *
 * A snapshot is the folder as it is, or it isn't taken. Every file Git tracks that's still there, and every untracked
 * one Git doesn't ignore, is read from the folder itself: its bytes as they are (no filters, line-ending or encoding
 * conversions, so an LFS file's real contents, not its pointer), and its mode from the file system (the executable
 * bit, symbolic links), whatever Git's settings say. Files Git tracks that are gone are deletions. Ignored files (a
 * copied `.env`, build output) are left out, as Git leaves them out. Files changing while a snapshot is taken make
 * Toryo take it again, then give up saying so. What a snapshot can't reproduce is refused with a reason rather than
 * captured in part: submodules, a repository inside the folder that Git doesn't track, a sparse checkout, files Git
 * is told to skip. A file that can't be read is a failure naming it.
 *
 * Each workspace (the project's own folder, "main"; a room's own worktree later) has its own index, reference, lock
 * and record of what it last read, in the shadow repository, so two of them never mix. A room can pin a snapshot (its
 * starting point) so it stays.
 */
export class Snapshots {
  /** `hooks.captured(workspacePath, attempt)`: called between listing and checking a capture (tests use it). */
  constructor(home, { hooks = {} } = {}) {
    this.root = join(home, "shadow");
    mkdirSync(this.root, { recursive: true });
    this.ready = new Map();
    this.locks = new Map();
    // Why the last snapshot of each workspace couldn't be taken (cleared by one that could).
    this.failures = new Map();
    this.hooks = hooks;
  }

  gitDir(project) {
    return join(this.root, `${project.id}.git`);
  }

  /** The project's shadow repository, made if needed, borrowing the project's objects. Null outside Git. */
  async ensure(project) {
    if (this.ready.has(project.id)) return this.ready.get(project.id);
    const top = await run("git", ["-C", project.path, "rev-parse", "--show-toplevel"], { env: quiet() });
    if (top.code !== 0) {
      this.ready.set(project.id, null);
      return null;
    }
    const dir = this.gitDir(project);
    if (!existsSync(join(dir, "HEAD"))) {
      const init = await run("git", ["init", "--bare", "-q", dir]);
      if (init.code !== 0) {
        this.ready.set(project.id, null);
        return null;
      }
    }
    const common = await run("git", ["-C", project.path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { env: quiet() });
    if (common.code === 0) {
      mkdirSync(join(dir, "objects", "info"), { recursive: true });
      writeFileSync(join(dir, "objects", "info", "alternates"), join(common.stdout.trim(), "objects") + "\n");
    }
    const info = { dir, top: top.stdout.trim() };
    this.ready.set(project.id, info);
    return info;
  }

  /**
   * Snapshot a workspace's files as they are now: { commit, tree }, or null when it can't be taken (see `capture`
   * for why). Without a workspace, the project's own folder.
   */
  async take(project, label, workspace = null) {
    const r = await this.capture(project, label, workspace);
    return r.ok ? { commit: r.commit, tree: r.tree } : null;
  }

  /**
   * Snapshot a workspace's files: { ok: true, commit, tree, workspace } or { ok: false, reason, unsupported? }.
   * `workspace`: { id, path } (null or id "main": the project's own folder). One capture at a time per workspace.
   */
  async capture(project, label, workspace = null) {
    const ws = workspaceOf(project, workspace);
    const key = `${project.id}|${ws.id}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const job = previous
      .then(() => this.#capture(project, label, ws))
      .catch((error) => ({ ok: false, reason: `Toryo's snapshot failed: ${error?.message ?? error}` }))
      .then((r) => {
        if (r.ok) this.failures.delete(key);
        else this.failures.set(key, r.reason);
        return r;
      });
    this.locks.set(key, job);
    return job;
  }

  /** Why the last snapshot of a workspace couldn't be taken, or null. */
  failure(project, workspace = null) {
    return this.failures.get(`${project.id}|${workspaceOf(project, workspace).id}`) ?? null;
  }

  async #capture(project, label, ws) {
    if (!ws.path) return { ok: false, reason: `the workspace “${ws.id}” has no folder recorded` };
    if (!existsSync(ws.path)) return { ok: false, reason: `the folder ${ws.path} isn't there` };
    const info = await this.ensure(project);
    if (!info) return { ok: false, reason: "the project's folder isn't in a Git repository, so Toryo can't take snapshots of it" };
    const top = await run("git", ["-C", ws.path, "rev-parse", "--show-toplevel"], { env: quiet() });
    if (top.code !== 0) return { ok: false, reason: `${ws.path} isn't in a Git repository` };
    const root = top.stdout.trim();
    const unsupported = await unsupportedFeatures(root);
    if (unsupported) return { ok: false, unsupported: true, reason: unsupported };
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const r = await this.#once(info.dir, root, ws, label, attempt);
      if (r.ok || !r.changed) return r;
    }
    return { ok: false, reason: "files kept changing while Toryo took the snapshot" };
  }

  /**
   * One try: the files as listed are read (those unchanged since this workspace's last snapshot are taken from its
   * record), then listed again; any change meanwhile, `changed`, and it's taken again.
   */
  async #once(dir, root, ws, label, attempt) {
    const main = ws.id === "main";
    // The main folder keeps the names snapshots always had, so older snapshots stay where they were.
    const index = join(dir, main ? "toryo-index" : `toryo-index-${safe(ws.id)}`);
    const record = join(dir, main ? "toryo-read.json" : `toryo-read-${safe(ws.id)}.json`);
    const ref = main ? "refs/toryo/latest" : `refs/toryo/ws/${safe(ws.id)}/latest`;
    const env = { ...quiet(), GIT_DIR: dir, GIT_INDEX_FILE: index };
    const opts = { cwd: root, env, timeout: 300_000 };

    const seen = await listing(root);
    if (!seen.ok) return seen;
    if (seen.nested.length) return nestedRefusal(seen.nested);
    const known = readRecord(record);
    const entries = new Map();
    const toRead = [];
    const links = [];
    for (const [path, st] of seen.stats) {
      if (!st) continue; // gone: a deletion
      const sig = signatureOf(st);
      const mode = st.isSymbolicLink() ? "120000" : st.mode & 0o111n ? "100755" : "100644";
      // A directory where a file was: its own files are listed with the others. A pipe, socket or device: refused.
      if (st.isDirectory()) continue;
      if (!st.isSymbolicLink() && !st.isFile()) return { ok: false, unsupported: true, reason: `${path} is ${st.isFIFO() ? "a pipe" : st.isSocket() ? "a socket" : "a device"}, which a snapshot can't hold; Toryo's snapshots don't support that` };
      if (known[path]?.sig === sig && known[path].mode === mode) entries.set(path, { mode, oid: known[path].oid, sig });
      else if (mode === "120000") links.push({ path, mode, sig });
      else toRead.push({ path, mode, sig });
    }
    // The bytes as they are in the folder: no filters, no line-ending or encoding conversions.
    if (toRead.length) {
      const hashed = await hashPaths(root, env, toRead.map((f) => f.path));
      if (!hashed.ok) return hashed;
      toRead.forEach((f, i) => entries.set(f.path, { mode: f.mode, oid: hashed.oids[i], sig: f.sig }));
    }
    for (const l of links) {
      let target;
      try {
        target = readlinkSync(join(root, l.path), { encoding: "buffer" });
      } catch (error) {
        return { ok: false, reason: `Toryo couldn't read the link ${l.path}: ${error.code ?? error.message}` };
      }
      const h = await hashInput(env, target);
      if (!h.ok) return { ok: false, reason: `Toryo couldn't record the link ${l.path}: ${h.reason}` };
      entries.set(l.path, { mode: l.mode, oid: h.oid, sig: l.sig });
    }
    await this.hooks.captured?.(root, attempt);
    // The files as they are now: the same list, each unchanged; otherwise, take it again. (A repository that appeared
    // inside the folder meanwhile is refused.)
    const now = await listing(root);
    if (!now.ok) return now;
    if (now.nested.length) return nestedRefusal(now.nested);
    if (now.signature !== seen.signature) return { ok: false, changed: true, reason: "files changed while Toryo took the snapshot" };
    const clear = await run("git", ["read-tree", "--empty"], opts);
    if (clear.code !== 0) return { ok: false, reason: `Toryo couldn't start the snapshot: ${firstLine(clear.stderr)}` };
    const lines = [...entries].map(([path, e]) => `${e.mode} ${e.oid}\t${path}`);
    if (lines.length) {
      const put = await feed(["update-index", "-z", "--index-info"], { cwd: root, env }, lines.join("\0") + "\0");
      if (put.code !== 0) return { ok: false, reason: `Toryo couldn't record the snapshot: ${firstLine(put.err)}` };
    }
    const tree = await run("git", ["write-tree"], opts);
    if (tree.code !== 0) return { ok: false, reason: `Toryo couldn't record the snapshot: ${firstLine(tree.stderr)}` };
    const parent = await run("git", ["rev-parse", "--verify", "-q", ref], opts);
    const commitArgs = ["commit-tree", tree.stdout.trim(), "-m", label || "snapshot"];
    if (parent.code === 0) commitArgs.push("-p", parent.stdout.trim());
    const commit = await run("git", commitArgs, { ...opts, env: { ...env, GIT_AUTHOR_NAME: "Toryo", GIT_AUTHOR_EMAIL: "toryo@localhost", GIT_COMMITTER_NAME: "Toryo", GIT_COMMITTER_EMAIL: "toryo@localhost" } });
    if (commit.code !== 0) return { ok: false, reason: `Toryo couldn't record the snapshot: ${firstLine(commit.stderr)}` };
    const id = commit.stdout.trim();
    // Kept under the workspace's name, or it isn't a snapshot that stays: a reference that can't be written fails it.
    const keep = await run("git", ["update-ref", ref, id], opts);
    if (keep.code !== 0) return { ok: false, reason: `Toryo couldn't keep the snapshot: ${firstLine(keep.stderr)}` };
    writeRecord(record, Object.fromEntries([...entries].map(([path, e]) => [path, { sig: e.sig, mode: e.mode, oid: e.oid }])));
    return { ok: true, commit: id, tree: tree.stdout.trim(), workspace: { id: ws.id, root } };
  }

  /** Keep a snapshot (a room's starting point) under a name, so it stays whatever comes after. */
  async pin(project, name, commit) {
    const info = await this.ensure(project);
    if (!info) return false;
    const r = await run("git", ["update-ref", `refs/toryo/pins/${safe(name)}`, commit], { env: { ...quiet(), GIT_DIR: info.dir } });
    return r.code === 0;
  }

  /** The snapshot pinned under a name, or null. */
  async pinned(project, name) {
    const info = await this.ensure(project);
    if (!info) return null;
    const r = await run("git", ["rev-parse", "--verify", "-q", `refs/toryo/pins/${safe(name)}`], { env: { ...quiet(), GIT_DIR: info.dir } });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /**
   * Files that differ between two snapshots: [{ status, path }]. A comparison that fails gives [] (nothing to show),
   * or null with `strict` (not known: unlike nothing changed).
   */
  async changes(project, from, to, { strict = false } = {}) {
    if (!from || !to || from === to) return [];
    const info = await this.ensure(project);
    if (!info) return strict ? null : [];
    const r = await run("git", ["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to], {
      env: { ...quiet(), GIT_DIR: info.dir },
    });
    if (r.code !== 0) return strict ? null : [];
    const parts = split0(r.stdout);
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] });
    return out;
  }

  async diff(project, from, to, path, maxBytes = 2_000_000) {
    const info = await this.ensure(project);
    if (!info || !from || !to) return "";
    const args = ["diff", "--no-color", "--no-renames", from, to];
    if (path) args.push("--", path);
    const r = await run("git", args, { env: { ...quiet(), GIT_DIR: info.dir }, maxBuffer: maxBytes * 4 });
    return r.stdout.length > maxBytes ? r.stdout.slice(0, maxBytes) + "\n… (diff truncated)" : r.stdout;
  }

  /** The command an agent can run to inspect snapshots itself. */
  hint(project) {
    return `git --git-dir=${this.gitDir(project)}`;
  }
}

/** A workspace as snapshots take it: { id, path }; the project's own folder is "main". */
export function workspaceOf(project, workspace) {
  if (!workspace || workspace.id === "main") return { id: "main", path: project.path };
  // A workspace named without its folder stays itself (and fails): it's never taken for the project's own folder.
  return { id: String(workspace.id), path: workspace.path || null };
}

/**
 * The folder's files as Git sees which ones count: every path Git tracks (gone ones too) and every untracked one it
 * doesn't ignore, each with its file-system details (null: gone); untracked repositories inside the folder (listed
 * by Git as `dir/`); and a signature of it all (size, mode, modification time, inode). Read only: the project's
 * index isn't refreshed (optional locks off).
 */
async function listing(root) {
  const tracked = await names(root, ["ls-files", "-z", "--cached"]);
  if (!tracked.ok) return tracked;
  const untracked = await names(root, ["ls-files", "-z", "-o", "--exclude-standard"]);
  if (!untracked.ok) return untracked;
  const loose = untracked.names;
  const nested = loose.filter((p) => p.endsWith("/"));
  const paths = [...new Set([...tracked.names, ...loose.filter((p) => !p.endsWith("/"))])].sort();
  const stats = new Map();
  const parts = [];
  for (const p of paths) {
    let st = null;
    try {
      st = lstatSync(join(root, p), { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return { ok: false, reason: `Toryo couldn't read ${p}: ${error.code ?? error.message}` };
    }
    stats.set(p, st);
    parts.push(`${p}\0${st ? signatureOf(st) : "gone"}`);
  }
  return { ok: true, stats, nested, signature: [...parts, ...nested].join("\0\0") };
}

// Size, mode, modification and change times, inode: a file rewritten with its old size and modification time put
// back still has a new change time.
const signatureOf = (st) => `${st.size}:${st.mode}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;

/** Names Git lists (NUL-separated), as the bytes they are: one that isn't UTF-8 is refused, never misread. */
function names(root, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { env: quiet(), encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, reason: `Git couldn't list the files: ${firstLine(String(stderr ?? error.message))}` });
      const out = [];
      // ignoreBOM: a name starting with U+FEFF keeps it (by default it's dropped, turning it into another name).
      const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let start = 0;
      for (let i = 0; i <= stdout.length; i++) {
        if (i < stdout.length && stdout[i] !== 0) continue;
        if (i > start) {
          const raw = stdout.subarray(start, i);
          try {
            out.push(utf8.decode(raw));
          } catch {
            return resolve({ ok: false, unsupported: true, reason: `a file's name isn't UTF-8 (${JSON.stringify(raw.toString("latin1"))}), which Toryo's snapshots don't support` });
          }
        }
        start = i + 1;
      }
      resolve({ ok: true, names: out });
    });
  });
}

const nestedRefusal = (nested) => ({
  ok: false,
  unsupported: true,
  reason: `there's a repository inside the folder that Git doesn't track (${nested.slice(0, 3).join(", ")}${nested.length > 3 ? "…" : ""}), whose files a snapshot can't hold; Toryo's snapshots don't support that`,
});

/** Blobs of these files' bytes as they are (no filters or conversions): { ok, oids } or { ok: false, reason }. */
async function hashPaths(root, env, paths) {
  // A name Git's list would read differently (a line break in it, a carriage return at its end, a quote at its start,
  // which Git takes for C quoting) goes on its own, as an argument, read as it is.
  const odd = (p) => p.includes("\n") || p.endsWith("\r") || p.startsWith('"');
  if (paths.some(odd)) {
    const oids = [];
    for (const p of paths) {
      const one = odd(p) ? await run("git", ["hash-object", "-w", "--no-filters", "--", p], { cwd: root, env }) : null;
      if (one) {
        if (one.code !== 0) return { ok: false, reason: `Toryo couldn't read ${JSON.stringify(p)}: ${firstLine(one.stderr)}` };
        oids.push(one.stdout.trim());
        continue;
      }
      const r = await hashPaths(root, env, [p]);
      if (!r.ok) return r;
      oids.push(r.oids[0]);
    }
    return { ok: true, oids };
  }
  const r = await feed(["hash-object", "-w", "--no-filters", "--stdin-paths"], { cwd: root, env }, paths.join("\n") + "\n", true);
  if (r.code !== 0) {
    // Which file couldn't be read, as Git says it.
    const named = r.err.match(/open\("?([^")]+)"?\)|'([^']+)'/);
    return { ok: false, reason: `Toryo couldn't read ${named ? named[1] ?? named[2] : "a file"}: ${firstLine(r.err)}` };
  }
  const oids = r.out.trim().split("\n");
  if (oids.length !== paths.length) return { ok: false, reason: "Git didn't read every file" };
  return { ok: true, oids };
}

/** A blob of these bytes (a link's target). */
async function hashInput(env, text) {
  const r = await feed(["hash-object", "-w", "--no-filters", "--stdin"], { env }, text, true);
  return r.code === 0 ? { ok: true, oid: r.out.trim() } : { ok: false, reason: firstLine(r.err) };
}

/** Run git with this on its standard input. */
function feed(args, opts, input, keepOut = false) {
  return new Promise((resolve) => {
    const child = spawn("git", args, opts);
    let out = "";
    let err = "";
    if (keepOut) child.stdout.on("data", (d) => (out += d));
    else child.stdout.resume();
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: 1, out, err: e.message }));
    child.on("close", (code) => resolve({ code, out, err }));
    // Git stopping early (it couldn't read a file) closes its input under us: its own reason is what counts.
    child.stdin.on("error", (e) => {
      if (e.code !== "EPIPE") err += `\n${e.message}`;
    });
    child.stdin.end(input);
  });
}

/** What this workspace's last snapshot read: { path: { sig, mode, oid } }. */
function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
function writeRecord(path, record) {
  try {
    writeFileSync(path, JSON.stringify(record));
  } catch {
    /* only a shortcut for the next snapshot */
  }
}

/** What a snapshot can't reproduce in this repository, in words, or null. */
async function unsupportedFeatures(root) {
  const sparse = await run("git", ["-C", root, "config", "--bool", "core.sparseCheckout"], { env: quiet() });
  if (sparse.stdout.trim() === "true") return "it uses a sparse checkout (some files aren't in the folder), which Toryo's snapshots don't support";
  const staged = await run("git", ["-C", root, "ls-files", "-z", "-s"], { env: quiet(), timeout: 300_000 });
  if (split0(staged.stdout).some((line) => line.startsWith("160000 "))) return "it has submodules, whose files a snapshot can't hold, so Toryo's snapshots don't support it";
  // Files Git is told to skip (skip-worktree, "S"): they may not be in the folder at all, which would look like deletions.
  // (Files Git takes as unchanged are read like any other: their bytes are what counts.)
  const tags = await run("git", ["-C", root, "ls-files", "-z", "-t"], { env: quiet(), timeout: 300_000 });
  const skipped = split0(tags.stdout).filter((line) => line.startsWith("S "));
  if (skipped.length) return `Git is told to skip ${skipped.length === 1 ? "a file" : `${skipped.length} files`} (${skipped[0].slice(2)}${skipped.length > 1 ? "…" : ""}), which may not be in the folder; Toryo's snapshots don't support that`;
  return null;
}

/** A workspace id or pin name as a ref and file name. */
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-");

const firstLine = (s) => String(s ?? "").trim().split("\n")[0] || "no reason given";

function quiet() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

function split0(s) {
  return String(s ?? "")
    .split("\0")
    .filter(Boolean);
}
