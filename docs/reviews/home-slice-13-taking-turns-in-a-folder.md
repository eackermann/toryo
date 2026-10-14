# Home and desk controls, Slice 13: Coordinate plan and chat writes between turns

**Author:** Claude, 14 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 13, with *Guard shared folders after Home and before worktrees* (the short reservations, the changed-file note, *I'm using this folder*, stale reviews).
**Tree:** uncommitted on top of Slice 12 (`b92ca90`).
- **New:** `test/sharing.test.mjs`, this handoff.
- **Changed:** `src/engine.mjs`, `src/snapshots.mjs`, `src/desk.mjs`, `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`, `web/app.js`, `test/boundary.test.mjs`, `test/home.test.mjs`, `test/ui-check.mjs`, `test/ui-shots.mjs`, `README.md`, `docs/design-system.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision; the readings of the plan I chose are under *Worth a look*.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- **Writers and reviews take turns** in each folder, as below. Work waiting for a quiet moment shows as *Held*, with the reason.
- **Home** has *I'm using a folder…*. `toryo folder use|release` and `toryo_desk`'s `use-folder` / `release-folder` work.
- **Stored:**
  - `desk.json` gains `folders` (folders you're using). It stays at version 2; a file without `folders` has none.
  - A review turn can have `outOfDate`.
  - A build room can get a system line with `writesFrom` and `files`.

## After approval: your P3

The question when Toryo couldn't compare now ends with what to do if snapshots can't work in the folder at all: *If snapshots can't work in this folder at all, looking again will ask this again: fix snapshots there, or turn them off for this room in Room settings (then nothing is compared).* The round 4 test still passes.

## Round 4: a comparison from the review's start that fails

**Finding (P1):** a turn giving a review's verdict later compared from the review's start without `strict`. A failed comparison gave [], which then replaced the changes the turn had seen itself, and the slice was approved.

**Fix (`src/engine.mjs`):**
- **The comparison from the review's start is strict:** failed is null, not [].
- **What changed is the union:** what the comparison found, plus what the turn saw change itself. So changes already seen are never dropped.
- **A comparison Toryo tried and couldn't make leaves the verdict not known** (`staleUnknown`), whether it's from the review's start or the turn's own. That approves nothing by itself. You're asked: *Toryo couldn't tell whether files changed since Claude's review began (comparing its snapshots failed), so its approval may not cover the files as they are now. Should Claude look again?*, with the recommendation to look again.
- **Carried on like `outOfDate`** past an answer to your question.
- **With snapshots off,** nothing was tried, so nothing changes (as before).

**Test (`test/sharing.test.mjs`).** In each case a first review leaves a finding (L1), and comparisons from the second review's start fail.
- **A status-only follow-up:** not known, and you're asked.
- **A status-only follow-up during which a file changes:** `outOfDate: ["changed.txt"]` is kept, and you're asked about it.
- **An answer to your question that carries the approval on:** not known, and you're asked.
- **In all three:** nothing is approved, and L1 stays open.

**Mutations:**
- **The comparison not strict:** fails this test.
- **An unknown verdict let through:** fails this test.
- **Without the union:** passes. When the comparison fails, falling back to the turn's own list keeps what it saw. When it succeeds, it already includes the turn's own changes. The union is kept anyway, so neither depends on the other.

**`src/snapshots.mjs`** (its strict mode, round 3) is now in the list of changed files above.

`npm test`: 260 tests, all passing. The browser check passes.

## Round 3: four more cases

| # | Finding | Fix | Test (`test/sharing.test.mjs`) |
|---|---|---|---|
| 1 | P1: A review's approval, carried past an answer to your question, was taken though files changed meanwhile. | **A turn that carries a review's verdict on later** is checked from the start of that review, as status-only turns already were: an answer to your question (`note-answer`, and the older `note-reply`). The changes between that review's first snapshot and this turn's last are its `outOfDate`, carried with the verdict into `#afterBuild`. There it asks you, with no slice approved and no finding settled. | A first review asks for changes (a finding, L1). The second review is approving when you ask Claude something, and a writable chat waits. The chat writes `meanwhile.txt` before Claude's answer. The answer carries the approval on: you're asked (*Files changed while Claude was reviewing (meanwhile.txt)…*), nothing is approved, and L1 is still open. |
| 2 | P2: A writer that failed, with its changes unknown, sent no note. | **Each turn records whether its agent had it** (`reached`: it got past preparing). A writer that had it and whose changes aren't known sends the *may have changed files* note whatever became of the turn: done, failed, timed out, stopped. Acting on it again after a restart does the same (turns from before count as reached if done). | Snapshots that fail in the writer's room, and a writer that fails: `filesKnown: false`, `reached: true`, and the note. Then that note is removed from the build's saved timeline and the failed turn is made pending: at the next start, the note is there once. |
| 3 | P2: A comparison that failed was taken for "nothing changed". | **`Snapshots.changes` with `strict` gives null when the comparison fails**, as opposed to [] when nothing changed. Callers that only show a diff keep getting []. A turn's change list uses it: failed is `filesKnown: false`, and its writer's note says which files isn't known. | Two snapshots taken but not compared: the turn is done, with both snapshots and `filesKnown: false`, and its note. |
| 4 | P2: Overlapping folders outside Git offered release targets that didn't exist. | **Each folder you're using lists `projects` (whose folder it is, exactly) and `covers`** (every project it keeps Toryo out of). Home's sheet offers *Release* for any covered project, by the stored folder, saying when it's a folder around that project. `toryo status` names a project only when it's exactly that folder. Releasing by a project that's only covered says which folder to release instead. | Outside Git, a folder and a folder inside it, as two projects, in both orders. The parent in use: it lists the parent, covers both; releasing by the child says to release the parent's folder; releasing by the folder works. The child in use: released by its own id. |

- `npm test`: 259 tests, all passing (the sharing tests are 15). The browser check and the screenshot script pass.
- **Mutations** (each fix taken out, in copies of the tree), each failing its test:
  - **1:** no check from the review's start for an answer to your question;
  - **2:** the unknown note only for finished turns;
  - **3:** two snapshots taken read as "known";
  - **4:** `projects` listing every overlapping project.
- **The older description below is brought up to date with round 2:** readers wait while another room writes; folder waits aren't shown as *Waiting:* lines or held time.

## Round 2: your seven findings

| # | Finding | Fix | Test (`test/sharing.test.mjs`) |
|---|---|---|---|
| 1 | P1: A new Codex app request counted as writing only once admitted. | **`#writes` counts any request to the Codex app as writing**, before admission, whatever access it asks for. A turn following one the app already has (`attach`) still goes as before. | A read-only question to the app, in another room, while the builder writes: it waits, *Codex is writing in this folder for “Build”*, and is handed over only once the builder's turn ends. An app review is a writer the same way, so it can't overlap a review. |
| 2 | P1: Deleting a room without a builder claim hid its running turn. | **Every deleted room with turns still running goes to `draining`** until they've ended (to their last snapshot), claim or not. Its turns keep counting as uses of the folder. | A writable chat whose in-memory Codex doesn't stop when told to: its room is deleted; the next writer waits, naming it, until that turn ends. |
| 3 | P1: A change between a review and its status-only follow-up wasn't caught. | **A status-only answer's verdict is checked from the start of the review it gives the verdict of.** The changes between that review's first snapshot and the status turn's last are its `outOfDate`. Approving then asks you, as for a review during which files changed. (A review answer after your reply is checked over its own turn: it can look again, and the build's line about changed files reaches it first.) | A review ends without a status; a writable chat, waiting, writes `between.txt` before the status turn; the status says APPROVED. It's out of date (`between.txt`), you're asked, and nothing is approved. |
| 4 | P2: The recorded decision asks for a gap with no active turn at all. | **Writers wait for every turn in the folder,** read-only ones included. **Read-only turns from other rooms wait while something writes**, or while a writer that's ready waits for its gap (so readers can't keep it out). The one exception is kept on purpose: a build's own room still answers your questions beside its builder (Toryo's existing short read-only turn *beside the work*). Its reviews never overlap its builder anyway. | Both orders: a reply being written, then a writable chat: the chat waits (*Claude is reading this folder for “Reading”*) and starts after. Then the writer first, and a reply asked: it waits (*Codex is writing in this folder for “Writing”*), and comes after. |
| 5 | P2: An unknown change list sent nothing, and recovery dropped the note. | **Each turn records whether its changes are known** (`filesKnown`: snapshots on and both taken). A writer with unknown changes sends *may have changed files … (which ones isn't known: Toryo couldn't list that turn's changes)*. Acting on a turn again after a restart sends the same, once. | Snapshots that fail in the writer's room: the unknown note, and `filesKnown: false`. Then that note is removed from the build's saved timeline and the writer's turn is made pending, as if Toryo had stopped between the two. At the next start the note is there once. |
| 6 | P2: Agents got only the first 20 paths. | **The agents get every path:** the line names 20 and says *all of them below*, and their catch-up adds the full list. The page folds the full list under the line (*All 21 files*). | 21 files written: the line says *and 1 more (all of them below)*, and the build's reviewer's prompt has `- file-21.txt`. |
| 7 | P2: Renaming a project broke releasing its folder. | **Released by the folder itself**: Home's *Release* sends it, and `release-folder` accepts it. Otherwise by a project: its id or current name. Each folder you're using lists the projects in it (`projects`, their ids). `toryo status` prints the release command with the id, and Home's sheet matches by id. | The project renamed after *use-folder*: the folder still lists `repo`; `toryo status` says `toryo folder release repo`; releasing by the folder and by the id both work. |

**Other tests changed by the stricter rule (4):**
- **The sharing tests' plans:** their proposals now happen before the build starts writing, since a proposal (read-only) doesn't start in another room while a builder writes.
- **`test/home.test.mjs`:** two rooms working at once are now in two folders (a reply doesn't run beside another room's builder). A quiet room in the build's folder keeps the "rooms in the same folder" check.
- **`test/boundary.test.mjs`:** rooms on different app threads that run together are in different folders (app work is writing).
- **The room's *Waiting:* line** (and the session strip's held time) stays for desk-wide controls only: a wait for the folder shows in the room's status, with its reason, without a line in the transcript.

- **The browser check and the screenshots, under the stricter rule.** Rooms whose turn never ends there now keep other rooms' replies out of their folder.
  - The check lets its *App room*'s Codex app turn go (Stop twice) once step 4 is done, and stops its step 5d planning room (whose author never finishes) once checked.
  - The screenshot script's chat and planning rooms get folders of their own, since its history build never ends.
- `npm test`: 256 tests, all passing (the sharing tests are 12 now). The browser check and the screenshot script pass.
- **Mutations** (each fix taken out, in copies of the tree), each failing its test:
  - **1:** app requests not counted as writing;
  - **2:** only rooms with a builder claim kept after deletion;
  - **3:** no check from the start of the review;
  - **4:** readers not waiting for another room's writer (also fails the gap test);
  - **5:** recovery taking every list as known;
  - **6:** the catch-up without the full list;
  - **7:** no release by the folder. A first version of that test passed anyway, because its project sat at the folder's top. It now also releases a project in a subfolder of a repository, whose folder is no project's path.

## What changed

### Taking turns (`src/engine.mjs`, `#accessBlock`)

The scheduler asks this for each queued request, after everything that already held work (desk pause, holds, the guard, the builder's folder from Slice 12). The answer shows in the room's status and summary like any other wait: *Held*, with the reason.

- **Writers** are requests with write access (a builder, a plan's author writing or revising the plan, a chat you allowed to change files), plus the project's checks and anything handed to the Codex app, counted before it's let in. A writer starts only at a quiet moment:
  - no other turn of any kind there, in any room, read-only ones included;
  - no checks, and no review;
  - turns being prepared count, and so does a Codex app turn a room keeps (kept, lost track of, uncertain), since the app may be writing.
  - *It waits for a quiet moment in this folder: Codex is writing in this folder for “Long build”.*
- **Read-only turns** (replies, proposals, reviews) from other rooms don't start while something writes there, nor while a writer that's ready waits for its moment: *Codex is writing in this folder for “Writing”*.
  - A build's own room may still answer your questions beside its builder (round 2).
  - Reviews keep writers out for their whole turn: *Claude is reviewing in this folder for “Build”*.
- **Who goes first.** A plan's author or a writable chat that's ready (nothing but the folder holds it) goes before the build's next step: its next turn, its checks or its review.
  - *Claude writes in this folder for “Plan room” first.*
  - The build keeps its folder (Slice 12) and goes on afterwards.
  - An author that's held, paused, or waiting for you isn't "ready", so it doesn't keep the build waiting.
  - Between two such writers, the older request goes first. The scheduler starts one request at a time and looks again after each, so two writers are never admitted together.
- **A folder you're using** gets nothing new from Toryo at all: *you're using this folder*.
- **Folders** are the same ones as Slice 12's (`#folderOf`, `#sameFolder`). Uses are counted across all rooms, deleted rooms whose turns are still finishing included.
- **The room's *Waiting: …* line** stays for desk-wide controls (Pause everything, holds, the guard): a wait for the folder shows only in the room's status, with its reason, and isn't counted as held time on the session strip.

### The build is told what changed

When a writer that isn't the build's own work (a plan's author, a writable chat) ends having changed files, the room holding that folder's builder claim gets a line. That's another room. For example:

> *Between this build's turns, Claude changed files in this folder for “Plan room”: docs/plans/next.md. Take them into account before going on.*

- **How it's delivered.** It's a system line for the agents (`forAgents`), so each of its agents reads it with their next turn's catch-up.
- **Durable, sent once.** It's kept in the room's timeline, so a restart doesn't lose it. It's sent once: `writesFrom` names the writer's turn, and it's checked before writing.
- **Also after a restart.** Toryo acting on that turn again after a restart (`#reconcile`) sends it too, if it isn't there yet.
- **Which files.** They come from the writer turn's own snapshots, which only show its changes, since nothing else wrote meanwhile.
  - When they can't be known (snapshots off, not taken, or not compared), the line says *may have changed files … (which ones isn't known)*. That goes for any writer that had the turn, whatever became of it, also when acted on again after a restart (rounds 2 and 3).
  - The agents get every path; the page folds the full list under the line.
- **It changes nothing in the flow:** no approval, no new build.

### A review during which files changed

- **Marked out of date.** A review turn during which files changed gets `outOfDate` (the paths). It's read-only, so the change came from someone else; Toryo's own writers are kept out by the rule above, so in practice it's an editor or another program.
- **The existing warning stays:** *Files changed during … read-only turn*.
- **If it approves anyway:** the approval doesn't approve the slice and doesn't settle findings. The room asks you, as the reviewer's question:
  > *Files changed while Claude was reviewing (edited-meanwhile.txt), so its approval may not cover them. Should Claude look again?*

  The recommendation is to look at the changed files again, then give a verdict. Accepted, Claude reviews again, and that verdict counts.
- **Verdicts given later.** A status-only turn's approval, and a review's approval carried past an answer to your question, are checked from the start of that review (rounds 2 and 3).

### A folder you're using

- **The desk file:** `desk.json` keeps `folders: { <folder>: { at, git, name } }`. A malformed entry makes the desk unusable rather than being dropped, like a hold.
- **Desk actions:** `use-folder` and `release-folder` take `{ project }` (an id, a name or a path).
  - They're saved before they're acknowledged. `use-folder` is a restriction, so it applies even if saving fails.
  - The reply names what's still finishing there, and says plainly that Toryo can't see what you do: it only keeps its own work out.
- **Command line:** `toryo folder use|release [project]`.
- **MCP:** `toryo_desk` with `use-folder` / `release-folder` and `project`.
- **`toryo status`:** *You're using /path (since …): toryo folder release <project id, or the folder>*.
- **What each folder in use names:** the projects whose folder it is exactly (`projects`), and every project it keeps Toryo out of (`covers`). Release targets always name the stored folder (round 3).
- **Home:**
  - *I'm using a folder…* in the desk bar opens a sheet listing each project's folder, with *I'm using it* or *Release*.
  - A folder in use shows as a chip, *You're using /path*, with *Release*.
- **Across a restart:** it's restored with the desk before anything starts.

## How to check

- **`npm test`:** 250 tests, all passing.
- **`test/sharing.test.mjs`** (6 tests; an in-memory Codex whose turns end when the test says, and the fake Claude):
  1. **The gap.**
     - A builder works; a planning room's author (Claude) is ready to write the plan. It waits, *held*, with the reason, and its turn doesn't start. A second build in the folder is still refused.
     - The builder's turn ends: the author writes `docs/plans/next.md`, and only then does the build's review start.
     - The build room gets the line once, with the file. The reviewer's prompt has it. The build still holds its folder.
  2. **Reviews.**
     - With a review going, a writable chat in another room waits (*Claude is reviewing in this folder for “Build”*). It starts only once the review has ended, with write access.
     - A file edited from outside during the review marks it out of date: its approval asks you instead, and nothing is approved. Accepted, Claude looks again, and the slice is approved then.
  3. **Held author, pause, two writers.**
     - With Claude (the author) held, the build's checks run.
     - Then everything is paused, Claude released, and a writable chat queued. On resume, the author writes before the build's review, then the chat.
     - Sampled every 5 ms, no two writers (or checks) ever run at once.
  4. **A folder you're using.**
     - The command line says so. A chat's turn waits (*you're using this folder*). `toryo status` lists it. MCP's `release-folder` says *Released*, and the reply comes.
     - After a restart it still holds. An unknown project is refused.
  5. **Once, also after a restart; app turns.**
     - The author's line reaches the build once. With the author's turn made pending again in the saved room, the restart acts on it again (*reconciled*), and there's still one line.
     - A Codex app turn kept by the build room keeps a writable chat waiting.
  6. **Author first, even when queued later.** Everything is paused; the build's checks are queued, then the author. On resume, the author writes before the checks run.
- **The browser check passes,** steps 0 to 6, with a new step 5z:
  - *I'm using a folder…* on Home, *I'm using it* for the ui project: the chip shows.
  - A message in a ui room starts nothing, and its room says *you're using this folder*.
  - *Release* on Home: the reply comes, and the chip goes.
- **Other changes to the browser check.** Its *App room* (step 2) keeps a Codex app turn that never ends in the ui folder. So the two planning rooms whose authors write (5q, 5t) now each have a project of their own. Step 5y's refusal now names a build started for it (*Busy here*) in the Home plan's folder.
- **The screenshot script passes.** Its export plan has a project of its own, since the history build's builder never ends there. Home now shows *I'm using a folder…*.
- **Mutations** (in copies of the tree), each failing a test:
  - **no priority for the author:** test 6;
  - **a folder you're using ignored:** test 4;
  - **reviews not keeping writers out:** test 2;
  - **no line to the build:** tests 1 and 5;
  - **reviews never marked out of date:** test 2;
  - **writers not waiting for each other:** tests 1, 3, 5 and 6.

## Worth a look

1. **Which turns take turns** (round 2): every turn in the folder, as the recorded decision says, with one exception kept on purpose. A build's own room may answer your questions beside its builder, in the short read-only turn Toryo has always run *beside the work*. Taking that away would make every question to a reviewer wait for the builder's turn to end.
1b. **What the stricter rule costs** (for the owner to know): a chat or planning room on the same folder as a running build now gets its replies only between the builder's turns, since nothing reads a folder while it's being written. This is what *known writers and readers don't overlap* asks; the build's own room still answers your questions beside its builder. Asking in a room on another folder (or, later, a worktree) avoids the wait.
2. **Checks count as writers,** since their commands can write (builds, caches). **Codex app turns count as writers** whatever their access, since the app follows its own permissions.
3. **A folder you're using stops all new work there,** read-only turns too, since you may be in the middle of changing files they'd read.
4. **A stale approval asks you** rather than re-queuing the review by itself, so a folder that keeps changing doesn't loop.
5. **Not covered here:** reviews of a plan (plan checks) that go stale are marked out of date, but their verdict isn't held back; only a build review's approval is. Setup commands don't exist yet (worktrees, Slice 16), so there's nothing to coordinate for them.
