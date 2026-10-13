# Home and desk controls, Slice 2: durable graceful holds and desk pause

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 2
**Tree:** uncommitted. The plan and `docs/decisions.md` are untouched; the behavior follows decisions already recorded. Nothing needs an owner decision.

**Restart:** none of this is live yet. The running desk has the code from when it started, so Pause everything, holds, `desk.json`, the *Held* labels, the scheduler and Slice 1's changes take effect only after the owner restarts it (`toryo quit && toryo`). After the restart, the desk writes a `desk.json` with nothing paused or held, and nothing changes for running rooms until a control is used.

## Round 3: your three findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | A failed reset could still release work after a restart | `desk.json` is now never missing. `#resetDesk()` *copies* an unreadable file aside (`Store.copyFile`, which never overwrites), then replaces `desk.json` with the new controls in one step (`Store.writeJson`: a temporary file, then `Store.rename` over the old one). If the copy, the write or the final rename fails, the old file is still at `desk.json`, the copy is removed, and nothing changes, so a restart finds the same unreadable file and still holds everything. `Store.writeJson` now also removes its temporary file when the rename fails; file operations go through `Store.rename` and `Store.copyFile` so they can be made to fail in tests. | "a reset whose final replace or copy fails leaves the unreadable file in place, so a restart still holds": once with `rename`, once with `copyFile` failing on `desk.json*` (EROFS). Each time: "Nothing changed", the old bytes are at `desk.json`, there's no copy or temporary file, and the problem stays. After a restart, it's still unreadable and nothing has started. The round-2 test (the write fails) still passes. |
| 2 | Notes could overtake another room indefinitely | A notes turn (`build-notes`, `note-answer`, and the older `note-reply`) gets its own queue time when it's queued, as new work. At the front of its room's queue it still comes before that room's other steps, but across rooms it competes as new, so another room's older request goes first. A retry or an interrupted turn is the same request continuing, and keeps its time. | "a notes turn queues as new work: another room's older request on the shared app thread goes first". Rooms A and B share a Codex app thread. A builds (A1), B's build queues (B1), and a note reaches A while A1 runs. When A1 ends, B1 starts, then A's notes turn: A1, B1, A-notes. |
| 3 | Re-entry during the waiting notices lost the wake-up | The "Waiting" notices are now inside the scheduler's retry loop. Whoever hears one may release a hold or queue a note, and that's looked at in the same run: `scheduleAgain` is read after the notices. `room.deskNotice` is set before the event goes out, so the same notice isn't sent twice. | "releasing a hold, or queueing work, from inside a room's Waiting notice is acted on at once". On the "Waiting: you hold Codex" event, a listener queues a note to Claude in another room and releases Codex. Both turns run and nothing is left queued. |

`node --test` runs 114 tests, all passing.

**Your P3** (the Settings sheet) is another room's code, and I've left it to them, as you suggested. That room's model list throws in `syncEffort` when Settings closes before Cursor's model list arrives. `node test/ui-check.mjs` still fails only on its final "no page errors" assertion, for that error, after all of its steps have passed. The fix is to check that the sheet's elements still exist after `await api(… /models)` in `fillModels`.

## Round 2: your three findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | A reset that failed to save released work | `reset` is now `#resetDesk()`, and it writes before it touches anything. The new controls go to `desk.json.reset`, then the unreadable file is renamed aside, then the new file is renamed into place. If any step fails, the old file is put back if it had been moved, the staged file is removed, and `desk` and `deskProblem` are left exactly as they were, so the reply's "Nothing changed" is true and nothing new starts. The problem clears only once the new file is in place. After a failed reset, a restart still finds the unreadable file, so it still holds everything. | "a reset that can't be saved changes nothing: the unreadable file stays, nothing starts, and a restart still holds". With writes to `desk.json*` failing: the reset is a 500, the problem stays `unreadable`, and the file is byte-for-byte the same with nothing set aside or left over. The queued turn doesn't start, a new engine is still `held`, and a reset that can save then lets the turn run. |
| 2 | Scheduling didn't keep oldest-eligible order | There's now one scheduler, `#schedule()`. It first follows any Codex app turn the app already has. Then, again and again, it admits the single oldest request that can start now (`queueOrder`: `queuedAt`, then room, then place in the queue), across all rooms, and recomputes after each start. It's guarded: a call during a run makes it look once more, never nested. `#pump(room)` and `#pumpAll()` just call it (and save the room), so queueing, a turn ending, an error and every control go through it. Continuation steps keep the `queuedAt` of the step they continue (retries, interruptions, notes turns), so a room doesn't lose its place by taking another step. Requests queued before this change get one when their room loads. | "across rooms, requests start oldest first one at a time: A1, B1, A2": in-process agents, snapshots off, so starting is synchronous; A1 to Codex in room A, B1 to Codex in room B, A2 to Claude in room A, all while paused, then resume. "when a shared Codex app thread frees up, the older request from another room goes before this room's newer one": A1 runs; B1, then A2 queue; when A1 ends, B1 starts, and A2 only after B1. |
| 3 | Requests behind a hold had no accurate waiting status | `#heldUp(room)` is the one calculation of what holds each queued request up. Desk-wide controls give a request its own reasons. A request that isn't running beside the work, and comes after a held step that isn't either, waits behind it: "it comes after Codex's turn, which waits (you hold Codex …)". Starting (`#nextStartable`), the room's status (`held` when every queued request is held up) and `summary().blocked` all use it. | "work queued behind a held step shows as held too, with the reason it waits". Codex is held, and a note asks both agents to change files. Both requests are listed: Codex's with the hold, and Claude's with "it comes after Codex's turn, which waits (…)". The room is `held` and nothing runs; releasing runs Codex, then Claude. |

`node --test` runs 111 tests, all passing.

**The browser check** (`node test/ui-check.mjs`) currently fails, and not because of this slice. Another room's in-progress change to `web/app.js`, the models list in Settings, throws "Cannot set properties of null (setting 'hidden')" in `syncEffort` (via `fillModels`, around `web/app.js:1190`) when the Settings sheet opens. Every step of the check passes, and then its final "no page errors" assertion catches this. I've left that code alone since it's that room's work. The check now records the error's stack so it can be found; that's the only change to it.

 A turn queued with the older single `note` keeps its "queued for notes" marker, both when another note is tied to it and when a note is withdrawn (`tieNote` in `src/engine.mjs`). New test: "a turn queued for a note before 13 Oct still goes once its notes are withdrawn, one after the other".

Pause everything and holds on agents now work through the API. They're graceful: running turns and checks finish, and nothing new starts. They're kept in a versioned `desk.json`, separate from each room's own Pause and Stop, and in force before any room starts. A queued request that desk-wide controls hold up says why. As the plan says, **Slice 3** owns the preparation/send boundary (a hold arriving during snapshot preparation), the app-thread reservation and uncertain sends. The CLI and MCP commands come in **Slice 6**, and the page's buttons in **Slice 8**.

## What changed

| Where | Change |
|---|---|
| `src/desk.mjs` (new) | **The file:** `desk.json` is `{ version: 1, paused, holds, groups }`. `defaultDesk()` has nothing paused or held, and the default allowances from Slice 1. **Hold scopes:** `holdKey(target, { headless }, agents)` gives `codex` (the family: `codex` and `codexapp`), `codex:headless` (headless Codex only), `codexapp`, or any agent's id. `holdAgents(key)` gives the agents a hold covers, and `holdLabel` its wording. **Reading the file:** `readDesk(path, agents)` returns `{ missing }`, `{ desk }` or `{ problem }`. `parseDesk` refuses, never drops: a non-object, a missing or newer `version`, an invalid `paused`, a hold it can't make sense of (a restriction you set mustn't vanish quietly), and a bad allowance mapping (checked by `normalizeGroups(…, { strict: true })`). |
| `src/engine.mjs` | **Loading.** `#loadDesk()` runs in `init` before room recovery. A missing file writes the defaults; an unreadable or unsupported one sets `deskProblem = { kind: "unreadable" }` and is left untouched; the allowances go to the usage book. **`deskView()`** gives paused, holds (with labels and agents), groups and problem, and it's in `state().desk`. **`deskControl(action, args)`** handles pause, resume, hold, release, groups, save and reset, and saves before answering. If saving fails: a new restriction (pause, hold) stays in memory with `deskProblem = { kind: "unsaved" }`, and the reply is an error that says so; anything else (a release, resume, groups) is rolled back, with "Nothing changed". While the file is unreadable, only `reset` works: it renames the file to `desk.json.unreadable-<ms>` and starts with the defaults. **`blockersFor(req)`** gives the reasons a queued request can't start. A problem blocks everything. Pause everything blocks everything, Toryo's checks included. A hold blocks only the agents it covers; checks (`agent: "toryo"`) are never held. Following a turn the Codex app already has (`req.attach`) is never blocked. **`#pump`** checks `blockersFor` per request. A held step that isn't running beside the work (`!parallel`) also holds the steps after it, so the room's work keeps its order. Parallel steps (an answer to a question) can still go. Running turns are never touched. When desk controls start holding the room up, or the reason changes, the room gets one system line, "Waiting: <reasons>. It goes on when that ends." (`room.deskNotice` keeps it from repeating). **`#pumpAll`** pumps every room, the one with the oldest startable request first. It's re-entrant: a call made while pumping runs once more afterwards, never nested. `init` and every desk change use it. **`#enqueue`** stamps `queuedAt` (ISO time plus a sequence number, stable within a millisecond). **Status and summary.** `#status` is `held` when every queued request is held up; `summary().blocked` lists `{ agent, kind, reasons }` for the held ones. |
| `src/server.mjs` | `GET /api/desk` gives `deskView()`; `POST /api/desk { action, target, headless, groups }` calls `deskControl`. Both go through the same Host, Origin and header checks as every other route. |
| `web/app.js` | **Room list:** a held room shows ⏸ and "Waiting: <reasons>" (`ROOM_STATE.held`, `roomIndicator`). **Room header:** the pill reads "Waiting: <reasons>". |
| `README.md` | The *Planned* section says what already works (through the API), the hold scopes, graceful behavior, independence from a room's Pause, restarts, and what happens when the file is unreadable or can't be saved. |

## Invariants

- Desk controls never touch a room's `paused` or `stopped`, and a room's Pause and Resume never touch the desk's controls.
- Nothing running is interrupted; only new turns and new checks wait.
- A family hold (`codex`) and an interface hold (`codexapp`, `codex:headless`) are separate keys. Releasing one leaves the other, and the release message says what's still held.
- Controls are saved before they're acknowledged. Memory is never less restrictive than the file, and while it's more restrictive (a failed save), nothing new starts.
- An unreadable or unsupported `desk.json` is never overwritten. Only an explicit reset sets it aside.
- The controls are loaded before any room can start anything after a restart.
- Following an app turn the Codex app already has isn't held up.

## How to check

```
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
for f in bin/*.mjs src/*.mjs src/agents/*.mjs web/*.js test/*.mjs; do node --check "$f"; done
node --test --test-concurrency=1 test/*.test.mjs     # 114 tests, all pass
node test/ui-check.mjs                               # see Round 2: fails on another room's Settings change
```

`test/desk.test.mjs` (new, 10 tests):

- **Holding Codex during two active turns.** Both turns finish, and Claude reviews in both rooms. Neither room starts another Codex turn: it's `held`, `blocked` lists `codex:build-next` with the hold's reason, and the room says it once. Releasing wakes both rooms into `build-next`.
- **Pause everything.** Room A's checks are running when you pause: they finish, and A's review waits. Room D's builder finishes after the pause, and its checks wait (`toryo:gates`, "everything is paused"). A new room's first turn waits, and so does the answer to a builder's question. Resume carries all of them on.
- **Scopes.**
  - The app alone, the family, then the family released: the app is still held, and the message says so.
  - Headless Codex alone.
  - Refused: headless for anyone but Codex, releasing what isn't held, and an unknown agent.
  - Checks aren't held by an agent hold, only by Pause everything.
- **Layered controls.** A paused room stays paused through a desk pause, resume and release. Resuming the room while Claude is held leaves it `held`. Releasing Claude lets it reply.
- **Restart.** A hold and Pause everything survive a new engine, and are in force before rooms start. Resuming then runs the waiting turn.
- **Unreadable and unsupported files,** three kinds: not JSON, a version 9 file, and an invalid hold. Each sets the problem; a new room's turn waits with "Toryo can't read its desk controls"; other actions are refused; and the file is unchanged. A reset sets it aside, writes the defaults, and the turn runs.
- **Failed writes.** A hold whose save fails still applies, and nothing new starts, not even Codex. Once saved, Codex runs. A release whose save fails leaves the hold, and there's no problem, since memory still matches the file.
- **Stable ordering and all-room wake-up.** Three rooms, created in the order X, Y, Z, get their notes while paused in the order Z, X, Y. On resume, all three start, in the order Z, X, Y: oldest request first, not room order. The in-process adapters and snapshots off make starting synchronous, so the order is exact.
- **Release at the moment a turn ends.** The release happens from inside the engine's own "turn done" event, while the room is between finishing that turn and pumping. The next turn starts exactly once.
- **API.** `POST /api/desk` holds headless Codex, which is saved to the file before the answer. Releasing something that isn't held is a 400. `GET /api/state` includes the desk.

## Left for later slices

- **Slice 3:** a hold that arrives while a turn is being prepared (the snapshot) still lets that turn start. Today a turn counts as started once `#pump` has dispatched it. The cancellation check before the send, the app-thread reservation and uncertain-send recovery belong there too.
- **Slice 6:** the CLI (`toryo pause --all`, `toryo hold codex [--headless]`, `toryo release …`) and MCP tools, and threshold holds and their notices.
- **Slice 8:** the page's buttons. Until then, `held` shows in the room list and the header, with its reasons.

## Worth a look

- **The barrier in `#pump`:** a held step that isn't running beside the work also holds back later steps that aren't. In build rooms, that keeps the order of work (for example, a held builder step isn't overtaken by a later review). Parallel steps (answers to questions, chat replies) still start.
- **`deskProblem` "unsaved" holds up *everything***, as the plan asks ("dispatch blocked until durable state is trustworthy"). A failed save of a release creates no problem, because memory and the file still agree.
- **Releasing wakes every room at once.** With no caps yet, every request that can start, starts, oldest first.
