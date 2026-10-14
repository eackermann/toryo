import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./util.mjs";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Exact snapshots of a project's working tree, kept in a shadow git
 * repository under TORYO_HOME. The project's own .git is only read
 * (borrowed through alternates, with optional locks off); nothing is ever
 * written to it, so `git status` in the project is unaffected.
 */
export class Snapshots {
  constructor(home) {
    this.root = join(home, "shadow");
    mkdirSync(this.root, { recursive: true });
    this.ready = new Map();
    this.locks = new Map();
  }

  gitDir(project) {
    return join(this.root, `${project.id}.git`);
  }

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
    const common = await run(
      "git",
      ["-C", project.path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { env: quiet() },
    );
    if (common.code === 0) {
      mkdirSync(join(dir, "objects", "info"), { recursive: true });
      writeFileSync(join(dir, "objects", "info", "alternates"), join(common.stdout.trim(), "objects") + "\n");
    }
    const info = { dir, top: top.stdout.trim() };
    this.ready.set(project.id, info);
    return info;
  }

  /** Snapshot the tree as it is now. Returns a commit id in the shadow repo, or null. */
  async take(project, label) {
    const previous = this.locks.get(project.id) ?? Promise.resolve();
    const job = previous.then(() => this.#take(project, label)).catch(() => null);
    this.locks.set(project.id, job);
    return job;
  }

  async #take(project, label) {
    const info = await this.ensure(project);
    if (!info) return null;
    const { dir, top } = info;
    const env = { ...quiet(), GIT_DIR: dir, GIT_WORK_TREE: top, GIT_INDEX_FILE: join(dir, "toryo-index") };
    const opts = { cwd: top, env, timeout: 120_000 };

    const head = await run("git", ["-C", top, "rev-parse", "--verify", "-q", "HEAD"], { env: quiet() });
    const base = head.code === 0 ? head.stdout.trim() : null;
    const readTree = await run("git", base ? ["read-tree", base] : ["read-tree", "--empty"], opts);
    if (readTree.code !== 0) return null;

    // Before the first commit there's nothing to diff against: take every path the project's index
    // tracks (read only; their working-tree contents go into the shadow index below).
    const changed = base
      ? await run("git", ["-C", top, "diff", "--name-only", "-z", "--no-renames", "HEAD"], { env: quiet(), timeout: 120_000 })
      : await run("git", ["-C", top, "ls-files", "-z", "--cached"], { env: quiet(), timeout: 120_000 });
    const untracked = await run("git", ["-C", top, "ls-files", "-z", "-o", "--exclude-standard"], {
      env: quiet(),
      timeout: 120_000,
    });
    const paths = new Set([...split0(changed.stdout), ...split0(untracked.stdout)]);
    const keep = [];
    for (const p of paths) {
      try {
        const st = statSync(join(top, p));
        if (st.isFile() && st.size > MAX_FILE_BYTES) continue;
      } catch {
        /* deleted: update-index --remove handles it */
      }
      keep.push(p);
    }
    if (keep.length) {
      const upd = await new Promise((resolve) => {
        const child = spawn("git", ["update-index", "--add", "--remove", "-z", "--stdin"], { cwd: top, env });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => resolve({ code: 1, err: e.message }));
        child.on("close", (code) => resolve({ code, err }));
        child.stdin.end(keep.join("\0") + "\0");
      });
      if (upd.code !== 0) return null;
    }
    const tree = await run("git", ["write-tree"], opts);
    if (tree.code !== 0) return null;
    const parent = await run("git", ["rev-parse", "--verify", "-q", "refs/toryo/latest"], opts);
    const commitArgs = ["commit-tree", tree.stdout.trim(), "-m", label || "snapshot"];
    if (parent.code === 0) commitArgs.push("-p", parent.stdout.trim());
    const commit = await run("git", commitArgs, {
      ...opts,
      env: {
        ...env,
        GIT_AUTHOR_NAME: "Toryo",
        GIT_AUTHOR_EMAIL: "toryo@localhost",
        GIT_COMMITTER_NAME: "Toryo",
        GIT_COMMITTER_EMAIL: "toryo@localhost",
      },
    });
    if (commit.code !== 0) return null;
    const id = commit.stdout.trim();
    await run("git", ["update-ref", "refs/toryo/latest", id], opts);
    return { commit: id, tree: tree.stdout.trim() };
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

function quiet() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

function split0(s) {
  return String(s ?? "")
    .split("\0")
    .filter(Boolean);
}
