# Home and desk controls, Slice 12: Refuse a second builder in the same folder

**Author:** Claude, 14 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 12, with *Guard shared folders after Home and before worktrees*.
**Tree:** uncommitted on top of Slice 11 (`7445532`).
- **New:** `test/folder.test.mjs`, this handoff.
- **Changed:** `src/engine.mjs`, `src/server.mjs`, `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`, `web/app.js`, `test/helpers.mjs`, `test/appthread.test.mjs`, `test/boundary.test.mjs`, `test/desk.test.mjs`, `test/plancheck.test.mjs`, `test/ui-check.mjs`, `test/ui-shots.mjs`, `README.md`, `docs/design-system.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- **Builds in progress** each claim their folder from when they started. If two were building in one folder, the earlier goes on and the later waits; its waiting shows as *Held: “…” is building in this folder*.
- **A new build** in a folder another room is building in is refused, naming it, with the choice to wait.
- **Stored:** `room.folderClaim` (the folder and when it was claimed) is the only new thing saved.

## Round 3: an uncertain app hand-over while its turn is being recorded

**Finding (P1):** a Codex app hand-over that ended uncertain was kept (`room.appTurn`) only after the snapshot that follows a turn. In between, deleting the room was allowed: it abandoned the turn, the uncertain turn was then dropped, and the waiting builder started while the app might be writing.

**Fix (`src/engine.mjs`):**
- **Kept at once.** An uncertain hand-over is kept, and saved, as soon as the app's adapter returns, before the snapshot is awaited.
- **Deletion is refused while any Codex app turn of the room is going on:** being prepared, handed over, followed, or just ended and still being recorded. It's also refused while one is kept, as before. Only the end of that turn, or your letting it go (Stop, then Stop again), makes the room deletable and frees its folder.

**Test (`test/folder.test.mjs`, new):**
- **The uncertain case.** An in-memory app returns from a hand-over with `uncertain: true`, and the snapshot after the turn is held back.
  - While it's held: the turn is kept already (`appTurn.uncertain`), the turn is still being recorded, and deleting the room is refused.
  - Released: the turn is watched for, the waiting build still waits for the app room, and deleting is still refused.
  - Stop, then Stop again: the waiting build goes.
- **The in-progress case.** A second room's hand-over is still going on (*sending*, nothing kept yet), and deleting that room is refused too.
- **Mutations:** each fix taken out fails this test. The first is the uncertainty kept only after the snapshot; the second is deletion checking only a kept app turn.

`npm test`: 244 tests, all passing. The browser check passes.

## Round 2: your five findings

They shared a cause: a claim's life was worked out from the room's state each time. So a claim could come back after it lapsed, lapse while work was still going on, and be ranked differently by different callers. Now:

- **`#keepsFolder(room)`** holds as long as anything the room started is still going, whatever has happened to the room since (stopped, moved on, deleted): a turn running, or a Codex app turn it keeps. Otherwise, it holds while its build is in progress and not stopped.
- **`#settleClaims`** lets go of every claim that has lapsed, for good (`folderClaim = null`, saved). It runs at each scheduler pass, before anything starts, and before a refusal is decided. A room that goes on later takes its folder again through the guard, never with its old place.
- **`#claimants(folder)`** is the one order everyone uses (refusals, the scheduler's reason to wait, the summary): work going on there first (a turn running, a kept app turn), then the earlier claim, then the room's id.

| # | Finding | Fix | Test (`test/folder.test.mjs` unless said) |
|---|---|---|---|
| 1 | P1: Resuming a stopped room revived its old, earlier claim; it started alongside the room that had taken the folder. | Once a stopped room's turns have ended, its claim is let go for good. Resuming it, or writing to it (which resumes it), queues its work behind the guard like any other. | *First* stopped and drained; *Second* builds, then asks you something, so nothing of it is running. *First* resumed: *held*, waiting for *Second*. Stopped again and written to: the same. No second builder starts. (With *Second* still running, the order alone would have hidden this; the test waits for its question first.) |
| 2 | P1: Deleting a room freed its folder while its cancelled turn still ran; an app turn may never end. | **A deleted room with turns still finishing keeps its folder until they end** (`this.draining`). **A room whose Codex app turn is kept can't be deleted** (409): *The Codex app still has a turn from this room and may be writing in its folder. Wait for it to end, or stop the room and press Stop again to let that turn go; then delete the room.* Across a restart: a headless turn doesn't survive one, and a room with an app turn isn't deleted, so its claim is saved with it. | With an in-memory Codex whose turn ends only when the test says, *First* is deleted mid-turn: *Second* (waiting) doesn't start, and names *First*, until that turn ends; then it builds. In `test/boundary.test.mjs`, deleting the room whose app turn Toryo lost track of is refused, and the room stays. |
| 3 | P1: Moving a building room to chat or planning freed its folder while its build turn went on. | The folder is kept while any turn the room started is still running, whatever the room's mode now; the README says so. | For chat (*Chat* mode) and for a planning round started on it: the waiting room doesn't start while the first's build turn runs, and starts once it ends. |
| 4 | P1: After a restart, an older claim beat a room whose Codex app turn was outstanding; both wrote. | Work going on (a kept app turn, a turn running) comes first in the order, before claim age. Following that app turn goes on as before. | An app build submits its turn; a headless build waits. Saved, the headless room's claim is made older than the app room's. After a restart, the app turn is followed again, the headless builder isn't started, and the summaries say the app room holds the folder and the other waits for it. |
| 5 | P2: Two recovered claims with the same time each thought they'd won. | The one order, with the room's id last, decides every question. | The restart test, run again with both claims at the same time: the room with the lower id resumes; the other waits for it; one builder runs. |

- `npm test`: 243 tests, all passing (the folder tests are 9 now). The browser check and the screenshot script pass.
- **Mutations** (in copies of the tree), each failing its test:
  - lapsed claims not let go (1);
  - a deleted room not kept while its turn finishes (2);
  - running work kept only in a build room (3);
  - claim age before work going on (4);
  - deleting a room with a kept app turn allowed (2, the boundary test).
- **Ties:** the order is deterministic by construction. Without the room's id, the existing order of rooms would still pick one, so no mutation of the id alone fails a test. The id is there so the choice doesn't depend on that order.

## What changed

### The folder, as one identity (`src/engine.mjs`)

- **`#folderOf(project)`** is the top of the project's Git working tree, from `git rev-parse --show-toplevel` on the real path. It's found once per project folder.
  - So another project naming the same repository, a symbolic link to it, or a folder inside it is the same folder.
  - A linked worktree has its own top, so it's a folder of its own (the plan says so).
- **Outside Git,** it's the real folder. Two such folders are the same when one is inside the other (`#sameFolder`), since a builder in the outer one writes into the inner one.

### The claim

- **Who holds it.** `room.folderClaim = { root, git, at }`, saved with the room. `#keepsFolder(room)` decides whether the room still holds it (round 2 above): a build in progress keeps it through building, checks and reviews, paused, held, waiting for you, and across a restart. Anything the room started that's still going (a turn running, a Codex app turn it keeps, followed, lost track of or uncertain) keeps it too, whatever has happened to the room since. Once neither holds, `#settleClaims` lets the claim go for good.
- **Which one wins.** `#claimants(folder)` orders the rooms holding a folder: work going on first, then the earlier claim, then the room's id. `#folderHolder(folder, except)` is the first of them, unless it's `except`.
- **Refusing.** `#checkFolder` refuses (409, `code: "folder-busy"`, `room: { id, title }`), naming the room:
  > *“First” is building in this folder (/path), so this build can't start now. You can have it wait: it starts when “First” is done or stopped. A copy of the folder for each room (a worktree) comes in a later update.*

  It's checked before anything changes, wherever a build starts:
  - `createRoom` in build mode, before the room exists;
  - `startBuild` (the room's *Start building*, the `start-build` control);
  - a ready plan's *Start building with this plan* (`answer` with `accept`), before its question closes;
  - a new session's build step (Slice 11), before the session starts.
- **Waiting.** Each of those takes `wait: true`. The room is set up as usual, with no claim; its build's work waits in its queue.
- **The scheduler.**
  - `blockersFor(req, room)` now holds a build's own work back while another room holds the folder, with the reason *“First” is building in this folder*.
  - So the room's status is *held*, `blocked` says why, and the room says once: *Waiting: “First” is building in this folder. It goes on when that ends.*
  - When a build's work starts, the scheduler takes the folder for it (`#takeFolder`); it was free, or the work wouldn't have been eligible.
  - Replies and discussions in a build room (chat, discuss, opinion) don't need the folder.
  - Deleting a room now wakes the scheduler, so a room waiting for its folder goes on (once the deleted room's turns have ended).
- **Builds from before this slice** (`folderClaim` absent) claim their folder at load, from when their build started. Two such builds in one folder: the earlier goes on, the later waits. That's set before anything is dispatched after a restart.

### Who holds it, who waits

- **The room's summary** has `folder`:
  - `{ path, holding: true, waitsFor: null, waiting: [rooms] }` for the room building;
  - `{ path, holding: false, waitsFor: { id, title }, waiting: [] }` for a room whose build waits;
  - `null` otherwise. A stopped room with nothing queued isn't shown as waiting.
- **Home's working cards** carry `folderWaiting`.
- **The page:**
  - The room building shows a *Folder* line in its header, and on its Home card: *“Home plan” waits for this folder to start building.*
  - A waiting room shows *Held · Waiting: “App room” is building in this folder* (the existing held display).
  - A refused start shows the desk's words, with *Wait for “…”, then build*. This is in the new-room form, the room's *Start building* sheet and the new-session sheet. On Home's ready-plan card, the error shows and *Start building* turns into that button. A refusal there leaves the question open, not marked stale.
- **`toryo status`:** each room's line is followed by `building in /path; waiting for this folder: “Four”`, or `waits for its folder: “One” is building in it`.
- **`toryo show` / `toryo_room`:** *Building in /path; waiting for this folder: …*, or *Waits for its folder: …*.
- **`--wait`** on `toryo start build`, `toryo session new … build` and `toryo answer --accept`. MCP's `toryo_start`, `toryo_session_new` and `toryo_answer` take `wait`.
  - A refusal from the command line or MCP ends with: *To have it wait, run it again with --wait (wait: true in MCP).*
  - A start that waits says so: *Started “Four” (build, id …) in repo. It waits for its folder: “One” is building in it.*
- **Over HTTP,** a refusal's JSON has `code` and `room` beside `error`.
- **A folder of its own (worktree)** is offered in words only, as coming in a later update: the plan's worktree slices (14 to 20) make it real.

## How to check

- **`npm test`:** 244 tests, all passing.
- **`test/folder.test.mjs`** (5 tests):
  1. **Refused, then waiting:**
     - With *First* building, a second build is refused (409, `folder-busy`, naming *First*), and no room is created. A chat room's *Start building* is refused too; the room stays in chat.
     - With `wait`: the second room is *held*, its reason is *“First” is building in this folder*, and it says so once. *First* lists it as waiting, and its builder doesn't start.
     - *First* stopped: once its turn has ended, the second builds and holds the folder. *First* starting again is refused, naming the second.
  2. **Kept through the cycle:**
     - A build with checks (`sleep 0.3`) runs through its build, checks and review; at every poll, the waiting room is still waiting.
     - It's paused, Codex is held, and the desk restarts: still the first room's.
     - Released, resumed, and the final review approves: the build is done, and the waiting room builds.
  3. **One folder however it's named:**
     - Refused: another project for the same repository, a symbolic link to it, and a folder inside it.
     - Allowed: a linked worktree, and another repository.
     - Outside Git, a folder and a folder inside it are one.
  4. **Builds from before:** two building rooms saved without claims (as the previous version saved them). After a restart, the one that started earlier holds the folder and resumes; the other waits.
  5. **Two starts at once over HTTP** (`Promise.all`): one 200, one 409 naming the winner.
     - The command line refuses a third with the same words, plus the `--wait` hint. MCP refuses the same way, then starts with `wait: true` and says it waits.
     - `toryo status` shows the holder with *waiting for this folder: “Four”*, and *Four* with *waits for its folder*.
- **Codex app work:**
  - `test/appthread.test.mjs`: after a restart, a stopped room whose app turn is still followed (*stopping*) keeps the folder; another build is refused, naming it. Let go, with nothing running, the folder is free, and a new build takes it.
  - `test/boundary.test.mjs`, new: a build whose app turn Toryo lost track of (following timed out) and was then stopped, with nothing running, keeps the folder. Only *Stop* again (let it go) frees it.
- **Other tests:** four tests from earlier slices started a second build in the same project while the first was going (to test holds, Pause everything, the shared app thread, and recommendations). Their second build now gets a folder of its own (`t.project(name)` in `test/helpers.mjs`: a Git folder of its own, with the same checks).
- **The browser check passes,** steps 0 to 6, with a new step 5y:
  - *App room* (step 2, a Codex app build whose turn never ends) holds the ui folder.
  - On Home, the ready plan's *Start building with this plan* is refused, in the card, naming *App room*. The plan stays ready. *Wait for “App room”, then build* starts it waiting: *The build waits for its folder*.
  - Home, and *App room*'s header, then say *“Home plan” waits for this folder to start building.*
  - The new-room form, a build in the ui project: refused, with the button. Waiting, the room opens with *Held · Waiting: “App room” is building in this folder*.
  - The two refusals are the only errors the browser logs.
  - The build rooms of steps 5l to 5o and 5v (the parser, lexer, docs and checks rooms) now each have a project of their own, since *App room* still holds the ui folder.
- **The screenshot script passes.** Each of its extra builds (busy, failing, finished, held, the sprint room) now has a project of its own, so the rail lists them under their own names.
- **Mutations** (in copies of the tree), each failing a test:
  - **no refusal:** the refusal tests (folder test 1, the app test);
  - **a kept app turn not counted:** the new lost-app-turn test. Until I added that test, nothing caught it: the followed turn in the app test counts as running anyway;
  - **the folder without Git's top (the real path only):** the naming test (the folder inside the repository);
  - **builds from before not claiming:** the restart test;
  - **no reason to wait (the scheduler not holding a waiting build):** folder test 1, where the second builder starts while the first holds the folder.

## Worth a look

1. **Chats and planning rounds aren't held back yet.** A writable chat, or a plan author writing the plan, while a build holds the folder is Slice 13's coordination.
2. **Within Git, nested repositories aren't one folder:** a repository inside another's working tree has its own top. Outside Git, nesting counts.
3. **A waiting build keeps its place in the room's queue,** not a queue across rooms. If several rooms wait for one folder, the scheduler's usual oldest-first order decides who goes next.
4. **The worktree choice** is mentioned, not offered as a button, since it doesn't exist yet. The plan says *once available*.
