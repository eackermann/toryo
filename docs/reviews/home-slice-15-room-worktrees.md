# Home and desk controls, Slice 15: Create and bind a room worktree

**Author:** Claude, 14 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 15, with *Create from the current tree without committing it*, *The app and shared plans* and *Visibility, disk use, and cleanup* (labels only).
**Tree:** uncommitted on top of Slice 14 (`6bbaec1`).
- **New:** `src/worktrees.mjs`, `test/worktree.test.mjs`, this handoff.
- **Changed:**
  - `src/engine.mjs`, `src/snapshots.mjs`, `src/protocol.mjs`, `src/gates.mjs`, `src/server.mjs`, `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`;
  - `src/agents/claude.mjs`, `codex.mjs`, `codexapp.mjs`, `cursor.mjs`, `grok.mjs`, `proc.mjs`, `readonly.mjs`;
  - `web/app.js`, `web/styles.css`, `README.md`;
  - `test/helpers.mjs`, `test/fake-agent.mjs`, `test/ui-check.mjs`, and (one line each, `folderDefault: "shared"`) `test/appthread.test.mjs`, `boundary.test.mjs`, `cursor.test.mjs`, `desk.test.mjs`, `engine.test.mjs`, `folder.test.mjs`, `home.test.mjs`, `notes.test.mjs`, `sharing.test.mjs`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- **New Build rooms** with a headless crew, in a Git project, work in their own worktree (`~/.toryo/worktrees/<project>/<room>`, branch `toryo/<room>`) unless you choose *This folder (shared)*. Rooms that exist stay where they are unless you choose their own worktree in *Start building* (round 2).
- **There's no way back to the main folder yet** (Slices 18–19): a worktree room's changes stay in its worktree. For work you want in the main folder now, choose *This folder (shared)* (`--shared`, `folder: "shared"`).
- **The Codex app** gets a message only once Toryo has checked that its thread works in the room's folder (round 2: strict). A thread whose folder isn't in the app's list, or isn't this room's, gets nothing, and the turn says why.
- **Stored:** a room's `workspace` gains the worktree's fields (`kind: "worktree"`, `root`, `cwd`, `subdir`, `branch`, `source`, `state`, `base`/`baseTree`, `start`, `token`, `attempted`, `error`). The worktree is locked in Git with the room and attempt (round 3). The shadow store gains a pin per worktree room (`refs/toryo/pins/room-<id>-base`) and that workspace's own index, reference and record (Slice 14's names).

## Round 4: the moved-branch fixture's Git identity

**Finding (P2):** the undo test's moved-branch fixture (`git commit-tree`) used the machine's Git identity, so it failed on a machine with none, or with `user.useConfigOnly=true`.

**Fix (`test/worktree.test.mjs`):** it passes the same synthetic identity as the fixture's other commits (`-c user.email=t@t -c user.name=t`).

**Checked:**
- The worktree tests pass with the machine's Git settings turned off and no identity allowed: `GIT_CONFIG_GLOBAL` pointing at a file with only `useConfigOnly = true`, and `GIT_CONFIG_NOSYSTEM=1`.
- The old fixture fails that way (*Author identity unknown*), in a copy of the tree.
- The whole suite passes as usual (286 tests), and also with no Git identity allowed, set up the same way (286 tests).

## Round 3: your four findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: Retry treated a failed branch lookup as "no branch", and `made` claimed ownership before Git had made anything (a branch made by someone else in between could be deleted). | **Ownership is proven by Git's own record of this attempt.** Each attempt has a token, saved before anything is made. The worktree is made locked: `git worktree add --lock --reason "Toryo room <id>, attempt <token>"`. With `-b`, Git makes the branch only together with that worktree, and refuses if the branch is there. `undoWorktree` (`made` is gone) removes nothing unless: <ul><li>the worktree registered at the folder carries this attempt's lock reason, on this room's branch;</li><li>the branch reads without error or warning (`for-each-ref`; a failed or warned lookup is never taken for "no commit");</li><li>the branch is exactly at `start`, or has no commit for an orphan worktree.</li></ul> Not registered means nothing was made, and the branch, whoever made it, is never touched. Gone, moved, unreadable, someone else's or an earlier attempt's: left, with the reason. Git's reason for a failed `worktree add` is now its `fatal:` line (its first line is progress). | `test/worktree.test.mjs` *undoing an unfinished worktree…*: <ul><li>someone's worktree at the path (even on a `toryo/` branch), and an earlier attempt's: left;</li><li>locked as ours but on another branch, or detached: left;</li><li>ours with the branch moved, and with it gone: left;</li><li>an unregistered folder: left;</li><li>no registration but a branch of that name at `start` (the race): untouched;</li><li>an orphan with a broken branch reference, and one whose branch lookup fails (a stand-in `git` failing `for-each-ref`): left;</li><li>ours unchanged (also with its folder gone, leaving another stale registration) and an orphan: removed.</li></ul> Engine (*a folder or branch already where…*): a branch made between Toryo's check and Git's (a hook at that step) is refused by Git, and Retry leaves it. |
| 2 | P2: A refused crew change had already dropped the leaving agents' queued work. | **Everything that can refuse comes first**: the app in a worktree room, then its thread (`#appThreadFor`). Only then do the queue, thread and crew change. | *the Codex app can't join…*: replacing Cursor (with a message queued for it) with the app, refused for want of a thread, leaves Cursor, its queued message and no thread. |
| 3 | P2: A closed form's late answer could land in a reopened one. | **Each form's answers are its own:** the new-room form reads and writes only its own fields and drops an answer once it's closed (`form.isConnected`). The same goes for *Start building*'s sheet. | `test/ui-check.mjs` 5y: open the form, close it, reopen it for the same project. The first answer is held back until after the second. The form shows the second (its room id), not the first. With the check taken out (a copy of the tree), the browser check fails there. *Start building*'s answer is the same for both sheets (one room's folder), so ordering can't change what it shows; the guard is there all the same. |
| 4 | P2: The app test assumed Ubuntu. | **It sets a synthetic distribution** (`WSL_DISTRO_NAME=Ubuntu`) and puts it back, as the next test does. | Passes whatever the machine's distribution. |

**Also:** the README says the worktree is locked in Git (Toryo's mark; it also keeps `git worktree prune` from dropping it), and how Retry checks.

**Mutations,** each failing its test:
- the lock-reason check;
- the branch lookup check;
- validating the crew change after the queue changes;
- the closed-form check (the browser check, in a copy of the tree).

`npm test`: 286 tests, all passing. The browser check and the screenshot script pass.

## Round 2: your six findings

| # | Finding | Fix | Test (`test/worktree.test.mjs` unless said) |
|---|---|---|---|
| 1 | P1: Retry could remove a worktree before checking it was Toryo's; a detached one passed; it pruned the whole repository's worktrees. | (Ownership reworked again in round 3.) **`undoWorktree` checks everything before removing anything** (`src/worktrees.mjs`). If Toryo never began (`made` false), nothing is its own, and a folder at the path is refused. The branch must be where Toryo started it, or no commit for an orphan; moved, the worktree and branch are both left. The registration at the path must be on this room's branch: another branch or none (detached) is someone else's. An unregistered folder there isn't its either. Only then are the worktree (`worktree remove` by its own path, which also works when its folder is gone) and the branch (compare-and-delete) removed. No `worktree prune`. | *undoing an unfinished worktree removes only what Toryo made…*: another branch's worktree; a detached one; this room's with its branch moved; a folder and branch when Toryo hadn't begun; an unregistered folder. All left, with their folders and branches. Then ours, removed: also with its folder gone, leaving another stale registration listed; and an orphan one. |
| 2 | P1: Leaving out `folder` skipped the running-turn guard. | **Every move to a worktree is refused while anything of the room is going** (a turn, checks, a Codex app turn it keeps), whatever chose it, in `#ownFolder` before anything changes. And per your note, **a room that exists stays where it is by default**; only a new room defaults to its own worktree. That covers *Start building*, a ready plan's one click and a new session's build. *Start building* offers its own worktree, preselected *This folder (shared)*. | *choosing where…*: a chat room's build without `folder` stays in the main folder; asked, it moves; with a turn hanging, `own` is refused and an omitted folder leaves it where it is. |
| 3 | P1: The app's folder check let unknown folders through, and dropped the WSL distribution. | **A message goes only to a thread whose folder is known to be the room's.** The adapter reads the thread's folder from the app's list (`localFolder`, `threadFolderIn`). Refused, saying why, and nothing queued: no list; a list that can't be read; the thread not in it; no folder recorded; a WSL path from another distribution than Toryo's (`WSL_DISTRO_NAME`, or none known); a path it can't make sense of. The engine also refuses a folder this machine doesn't have, and a room with its own worktree. `test/appthread.test.mjs`'s stand-in app now has a thread list. | *a thread whose folder Toryo can't tell gets nothing…*: each case through the adapter's real send, nothing queued. *the Codex app stays in the project's folder…*: another folder, then a folder not on this machine, are refused through the engine; this folder is sent. |
| 4 | P2: The app could join a worktree room's crew. | **Refused before anything changes** (`members`), while the worktree is being made or ready. The page doesn't offer *Add* for the app in such a room, and says why. A room saved that way anyway gets nothing: its app turns fail at dispatch. | *the Codex app can't join a room with its own worktree…*: refused while it's made and once it's ready; a saved crew with the app fails its turn and nothing is sent. |
| 5 | P2: A slow preview could show another project's folder; Start could skip the preview. | **The form only takes the answer for the project chosen now** (counter and project check; a slower one is dropped). **A Build doesn't start before its folders are shown:** Start then shows them and asks to press Start again, and the same after adding a project. **The desk refuses a folder other than the one shown** (`workspacePath`, checked in `createRoom` and `startBuild`: 409). | `test/ui-check.mjs` 5y: a slow answer for the first project doesn't replace the second's; Start before the folders are shown starts nothing; the room's folder is the one shown. Engine: a mismatched `workspacePath` is refused (*a folder or branch already where…*). |
| 6 | P2: Worktrees could be made inside the main folder. | **Refused where Toryo's worktrees folder for the project would be inside the project's folder**, by real paths (links in its parents resolved; `realNearest` for a folder not made yet). Asked for, `own` is refused with the reason; by default such a project builds shared. The preview shows why, and making it checks again. | *worktrees aren't made inside the project's folder…*: `TORYO_HOME` in the project, and through a link to it: `own` refused, the preview says why, the default is shared, nothing made there. |

**Also:**
- **Undo needed `made` for anything** (saved just before `git worktree add`), so a branch collision was simply refused again on Retry. Round 3 replaces `made` with the lock token.
- **The README, `toryo help` and the MCP tools' descriptions** say the above (the default for rooms that exist).

**Mutations,** each failing its test: the ownership check; the branch check; the running guard; the default for rooms that exist; the strict app check; the crew refusal; containment; the shown-folder check.

`npm test`: 286 tests, all passing. The browser check and the screenshot script pass.

## What changed

### Where a build works (`src/engine.mjs`: `#ownFolder`, `createRoom`, `startBuild`, `#firstStep`, `answer`)

- **The choice:** `folder: "own" | "shared"` on room creation, *Start building*, a new session's build step, the CLI (`--own` / `--shared`) and MCP (`toryo_start`, `toryo_session_new`).
- **The default** (nothing chosen): a new room gets its own worktree if its crew has no Codex app and the project can have one (see round 2). A room that exists stays where it is (round 2), including for a ready plan's one-click *Start building with this plan*.
- **Refused, with the reason:**
  - the Codex app in the crew (the app works in the project's own folder only);
  - a folder outside Git;
  - Toryo's data folder inside the project's folder (round 2);
  - a room that has its own worktree asking for shared (it stays there);
  - a room with anything going on, moving (round 2).
- **Moving a room** (when you choose its own worktree in *Start building*): its headless agents start new sessions there (`fresh: "folder"`, with *A fresh session* briefing: the room's messages and plan). Its folder claim moves to the worktree.
- **The one-builder-per-folder refusal** now also offers *Or give it its own worktree…* where the crew can have one.
- **The exact path before starting:** `GET /api/projects/:id/workspace` returns both folders and a room id. The form sends the id back (`roomId`, checked: well formed and unused) with the folder it showed (`workspacePath`, checked: round 2), so the room is made with exactly the folder shown. `GET /api/rooms/:id/workspace` does the same for *Start building*.
- **Engine option `folderDefault`** ("own" by default). The test helper sets "shared" so tests of other things stay in the project's folder; the worktree tests use "own".

### Making the worktree (`src/worktrees.mjs`, `Engine.#provision`)

1. **B:** a snapshot of the main folder (Slice 14's complete capture, or refused with its reason), pinned for the room's lifetime (`room-<id>-base`).
2. **`git worktree add --no-checkout --lock --reason "Toryo room <id>, attempt <token>" -b toryo/<room>`** at the main folder's HEAD, or `--orphan` for an unborn repository. Before that, the path and the branch must not exist, and the attempt's token is saved (round 3).
3. **B's files written in it** exactly (`Snapshots.materialize`, new):
   - bytes through `git cat-file --batch`, streamed, never filtered;
   - executable bits and links (link targets as bytes);
   - nothing outside the folder or through a link: `..`/`.git`/empty path parts refused, each parent folder checked to be a real folder, files opened `wx`.
4. **Staged in the worktree's own index** as `git add` would stage them there: `hash-object -w` with its attributes, links by their target bytes, then `update-index --index-info` and `--refresh`. So plain `git diff` starts empty, and `git diff --cached`/`HEAD` shows what it inherited. No commit is made. The main folder's index, HEAD and branches aren't touched.
5. **Checked:** a snapshot of the new worktree (its workspace's first) must have B's tree exactly, or the worktree isn't used. This is the round-trip check for filtered files, links and modes.

**Until it's ready, nothing runs in the room** (`#accessBlock`: *Toryo is making its worktree*).

**Failure:** the room says why and asks *Retry* (a `workspace` question, Toryo's own; no agent hears the answer). A restart during making turns it into the same failure (*Toryo stopped while it was making it*). Retry first undoes the unfinished worktree (`undoWorktree`, checked first: see round 2), then makes it again from the same B. A folder, worktree or branch that was there before, or has changed, is never removed.

### Everything bound to the workspace

- **Agents' folder** (`cwd`): the worktree (at the project's place in it).
- **Checks:** `runGates(..., { cwd })`.
- **Snapshots:** workspace `{ id: room id, path: cwd }`.
- **Read-only mounts:** keyed by folder.
- **File viewer:** new `GET /api/rooms/:id/file`; the page uses it in a room.
- **Plan readers:** `planView`, `#currentSlice`, `#planHash`, `#adoptPlanPath` via `#readRoomFile`. A worktree room reads only its worktree, and *isn't ready* or *is missing* rather than falling back to main.
- **Folder guard and taking turns:** `#roomFolder`, used by claims, uses, refusals and Home. A worktree is its room's alone; "I'm using a folder" on main doesn't hold it.
- **A worktree that isn't there** (or isn't ready) at a turn or a checks run fails it with *Toryo won't run the turn in the project's main folder instead*.

### The briefing (`src/protocol.mjs`: `preamble({ workspace })`)

The `Repository:` line names the worktree. The main folder is named once: as off-limits (*don't edit, create or delete anything there…; this room's changes reach it only when the owner brings them back*). Then the staged starting point: plain `git diff` vs `--cached`/`HEAD`, and that Toryo's comparison with the starting snapshot is what counts.

### Protecting the main folder (`#protectMain`, the adapters)

- **Claude:**
  - every turn in a worktree room gets `--disallowedTools Edit/Write/NotebookEdit(//<main>/**)` for the main folder (by its Git top, its configured path and its real path);
  - a read-only turn also gets them for its worktree, as before.
- **The read-only mount** (Claude, Cursor, Grok; `proc.lockFor`):
  - a worktree room's read-only turns mount the worktree and the main folder read-only;
  - its writing turns mount the main folder read-only, except, mounted again writable inside it (new in `readonly.mjs`): the worktree's own Git folder (index, HEAD), the project's objects, and `refs/heads/toryo` and `logs/refs/heads/toryo`. So `git add` and a commit on the room's branch work, but not main's index, HEAD or other branches.
  - `"readOnlyMount": false` leaves the mount out, as before.
- **Codex:**
  - its sandbox is the worktree (`-C`, the process folder);
  - writing turns add those Git folders to `writable_roots`;
  - main isn't in it (unless its permissions are `full`, as before).
- **Where mounts aren't available,** the room's *ready* line says so: shell commands could still write in main.

### The Codex app (`src/agents/codexapp.mjs`)

- **Shared folder only:** a crew with the app can't have its own worktree, and the app can't join a room that has one (round 2).
- **Checked before each send** (not when following a turn already handed over):
  - the adapter reads the thread's folder from the app's thread list, translating `\\wsl.localhost\<distro>\…` and `\\wsl$\…` (this distribution only) and `C:\…`;
  - the engine compares it with the room's folder (`#appFolderProblem`: the same Git working tree, or one folder inside the other);
  - anything else gets nothing, and the turn fails saying why (round 2: a folder that can't be told is refused too).
- **Only the adapter's real send reads the app's data,** so tests that fake the app's send never touch it.

### Shown

- **Room header:** *Own worktree* `<path>` *Copy path* · branch, and its state while it's made or after it failed. A shared folder lists the other rooms using it. On a narrow screen (where the header's folder line was hidden), a worktree room keeps *Own worktree · Copy path*. System lines in the room wrap a long path anywhere, so a worktree's path doesn't push the page sideways at 320px.
- **Home:** rows and work cards say *own worktree*.
- **`toryo status`:** `own worktree: <path>, branch …; main folder …` (or `shared folder: …; also used by …`).
- **`toryo show` and MCP's room tool:** the same, after the session line.
- **Delete sheet:** says the worktree and branch stay; removing them comes later.
- **New-room form and *Start building*:** *Where it works*, with both exact folders.

## How to check

- `node --test --test-concurrency=1 test/*.test.mjs`: 282 tests, all passing.
- The browser check (`test/ui-check.mjs`) passes. Its step 5y now covers:
  - the ready plan starting in its own worktree;
  - the header and Home labels;
  - the form's two folders;
  - choosing shared there still being refused and waiting.

  - at 390px, *Own worktree* and *Copy path* in the header.

  The other steps that test the shared folder ask for it (`folder: "shared"`).
- The screenshot script (`test/ui-shots.mjs`) passes. Its build rooms now have their own worktrees, including at 320px.
- **The fake agent** (`test/fake-agent.mjs`) now logs each call's folder (`cwd`) and can run shell commands in it (`sh`, each one's outcome in its reply), so tests see where agents ran and what their commands could write.
- **`test/worktree.test.mjs`** (11 tests):
  1. **Two rooms from a dirty main folder** (staged and unstaged edit, untracked file, deletion, executable bit, link):
     - each builder ran in its own worktree, with the main folder's files exactly;
     - each worktree's `write-tree` equals B, and B stays pinned; no commit, HEAD the same;
     - plain `git diff` is empty, the room's new file is `??`, and the turn's diff is only that file;
     - a later edit of an inherited file shows in `git diff`, and the other worktree is unaffected;
     - the main folder's status, index (bytes), HEAD, branches, commits and file list are unchanged; only `toryo/*` branches were added.
  2. **Briefing:**
     - Codex's first prompt names the worktree, and the main folder once, as off-limits;
     - the resumed prompt doesn't name main;
     - Claude's instructions do the same on its review turn;
     - the reviewer ran in the worktree, with edits denied there and in main.
  3. **Protection:**
     - Claude building: edits denied in main;
     - with the mount, `echo > main/hack.txt` fails while a write and `git add` in the room work;
     - Codex: `-C <worktree>`, its writable roots hold the worktree's Git folder and objects, not main.
  4. **An unborn repository, the project in a subfolder, a space in the path:** an orphan worktree, the agent in `<worktree>/app`, everything staged, no commit anywhere.
  5. **Failure and restart:**
     - a step failing: the room asks to retry, nothing runs, and Retry makes it, with one registration;
     - Toryo stopping mid-way (a new engine on the same data): *Toryo stopped while it was making it*, then Retry undoes and makes it.
  6. **Collisions:**
     - a folder already at the path: refused, and Retry leaves it, saying it isn't this room's;
     - a reused room id: refused;
     - a branch already there: refused, and Retry leaves it, even at HEAD.
  7. **Links pointing outside:** kept as links, nothing written there.
  8. **The Codex app** (a stand-in app with a synthetic thread list, `\\wsl.localhost\…` folder):
     - `own` is refused for its crew;
     - a thread in another folder gets nothing;
     - once the thread's folder is the project's, it's sent.
  9. **Folder-sensitive paths:**
     - the checks' `pwd`, the reviewer's folder, the file viewer, the plan (after main's copy changed) and `..` refused;
     - the worktree deleted behind Toryo's back: the turn fails saying so, and no agent runs.
  10. **The choice:**
      - outside Git: own refused, shared by default, no preview;
      - an invalid choice refused;
      - a chat room's first build moves: a new Codex session in the worktree, with the *fresh session* line;
      - it can't go back to shared;
      - a room that built shared stays shared;
      - a room with a turn running can't move.
  11. **Shown:** summary, Home, `toryo status`, `toryo show`, and MCP `toryo_start` with `folder`.
- **Mutations** (each fix taken out, in copies of the tree), each failing its test:
  - agents run in `project.path` instead of the room's folder;
  - no main-folder deny for Claude's writing turns;
  - no main-folder protection for read-only turns;
  - undo deleting a branch it didn't make;
  - the writable Git folders left read-only (then `git add` fails);
  - a main-folder `Repository:` line;
  - the app thread's folder never checked.

## Worth a look

- **Staging uses Git's own view** (filters and attributes) for the worktree's index, while the files are B's exact bytes. For a file with a clean filter or line-ending conversion, the index then holds what `git add` would. Plain `git diff` stays empty, and Toryo's comparisons use B. Without filters (the tests), the index tree equals B's tree.
- **Writable Git folders under the mount:** `refs/heads/toryo` is shared by every room's branch, so one room's agent could move another room's branch (not main's). `packed-refs`, `config` and hooks stay read-only.
- **Not verified against real CLIs:** Codex with extra `writable_roots` inside `.git`, and the Codex app's real thread list (`cwd` column) on the owner's machine. Since the check is now strict, an app room whose thread's folder can't be read or isn't its project's gets a refusal naming the reason, instead of a send. The fix is to choose a thread opened in the project's folder.
- **`git worktree list --porcelain -z`** needs Git 2.36, `--orphan` Git 2.42; this machine has 2.53. Older Git fails creation with Git's reason.

## What remains (later slices)

- Copied files and setup (16).
- Project-wide check order and room environment values (17).
- Full B → R review and a return preview (18).
- Apply (19).
- Disk use and removing worktrees (20).

The page says the return and removal are pending: on the *ready* line, the form and the delete sheet.
