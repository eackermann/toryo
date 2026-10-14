# Home, desk-wide controls, and room worktrees

Date: 2026-10-13. Status: revised after the owner's acceptance of Claude's review and the added plan-review request; implementation has not started under this plan.

Toryo needs to manage several rooms without the owner opening each one to find out what is happening. The main feature is a usage guard that preserves allowance for the owner's other work, lets current turns finish, and releases its own holds after reset. Home makes that behavior visible and controllable from a phone as well as a desktop.

Rooms also need separate places to work. A planning room changed files while another room reviewed them, and a build changed the page files used by the running desk. After the desk controls and core Home, add a guard against conflicting work in one folder, followed by worktrees. Two build rooms, or a build room and the owner, can then work on one project without sharing editable files. Returning a room's work is a separate, explicitly reviewed operation.

Owner decisions and the earlier conflicting form answers are recorded in [decisions.md](../decisions.md#2026-10-13-home-and-desk-wide-controls). The owner has now accepted Claude's answers to all open questions and approved keeping immediate pause in Later. Those choices are settled; review implementation details remain distinguished from owner decisions.

The [worktree requirements](../decisions.md#2026-10-13-room-worktrees-and-shared-folder-protection), [scope decision](../decisions.md#2026-10-13-focus-the-home-and-worktree-plan-on-the-next-release), [accepted review decisions](../decisions.md#2026-10-13-accepted-plan-review-and-worktree-defaults), and [plan-review workflow decision](../decisions.md#2026-10-13-plan-checks-and-discussion-handoffs) record the current scope and why it was chosen.

## Outcome and scope

The core release provides:

- A Home view showing current work, elapsed time, questions, usage, blocked work, and recent activity across rooms.
- Answers from Home, with a compact planning checkpoint offering Accept all recommendations and Open the form.
- An early plan-review improvement: ask for a read-only check, automatically re-check an owner-requested revision once, and pass a ready-plan chat discussion to its author with one click.
- A timeline at the top of each room showing how long the current session spent planning, building, reviewing, and running checks, and a way to start a new session in a room (for example to plan the next sprint) without losing its history.
- Pause everything and agent holds that let current work finish. The owner has explicitly kept immediate interruption in Later.
- Manual holds across rooms and automatic holds at usage thresholds, with release at reset.
- Shared allowance tracking for headless Codex and the Codex app, as the owner believes they use the same account.
- Persistent controls and explanations of every reason work cannot start.
- The same operations through the HTTP API, CLI, and MCP tools.
- One outstanding Toryo submission per Codex app thread, independently of optional turn caps.
- A shared-folder guard after Home, followed by a Build-room choice between this folder (shared) and its own worktree.
- Worktrees seeded from the current snapshot, including uncommitted work, with project-specific copy/setup steps and checks in the room's folder.
- A full review of the room's changes and an explicit return to the main folder as uncommitted changes, with conflicts leaving the main folder untouched.
- Folder/worktree identity on Home and in rooms, disk usage, and optional worktree/branch cleanup when deleting a room.

The Later section retains recognized allowance exhaustion, the one-turn exception, projections and advance warnings, Swap, and optional concurrency caps as deferred work, not executable slices. The threshold guard needs usage observations and known reset times, not provider-exhaustion classification or automatic failed-turn recovery, so exhaustion handling is deferred too. It must not become a hidden prerequisite for the guard. No automatic takeover is allowed. A new takeover offer is deferred until after this plan and until another suitable reviewer has been tested. This preserves the later answer excluding takeover from this plan while retaining the earlier interest in an explicit future action.

No new remote-access infrastructure, account-login scraping, usage probe turns, dependencies, multi-machine scheduling, monetary budgets, containers, automatic deployment, automatic commits, or changes to the app's own permissions are included. Worktrees isolate files, not network ports, databases, external editors, or agent allowances. The existing one-builder-per-tree rule becomes an enforced rule for work Toryo knows about; an agent cap is not a substitute.

## Accepted owner choices

On 13 October, the owner accepted Claude's review recommendations and answered yes to keeping immediate pause in Later. There are no outstanding owner questions from that review.

| Choice | Behavior to build |
|---|---|
| Initial usage guard | On for new and existing desks at 90% of both the 5-hour and weekly windows, with automatic reset release, one notice, and a way to turn it off. Preserve any explicit settings already saved. |
| New headless Build rooms | Default to their own worktree; retain the shared-folder choice. Existing rooms stay where they are. |
| Second builder in one folder | Refuse it, name the occupying room, and offer to wait or use a worktree. |
| Codex app | Shared/main-folder rooms only for this release. |
| Worktree storage | `~/.toryo/worktrees` by default, following `TORYO_HOME/worktrees` when a different home is explicitly configured. No additional per-project location setting in this release. |
| Checks and setup | One at a time per project unless project settings explicitly allow parallel runs. Give each room its ID, folder, and a stable port offset. |
| Planning documents | Write into main at a gap when no turn, check, or review is running there; do not wait for the whole build to end. Notify the build room with the changed-file list. |
| Immediate pause | Later; current room Stop remains available for emergencies. |

Managed dev servers, general resource declarations, and test-database naming are deferred. The room-level automatic re-check setting requested below defaults on, including for existing rooms without an explicit setting.

## Baseline and integration

The repository is uncommitted and another Toryo review room is changing it. Re-read the affected functions before each slice; integrate with those changes rather than restoring code from either proposal.

At the planning inspection, the current tree already has:

- Room pause, queued project checks, and flow identifiers that invalidate work from a stopped or replaced run in `src/engine.mjs`.
- Delivery bookkeeping through adapter `onStarted`, rather than marking catch-up messages read before snapshot preparation.
- Multiple waiting questions and optional `questionId` matching, although chat questions and all clients still need consistent treatment.
- Initial plan synthesis already queues read-only checks; `#afterPlan` in `src/engine.mjs` sends a `plan-revise` result straight to Ready. Reuse those states for the bounded re-check cycle instead of building another planning engine.
- The briefing in `src/protocol.mjs` currently says `Repository: ${project.path}`. A different process cwd alone does not correct that instruction. Claude currently adds edit-deny rules only for read-only turns; a worktree writer also needs explicit main-folder protection.
- `swapPending` and queued-role retargeting. Preserve current behavior; further safe-boundary Swap work and its regression coverage are retained under Later.
- App cancellation and observation handled separately through `cancellable`, `signal`, and `abandon`.
- Account readings in `limits.json`, room transcripts, SSE, and temporary-home tests with fake agents.
- Per-room Codex app thread selection. A thread has its own working directory; passing a different adapter `cwd` does not move that thread.
- Page assets loaded at server startup in `src/page.mjs` and `src/server.mjs`. Preserve this independent protection against the live desk loading a half-edited page.
- Shadow snapshots in `src/snapshots.mjs`, currently cached and locked by project ID, with a silent 20 MB changed-file cutoff and a truncated text-diff view. Those paths need explicit workspace identity and complete capture before they can safely seed or return a worktree.

These are observed implementation details, not a claim that the ongoing review changes have passed their checks. Relevant modules are `src/engine.mjs`, `src/store.mjs`, `src/agents/{codex,claude,codexapp,logtail,proc}.mjs`, `src/server.mjs`, `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`, and `web/{app.js,index.html,styles.css}`. Add small `src/usage.mjs` and desk-policy helpers if that keeps scheduling and calculation logic testable; do not build a second relay engine.

Worktrees also affect `src/snapshots.mjs`, `src/gates.mjs`, `src/protocol.mjs`, `src/agents/claude.mjs`, file/plan readers, agent session reuse, read-only mounts, and room creation/deletion. Introduce an explicit room workspace and small workspace helpers; do not mutate the shared project object's path to redirect one room.

## Behavior contract

### Controls compose without undoing one another

Keep these separate: desk pause; manual holds; threshold holds per allowance window; room pause or stop; room workflow waits; folder reservations and per-project setup/check serialization once those slices land; and outstanding app-thread reservations. An eligible queued request can start only when every applicable restriction permits it. Return a list of reasons, plus running turns and questions, rather than replacing all of them with one room status.

| Action | Current work | Pending work |
|---|---|---|
| Pause everything | Current agent turns and checks finish | No new agent turns or checks, including in newly created rooms |
| Hold an agent | Current turns finish in every room | Block its new turns; eligible other agents and checks continue |
| Threshold reached | Current turns finish | Hold the affected allowance group until release |
| Resume desk | Remove only desk pause | Room pauses, manual holds, and usage restrictions remain |
| Release agent | Remove the specified manual hold | Report remaining restrictions and offer an explicit guard pause until reset where applicable |
| Pause room | Current work finishes | Other rooms are unaffected |
| Stop room | Keep existing stop behavior and app limitation | Cancel that room's pending flow; later releases cannot restore it |

An answer or note to a held agent is saved. Say who will receive it and why it is waiting. No ordinary answer, retry, start-room operation, or Now note bypasses a desk or usage restriction. If a Now note interrupts a cancellable current turn, its continuation is queued subject to the same restrictions; the UI should explain that before offering interruption. App notes cannot interrupt the app.

Follow the owner's most specific scope answer: Hold Codex and `toryo hold codex` cover both `codex` and `codexapp`, across all rooms, and the result names both. Hold Codex app sending / `toryo hold codexapp` affects only the app; `toryo hold codex --headless` affects only headless Codex. Release uses the same scopes. Every hold is already desk-wide, so there is no `--everywhere` flag. A family hold and an interface hold can coexist; releasing one does not remove the other. These explicit names reconcile the answer about holding only the named interface without making the plain Codex command unexpectedly narrower than Hold Codex everywhere.

### Usage guard and reset

The owner confirmed that guards start enabled on both new and existing desks at 90% for the 5-hour and weekly windows, with automatic release selected. Persist a one-time activation notice with an explicit disable action; expose it through CLI/MCP before Home exists and on Home afterward. Preserve previously saved explicit on/off, threshold, and release settings. Each window remains independently configurable. The earlier weekly-only answer stays in the decision history, superseded by this explicit acceptance.

Normalize observations to an allowance group, source adapter, stable window type, duration when known, used percentage, reset timestamp, source timestamp, and received timestamp. Keep missing or invalid fields unknown rather than making them zero. Model-specific windows must retain their identity and apply only where relevant; do not flatten them into the general weekly window.

Default the Codex group to both interfaces, with a configurable mapping if their accounts later differ. Never add their percentages. Resolve observations by source time within each window; keep attribution and display disagreement or uncertain freshness. Project-level adapter settings must resolve to the intended group as well. Re-reading the same source record is not a fresh measurement.

On each accepted observation, evaluate thresholds before another dispatch. A value at or above the threshold creates a durable cause associated with that group's window type and reset timestamp. Several causes can coexist. Notify once per cause transition, not once per blocked room or polling pass.

An automatically released cause expires when its recorded reset passes, without waiting for another report. Retain the old percentage as expired, never as a synthetic zero. Reject late observations of expired windows. A new reading applies immediately, but a later reset date alone is not grounds for a new hold. If the owner disables automatic release, reaching reset marks the cause ready for an explicit Release usage hold action and does not silently resume work. This guard action removes only the selected expired cause and is distinct from Release agent; expose it in every interface.

Check deadlines at startup, before dispatch, and on a periodic timer at least once a minute. Use an injected clock in tests. A laptop waking after reset must make the same decision as an uninterrupted process. Re-read passive Codex sources periodically, initially every five minutes, and consume streamed observations where supported. Do not run detection commands or agent turns merely to refresh usage. Show observation age, unsupported reporting, and source failures.

A missing reset time cannot produce a guessed release. A stale reading may still justify an existing hold within its window; an old below-threshold reading cannot promise spare capacity. Current turns, delayed reports, external activity, and the app's accepted messages can take usage past the configured threshold. The guard controls future Toryo dispatch, not the provider's exact spending.

### Release and pause a guard until reset

Release removes manual holds only. If a threshold guard still holds the agent, its result must state the remaining window and reset and offer Pause this guard until reset. Home shows that action as a button; CLI and MCP replies include a ready-to-run command such as `toryo guard codex --window weekly --pause-until-reset`, and MCP also identifies the equivalent tool arguments. Show separate actions if several windows still hold the agent. This is an offer, not an automatic bypass; no trip to Settings is required.

Pause this guard until reset explicitly suppresses the selected threshold window until its recorded reset; it does not change unrelated restrictions. Store this exception and its scope so restart does not unexpectedly re-enable the guard. Show that the guard is paused. If reset is unknown, explain why this timed action is unavailable; the owner can explicitly disable the threshold rule rather than receive an invented expiry. Threshold edits and disabling a rule reevaluate only that rule's causes, never unrelated holds.

### Dispatch and persistence

Retain room queues, adding stable enqueue order and a common eligibility calculation. A guarded desk scheduler wakes eligible rooms on enqueue, completion, error, release, reset, and relevant settings changes. Reserve capacity synchronously before awaiting preparation; use a reentrancy guard so nested completion and enqueue events cannot start a request twice. Within workflow dependencies, choose oldest eligible work with a stable tie-breaker, so one busy room cannot starve another.

Distinguish preparing a turn from actually submitting it. A hold arriving during snapshot preparation returns unsent work to the queue without losing its catch-up, briefing, or owner note. Preserve an intelligible deferred-attempt record; do not delete transcript history. Current delivery bookkeeping through `onStarted` supports keeping those messages undelivered until the adapter really starts. Check eligibility after asynchronous preparation and check cancellation immediately before an adapter spawns or sends. An already submitted turn is allowed to finish under graceful holds. This boundary is an implementation choice resolving the planners' disagreement, and must be tested.

Use a versioned `desk.json` under the configured `TORYO_HOME` for policy and durable controls together: allowance-group mapping, guard settings, desk pause, manual holds, active threshold-window causes, and timed guard exceptions. Do not add dormant cap or one-turn-exception state for deferred features. Keeping these in one atomic record avoids split policy/hold updates. Existing project and adapter configuration stays in `config.json`; latest observations remain in `limits.json`; a desk event journal supports Recent and explains changes. A usage-history store belongs to the later forecasting work, not the threshold guard. Reconstruct running counts rather than persisting counters as truth.

Load controls before recovery can dispatch. A missing desk file initializes the accepted enabled 90%/90% policy once. Migrate existing explicit settings without resetting them, and retain the one-time notice state through restart. An unreadable, invalid, or unsupported existing file blocks new dispatch and exposes an actionable error. Do not overwrite it with an empty policy. A failed control write must not return success or release work; retain the restriction and report the failure. Recognized usage restrictions must remain effective in memory if persistence fails, with dispatch blocked until durable state is trustworthy.

Keep current headless recovery behavior: interrupted work is offered again with the room paused. Resetting usage does not clear that pause. Existing app work is reattached for observation even if dispatch is held. Durable work identifiers and the current flow token prevent Stop, room deletion, or mode replacement from being undone by a late result or requeue. Stop cancels pending checks; cancellation must not consume their gate-retry allowance. The later immediate-pause design separately preserves interrupted checks for resumption.

### Codex app boundary

One outstanding submission per actual app thread is mandatory. The owner selected a cap of one; bringing thread serialization forward into Slice 3, before optional caps, is a durable crew agreement about correctness, not an earlier delivery order attributed to the owner. Reserve it before sending and keep it reserved while waiting for the app, running, observing after restart, or awaiting a definitive outcome. Reattachment is not another submission and must not double-count the slot. Inspect all rooms during recovery before admitting new submissions.

A hold cannot retract an accepted message or stop the app. Keep following the marker and record its result while blocking follow-up work. Suppress automatic thread opening while held or paused. Check cancellation before the first queue submission; an abort check only inside the polling loop is too late.

Show Preparing, Waiting in the Codex app, and Working in the Codex app separately. Record app acceptance and pickup times where available; do not use restart time as a new work start. A timeout or explicit abandonment does not prove the app stopped. Keep that thread unavailable to new automatic submissions until passive reconciliation establishes completion or the owner explicitly resolves the uncertain submission. Do not silently resend to learn whether the first send succeeded.

**A turn the app ends with an error (14 Oct, the owner's decision; [the record](../decisions.md#2026-10-14-following-a-codex-app-turn-that-ended-with-an-error-and-a-fuller-session-timeline)).** The app can end a turn with a `task_complete` whose `last_agent_message` is null and whose `error` names the cause (*Selected model is at capacity*, `codex_error_info: server_overloaded`), then pick the same work up later as a new turn in the same thread with no new user message (`task_started`, developer messages, the work, and a `task_complete` with the reply). Report such an ending as the app's error, never as an empty message. Following the turn (and *Follow it again*) goes past a failed ending: a turn the app starts in the same thread with no new user message after the failed one is the same work resumed, and its reply is the turn's result. A new user message without Toryo's marker first means the thread has moved on to someone else's message: say so, and don't take that reply. With nothing after the error yet, keep following (the app may be resumed later) and say so in the activity. The question when Toryo loses track names the app's error and says that resuming the turn in the app, then *Follow it again*, picks the resumed turn up. A capacity error isn't a usage limit: this stays apart from *Recognized provider exhaustion* under Later.

## Plan checks, revisions, and chat feedback

Reuse the existing planning round and its `plan-check` / `plan-revise` turns. When a plan is Ready, offer **Ask Claude to check the plan** (or the other non-author planners), alongside **Start building**, **Read**, and **Ask for changes**. Checks are read-only. Deliver every result to the author's catch-up and automatically queue the author when findings request changes; after the author addresses them, return the plan to Ready. With no findings requiring changes, return directly to Ready. If there is no other planner, explain that instead of assigning the author to review their own plan.

Add a persisted room setting **Re-check after changes**, on by default and preserving an explicitly saved off value. An owner change request follows one bounded cycle: author revises → other planners check that revision once → author addresses their findings if needed → Ready. A new owner change request starts a new cycle. The author's follow-up addressing that cycle's review does not recursively trigger another automatic check. An explicit Ask for a check works even when the automatic setting is off. This also applies to a discussion forwarded as a change request. Keep a visible distinction between a checked revision and a later author response to that check; Ready must not falsely claim the last edit was independently approved.

Bind each action to the ready question ID and plan revision/path, using a file fingerprint to reject an out-of-date check or action. Persist the cycle ID, its origin, expected reviewers, and delivered findings so duplicate clicks, restart, or late results cannot produce duplicate author turns or revive a stopped/replaced plan. Ordinary holds and pauses apply. A checker asking an owner question remains read-only and receives the answer to finish its check; a failed check is not treated as approval. Build starts only from a current Ready plan. This is a small extension of the current planning state machine, not a new review service.

When the owner discusses a Ready plan with a non-author, offer **Send this discussion to [author]** on that exchange. One click creates an ordinary change request with the selected owner/planner messages and their source IDs, addressed to the current author. Include the discussion even if the author previously saw those messages; preserve the owner's decisions and the planner's suggestions as distinct voices. Do not forward a chat automatically or treat a planner's advice as an owner decision. Reject stale-plan or duplicate forwarding. Reuse the same operation through the page, CLI, and MCP, and later through Home's plan card.

Fix recommendation extraction and acceptance in the shared parser/formatter used by room and chat questions. The reported `(Recommended: yes to both)?` must produce `Go with your recommendation: yes to both.` with no stray `)?`. Recognize the recommendation's wrapper rather than trimming arbitrary punctuation from the answer: preserve legitimate nested parentheses, quoted text, and answer punctuation. Cover `recommendationIn` / `parseQuestions` and the page's chat-accept path so the UI cannot bypass the correction by assembling a different answer itself.

## Room folders and worktrees

### Guard shared folders after Home and before worktrees

Implement this in two reviews. The cheap guard in Slice 12 records one builder per canonical folder, including a Codex app builder, refuses a second one, names the occupying room, and shows the result on Home and in `toryo status`. Keep the build reservation through its build/check/review cycle, pause, hold, and restart. Stop releases it only after writers actually drain; an outstanding or uncertain app submission still counts. The first slice does not also implement arbitrary reader/writer coordination.

Canonical identity is the real repository worktree root, retaining the project subdirectory separately. Project aliases, symlinks, and overlapping subdirectories must not evade the guard. Distinct linked worktrees are distinct editable folders even though their Git common directory matches.

Slice 13 adds short reservations for plan-author writes, writable chat, and active read-only reviews. Distinguish the long-lived builder claim from momentary access to the files: a planning author may borrow a quiet gap while the same build keeps its builder claim. Atomically reserve that gap only when no turn (including preparation or outstanding app work), check, setup, or review is using the folder. While the author writes, queue new work in that folder; let the build continue afterward. Give an eligible waiting author the next gap before starting more queued build work, rather than waiting for a multi-day build to finish. Desk/agent holds still apply; do not reserve a gap for an author that cannot run.

After the write, record the actual changed paths and send the occupying build room a visible note listing them, delivered to its agents before their next turn. Preserve the note across restart and avoid duplicates. Read-only reviews retain their reservation for their whole turn. Writable chat uses the same short reservation, never concurrent access to a builder's files. An observed intervening change invalidates a review of those changed files and marks it out of date before it can authorize return; the note does not silently approve a new plan or start a new build.

Add the explicit “I'm using this folder” reservation for independent owner/app/editor work in Slice 13, with status/release through Home, CLI, and MCP. Toryo cannot detect every external process or keystroke, so do not claim that a guard freezes the filesystem. Restore/reconcile known reservations before recovered dispatch; an abandoned app observer does not prove the app stopped writing.

### Create from the current tree without committing it

At Build creation, show **This folder (shared)** and **Its own worktree**, with the exact resolved path before starting. Existing rooms remain shared; never relocate a running room or reuse a session from another folder silently. Default new headless crews to their own worktree, as accepted by the owner. Starting Build from a planning room makes the workspace choice at that boundary and starts fresh headless sessions if the folder changes; retain the transcript and accepted plan as the handoff.

Use native Git linked worktrees at `TORYO_HOME/worktrees/<project-id>/<room-id>` (`~/.toryo/worktrees` with the default home). This is the owner's accepted location; keep them outside the source tree to avoid file watchers, recursive snapshots, and accidental adds. A configurable home still lets tests use temporary storage. Do not add a per-project sibling-directory option in this release. Linked worktrees share repository objects and branch refs but have their own working files, HEAD, and index. Registration, a new room branch, and staging the room baseline intentionally write Git metadata/objects; main files, its index, HEAD, and existing branch tips stay unchanged. [Git worktree documentation](https://git-scm.com/docs/git-worktree)

Capture and pin a complete Toryo snapshot **B** of the source before creating the room workspace. Start the private branch from the source HEAD when one exists, create without checkout, then populate its working files from **B**, including the owner's staged and unstaged file contents, deletions, modes, symlinks, and non-ignored untracked files. Inherited uncommitted work stays uncommitted; preserve the main folder's staging exactly. An unborn repository uses an orphan worktree without requiring an initial project commit. Internal snapshot objects remain in Toryo's shadow storage; do not turn B into a commit on a project branch or stash the owner's work. The authoritative starting content is B, not HEAD and not the room branch's later history. After materializing B, stage those starting files in the worktree's own index, including inherited uncommitted files and deletions. This creates no project commit and never stages files in main. Plain `git diff` therefore starts empty and shows subsequent unstaged room edits; `git status` still identifies newly created untracked files. Explain in the briefing that `git diff --cached` or `git diff HEAD` includes inherited baseline changes and that the pinned B-to-current snapshot comparison is the authoritative full room contribution, even if an agent later changes staging. Stage the baseline before copying private ignored files or running setup.

The current snapshot cutoff cannot silently omit a large changed file. Capture it or stop with the exact unsupported paths; never fall back to HEAD or an incomplete snapshot. Detect changes during capture and retry or ask for a quiet moment rather than publish a known mixed baseline. Keep the room's baseline reference for its lifetime. Making all old snapshots independent of project Git cleanup is a separate bug fix to do soon, outside this plan; its reasoning and regression check are recorded under Later. Integrate that fix when available rather than implement it inside a worktree slice. Treat submodules, nested repositories, sparse checkouts, and content filters as explicit compatibility cases: verify faithful round-tripping or refuse worktree creation with an explanation. A non-Git project can still use shared mode; do not initialize or commit it automatically.

Persist room workspace ID, canonical source root, project-relative subdirectory, actual worktree root/cwd, branch, pinned base, and provisioning state. Snapshot caches, locks, refs, and indexes must be keyed by workspace, not just project ID. Resolve every agent cwd, setup/check cwd, snapshot, diff, file viewer, plan reader, prompt path, and read-only mount against that room's workspace. Restrict writable agent roots to the room's folder where the adapter supports that; do not grant the main folder just to make a worktree run. Commands with absolute paths can still escape ordinary cwd isolation, so do not describe a Git worktree as a security sandbox. No main-folder fallback on a missing worktree. Persist partial creation so a restart either completes safe provisioning or exposes recovery; never start an agent in a half-created folder.

Update `preamble` in `src/protocol.mjs` to take an explicit room workspace: the `Repository:` line and all work instructions name the room cwd, while the main folder is labelled off-limits for edits. Do not mutate the shared project configuration. Keep Codex's writable sandbox rooted in the room. For Claude write turns, add explicit Edit/Write/NotebookEdit deny rules for the canonical main folder as well as the off-limits briefing; a prompt warning alone is not the protection. Use the existing read-only filesystem wrapper for main where supported to cover shell writes, with honest reporting of its platform fallback. Preserve access needed to the room's private Git index without granting writes to main's files/index. Test the writer path, not only read-only reviewer permissions.

### Copy files, setup, and simple project check ordering

Project settings specify relative copy patterns, for example `.env*`, and an optional setup command. Preview matched paths and destination; copy only the owner's configured files, not every ignored file or a writable shared dependency directory. Reject escaping paths, traversal through links, and collisions with captured source files. Preserve appropriate private permissions. Keep copied ignored files and their contents out of snapshots, returned patches, notifications, and logs even if the room changes its ignore rules; show filenames/status only. A later attempt to add one to the return diff requires an explicit project-policy change and a fresh review.

Run setup in the new room's folder before its first agent turn, using the checks' output/status presentation. Record the resolved command/configuration, result, and attempt. Failure blocks the room with Retry and Open output; it does not consume an agent turn or become a successful setup after restart. Do not automatically rerun an interrupted command that may have external effects; show the interrupted attempt and require Retry. Desk pause prevents new setup/check steps, agent holds do not, and Stop manages their process groups. Setup changes to ordinary source files remain visible in the room's delta from B.

For this release, serialize setup and checks across all rooms of a project unless project settings explicitly allow parallel runs. Identify the project across its worktrees rather than giving each cwd an independent slot. Queued steps show which room is using the slot; pause, Stop, completion, and restart must preserve or reconcile that ordering.

Provide `TORYO_ROOM_ID`, `TORYO_WORKSPACE_PATH`, and a stable `TORYO_PORT_OFFSET` to room agent, setup, and check processes. Persist the offset so restart does not unexpectedly change it; project commands can choose to use it. An offset is a hint, not a reserved or guaranteed-free port. Do not rewrite `.env` files, allocate/manage dev servers, declare arbitrary shared resources, or provision/name test databases here. Worktrees still do not isolate external services or databases. Those larger features and their rationale live under Later.

### The app and shared plans

For this release, the owner selected the Codex app only in shared/main-folder rooms. A selected app thread is tied to its own cwd; Toryo's current queue adapter does not move it by changing the room cwd. Validate the selected thread's folder against the room before any send. Worktree crews use headless builders and reviewers; an app reviewer in the main folder would also read the wrong files. The existing per-room app-thread choice remains intact. A future explicitly created app thread in a worktree might be supported, but this plan does not claim current support or try to retarget a live thread. Tests use synthetic thread metadata only.

Standalone planning rooms publish plans into the main folder as shared project documents. Proposal/check turns remain read-only. The owner explicitly chose waiting for a quiet gap, not waiting for the shared build to finish: when no turn, check, or review is running there, reserve a short write window, publish, and notify the build room with the changed-file list before its next turn. An active shared build keeps its builder claim throughout. New worktree builds capture the accepted plan with B. Later main-folder plan edits do not leak into an active worktree build: importing a newer plan is an explicit, reviewed update at a turn boundary. Build-created docs remain in the room's worktree and return with its other changes.

### Review the changes and return them explicitly

When the room finishes, freeze a final snapshot **R** and show the full **B → R** diff. This excludes the owner's changes already present when the worktree started, regardless of any room commits. Include added/deleted files, binary changes, symlinks, and executable bits. Page large text diffs and offer a complete download rather than silently truncating them; represent binary changes with sizes/hashes and old/new downloads. Copied private files and setup caches are excluded. Show both the room's contribution and what applying it would change in the main folder.

Capture current main as **M** and calculate a three-way result from B, M, and R in shadow storage or a disposable scratch area. Use an explicit base, not an inferred common ancestor in snapshot history. `git merge-tree --write-tree --merge-base=<base>` can calculate this without touching a working tree or index; inspect its conflict result as well as its output tree. [Git merge-tree documentation](https://git-scm.com/docs/git-merge-tree)

If main changed in unrelated places, preserve those changes in the proposed result and show the refreshed preview. If changes conflict, list the paths and base/main/room versions; put no conflict markers or partial changes into main. Keep the room available for an explicit resolution in an isolated copy, then regenerate the preview. No automatic apply, cherry-pick, rebase, merge commit, or resolution in the main folder. Apply is offered only at a completed-turn boundary with all room writers/checks stopped and final review still valid.

The owner's **Apply to main folder** click names the exact preview. Its token binds B, R, M, the main HEAD/index fingerprint, and the included paths. Acquire the destination writer reservation and recheck those identities, filesystem paths, ignored/untracked collisions, and write permissions before any mutation. If either folder changed, discard the stale approval and show a new preview. Never force an old patch over newer owner edits.

Apply the verified **M → proposed result** delta to working files only. Leave the main index, HEAD, and existing branch tips unchanged; new files are untracked and edited tracked files are uncommitted. A worktree-only binary patch can use `git apply --check` then normal `git apply`; do not use `--index`, `--cached`, `--3way`, or `--reject` on main. In particular, `--3way` implies index handling and may leave conflict markers. [Git apply documentation](https://git-scm.com/docs/git-apply)

Conflict detection must finish before writes. Filesystem failures are a separate risk: a multi-file update is not an atomic filesystem transaction. Keep a durable apply journal and affected-file backups, prepare replacements before writing, and restore only files still matching Toryo's attempted writes after a failure. Never roll back over a newer external edit. Expose interrupted recovery, block another apply, and show exactly what changed rather than report success or retry on restart. The short apply operation reserves main against other Toryo writers; tell the owner to leave it idle during that operation because external editors do not honor Toryo's reservation. Reject paths into `.git` or outside the destination, including link traversal.

Record the successful delivery and its snapshots before accepting another apply, so duplicate clicks/retries cannot deliver twice. A resumed room records the delivered R as its next contribution baseline and takes a fresh destination preview before returning further changes. Returning work never restarts a dev server or deploys Toryo; preserve the existing page-at-startup behavior and let the owner choose when to restart separately.

This release adds no commit offer. The optional offer to commit an approved slice is retained under Later and must respect project rules. Never require commit-all as setup or delivery. A project's no-commit rule must work throughout creation, checks, return, and cleanup. Shadow snapshots are existing internal bookkeeping, not permission to create project commits. Branch commits, when allowed, do not change the B → R definition or imply a push/merge into main.

### Visibility, disk use, and cleanup

Home, the room header, status, CLI, and MCP show Shared folder or Own worktree, the actual cwd, branch where relevant, main destination, and other rooms using that editable folder. Distinguish setup, folder or project-check waits, ready to apply, conflicts, and cleanup failure from agent holds. Copy/open-path controls work on narrow screens. Worktree labels must be available from the first worktree slice, not delayed until cleanup ships.

Measure worktree disk use asynchronously, with last-measured time and a partial/unavailable state. Count dependencies and copied files; do not follow links outside the worktree or charge the common Git object store to every room. Show shared repository storage separately if measured. Avoid a recursive scan on every Home update.

Deleting a room offers Keep worktree or Remove worktree and its room branch, showing paths, measured size, unapplied changes, and any branch commits. Keeping is the safe default; deleting unapplied work requires an explicit discard choice. First drain Toryo-managed agents and setup/check processes, and refuse removal while an app submission might still use the folder. Verify the registered worktree and branch belong to this room, are outside main, and are not being used elsewhere. Never delete an arbitrary supplied path or reset another branch to make cleanup succeed. Keep recovery metadata on failure and allow a later retry; room deletion must not silently orphan a failed removal. Retain the transcript and apply receipt according to the ordinary history policy.

Expose workspace choice, project copy/setup/parallel-check settings, preview, apply, disk status, and cleanup through the same authenticated API operations used by CLI/MCP. A phone apply supplies the preview ID and destination just as the page does; a generic resume/accept answer is never authorization to return files. Commands and tools should show the full target path and remaining blockers.

## Home and remote controls

Home lives at `#/` and is the default page. Existing `#/r/<id>` links still open rooms. Clicking Toryo returns Home; the phone has a Home tab. The order on narrow screens is:

1. Desk bar: Pause everything and counts of work still finishing. Resume says what it will release.
2. Needs you: oldest open questions, room and agent, waiting time, recommendation, answer field, and context link. A planning checkpoint shows Accept all recommendations, the default author's name, and Open the form. The full form stays in the room. If recommendations are missing or the author is invalid, direct the owner to the form rather than invent choices.
3. Working now: agent, role, project, room, folder/worktree, task or slice and review round, elapsed time, latest activity, and age of last output. A quiet turn is not automatically called stalled.
4. Agents and usage: both reported windows, exact local reset dates and countdowns, observation age, configured thresholds, every hold cause, expected release, and clearly scoped controls. Codex interfaces have separate activity rows under the shared allowance; the same quota is never counted twice.
5. Other rooms: held, paused, stopped, idle, and done, with reasons and links. Show which rooms share an editable folder; later worktree slices add setup/apply state and measured disk use. A room can be working and waiting on an owner question at the same time.
6. Recent: initially 40 notable events across rooms, including completed turns, reviews, questions, answers, check failures, holds, exceptions, and releases. Link to the room and event; omit raw command spam.

Generate a bounded overview on the server, using existing SSE for updates and a fresh overview after reconnect. Do not fetch every transcript from the browser. Recent can be served by `GET /api/feed`, merged from room events and the desk journal. Sort completions by their completion time, deduplicate event patches, and use stable cursors/IDs. Cache or incrementally update summaries so every activity line does not rescan all history.

Patch Home without replacing focused inputs. Preserve drafts by room and question ID, scroll position, and keyboard focus. Support a 390px phone, narrow 320px layouts, keyboard access, readable status labels, and touch controls without horizontal scrolling or hover-only information. Show disconnection; do not imply a control succeeded while offline.

All answer actions name the room and expected question. Apply this to open chat questions, queued workflow questions, retry actions, and planning synthesis. Reject superseded or already-answered questions without answering a different one or starting another synthesis. Accept all materializes the displayed recommendations and chosen author for that checkpoint; it is not an empty generic acceptance. Keep drafts when a request fails. Legacy CLI convenience may resolve a sole question before posting its ID; ambiguous questions must be listed rather than selected by accident.

Extend `toryo_status` and `toryo status` to show the same overview in text, including reasons, usage age, resets, and actionable IDs. Preserve existing room command meanings. Proposed command vocabulary, to implement consistently rather than add as separate pathways:

```text
toryo pause --all
toryo resume --all
toryo hold codex
toryo release codex
toryo hold codexapp
toryo release codexapp
toryo hold codex --headless
toryo release codex --headless
toryo guard
toryo guard codex --five-hour 90 --weekly 90 --auto-release
toryo guard codex --window weekly --pause-until-reset
toryo guard codex --window weekly --release-expired-hold
toryo answer --room <id> --question <id> --accept
```

`hold codex` and `release codex` apply to both Codex interfaces and name both in their result. `codexapp` names app sending only; `codex --headless` names headless Codex only. Guard commands target the configured allowance group. Cap commands and one-turn exceptions belong to Later and are not added here.

Use structured HTTP and MCP arguments for scope, agent/group, action, window, and timing. Extend the existing tools or add small `toryo_hold` and `toryo_guard` tools. All call shared engine operations. Desk and agent scopes must be explicit rather than encoded as a magic room name. The result states what changed and what still blocks work. Release replies must include the explicit guard-override offer, ready-to-run command, and corresponding MCP arguments when applicable, matching Home's button. Existing Host, Origin, token, and body validation apply to new routes too.

Phone access uses MCP/Remote Control away from home and the existing authenticated `--lan` option for the page on the local network. No tunnels or changes to default loopback binding. Warn plainly in documentation that Toryo's guard cannot reserve allowance used by an independent phone-control session.

## Session timeline and new sessions

On 13 October the owner asked for a timeline in the sticky bar at the top of the room, showing how long each phase of the current session took (build, review, test, plan), and for a way to reset a room or restart its session, for example to plan the next sprint. A room is usually one session. Where these go in the plan and how they look are proposals in this plan, not owner decisions ([the request](../decisions.md#2026-10-13-a-timeline-of-each-sessions-phases-and-new-sessions-in-a-room)).

**Where it shows.** A slim strip in the room's sticky header, under the room's name, so it stays in view while the timeline scrolls. The desk-wide top bar belongs to every room, while a session belongs to one; if the owner prefers the strip there, it is the same component showing the open room's session.

**What it shows.** One time axis from the session's start to now, with a lane per phase: planning (purple), building (blue), reviewing (mint), and the project's checks (grey), in the activity colors the design system already uses. A turn's phase follows the rings' mapping (`workKind` in `web/rings.js`), so a plan check counts as reviewing, as it does on the rings. Other work (chat replies, discussions, second opinions) gets a neutral lane only when the session has some. Behind the lanes, time waiting for the owner is shaded orange and paused or held time is hatched. Beside the strip, each phase's total in words (*Building 3 h 10 · Reviewing 1 h 05 · Checks 22 min · Planning 40 min*) and the session's length. A phase's total is the time during which at least one of its turns or checks ran, so parallel turns count once. Phases can overlap, so the totals may add up to more than the session; the strip says so where it happens.

- **Long gaps.** Sessions can run for days. A stretch of more than 30 minutes with nothing running is drawn as a short break marked with its length (*9 h, waiting for you*, or *9 h, idle*), so the work stays readable.
- **Details.** Hovering or tapping a segment says what it was: agent, kind, slice and round, start, and duration. Clicking it goes to that turn or checks row in the room. The strip is also one button that opens a list of the session's phases and segments, for the keyboard and screen readers; nothing is only in color or only on hover.
- **Live.** It updates as turns start and end, and the running segment grows once a minute on the page's shared clock. Nothing on it animates, with or without reduced motion.
- **Phones.** One proportional bar of the phase totals with the totals in words; tapping it opens the full list. Nothing scrolls sideways at 320 and 390 pixels.

**Earlier sessions, a time ruler, zoom and pan (14 Oct, the owner's decisions; [the record](../decisions.md#2026-10-14-following-a-codex-app-turn-that-ended-with-an-error-and-a-fuller-session-timeline)).**
- **Earlier sessions on the strip.** Opening (selecting) an earlier session's fold in the transcript shows that session's timeline on the strip. Folding it again, or *Back to session N* (the current one), returns the strip to the current session. The list behind the totals keeps offering every session.
- **Full width.** The strip takes the whole width of the middle column; the totals in words go on their own line under it.
- **A time ruler.** Its x-axis is a real ruler: ticks with clock times, and dates where the session crosses days, getting finer as you zoom in. A compressed break shows on the ruler as a break marked with its length, so the ruler never suggests time is to scale where it isn't.
- **Zoom and pan.** The scroll wheel over the strip zooms around the pointer; dragging pans; a double-click or *Fit* goes back to the whole session. Clicking a segment still goes to its turn, and a drag never counts as a click. The keyboard can zoom, pan and fit too, and the list stays for screen readers. The strip stays compact in the sticky header. Phones keep their single bar.

**Where the times come from.** One shared function in `web/` (as `web/intent.js` is shared), used by the page, the summary, the command line, and MCP, so they agree. Turns have their start and end. Checks today record only their end and each check's seconds: record when the run starts. Pauses, holds, and resumes are today only sentences in the timeline: record them as structured events. Waiting for the owner runs from a question's arrival to its answer, and overlapping questions count once. For rooms from before this, derive what can be derived (a checks run's start from its end and seconds; pauses from the existing sentences) and leave the rest blank rather than guess. The room's summary carries the current session's totals, computed incrementally rather than rescanning the whole history on every event, for Home and for `toryo show` and `toryo_room` (*This session, 5 h 20: building 3 h 10, reviewing 1 h 05, checks 22 min, planning 40 min, waiting for you 1 h 30*).

**Starting a new session.** *Start a new session* in the room's menu, with the same action through the API, `toryo session new [room]`, and MCP. It is the "reset" the owner asked for: it starts the room afresh for new work without deleting anything. Deleting a room remains the way to remove one.

- **When.** Only when nothing in the room is running or queued; otherwise it says what is running and offers to wait or to stop it first. It asks to confirm, listing what ends: the current planning round or build, and any open questions, which close as answered by the new session.
- **What it does.** It writes a marker in the transcript (*Session 2 started*), and starts a new flow, so a late result from before changes nothing. The timeline starts again from zero. By default each agent starts fresh on its next turn, with the briefing, through the existing *Start fresh* mechanism. A checkbox keeps the agents' memory instead. The Codex app keeps its thread, and the sheet says so. The room's name, crew, settings, project, folder (and later its worktree), and the ledger of open findings stay: open findings are still open.
- **Then.** The room waits in chat, with nothing queued. The same sheet can start the first step straight away: a message, a planning topic, or a build task, as the new-room form does.
- **Earlier sessions.** In the transcript, each earlier session folds into one line with its dates and phase totals, which opens to show it, as folded review rounds do. The strip can show any earlier session. Its totals don't change.
- **Safety.** The action names the session it ends, so a second click or another client gets a refusal rather than a second new session. The boundary is saved with the room and survives a restart.

## Reviewable slices

Preserve the owner's delivery order and insert the newly requested small plan-review slice immediately after safe question targeting, so its buttons and re-check cycle use the same stale-question protection. The owner then added the design system and re-skin right after the app-thread boundary (13 Oct): the page takes its approved look before the Home slices build on it. Later the same day the owner asked for a timeline of each session's phases at the top of the room, and for a way to start a new session in a room, leaving where they go in the plan open. They come right after Home: Home completes the guard milestone the plan is built around, and the folder guard and worktrees after it are larger and don't depend on them. The sequence is usage observations; graceful holds and desk pause; the app-thread boundary; the design system and re-skin; safe question targeting; plan checks and changes; the usage guard with phone controls; Home overview; Home answers and buttons; the session timeline; new sessions; then the two shared-folder slices and worktrees. On 14 October the owner added two slices right after the third worktree slice (copied files and setup), the fix first: the Codex app's folder check, following an app turn that ended with an error, and Claude runs with more than one result (in that order); then earlier sessions, a time ruler, and zoom and pan on the session timeline. The remaining worktree slices follow them.

There are twenty-two executable slices. Slice 4 re-skins the page with the approved design system. Slice 6 delivers the plan-review improvement early. The desk-control milestone is Slice 7 and core Home finishes at Slice 9. The session timeline is Slice 10 and new sessions Slice 11. The cheap one-builder guard is Slice 12; coordinating plan/chat writes and reviews is a separate Slice 13. Worktree foundations, the room's own worktree, and copied files and setup are Slices 14-16. Slice 17 is the owner's fix slice: the Codex app's folder check, following an app turn that ended with an error, and Claude runs with more than one result. Slice 18 adds earlier sessions, the time ruler, and zoom and pan to the session timeline. Project-wide check order, review, return, and cleanup of worktrees are Slices 19-22. Deferred features retain their reasoning in Later at the end, without numbered headings or completion gates for this release.

Run appropriate targeted tests while developing each slice, then the repository's required syntax and full-suite checks before its handoff. Re-read concurrent changes before editing. Each slice updates README only for behavior that actually ships and writes a review handoff in `docs/reviews/`. The graceful-policy foundation and the preparation/send boundary remain separate reviews.

### Slice 1: Normalize usage observations

**Scope.** Add `src/usage.mjs` with pure normalization and window/group identity helpers. Extend adapter observations with type, duration, source and receipt time, and explicit unknown fields. Define the shared Codex allowance mapping and its configurable schema; Slice 2 supplies durable desk-policy storage for edits. Add migration of the current latest-reading store and passive refresh with cleanup on shutdown. Defer the history store until forecasting is implemented. Preserve current meters; no automatic holds or projections yet.

**Verification.** Use synthetic logs and fake Claude events for valid, missing, malformed, delayed, expired, and conflicting readings. Verify source-time ordering, shared readings never being summed, model-window identity, same-record deduplication, unchanged fresh readings, and old-data migration. Stub all passive sources and detection so tests never read the real app or account logs. Check shutdown leaves no timers.

**Done when.** Current usage displays remain compatible, both interfaces resolve to the intended allowance group, data provenance survives storage, and invalid or old data cannot masquerade as a fresh zero.

### Slice 2: Durable graceful holds and desk pause

**Scope.** Add versioned desk policy storage, manual scopes, desk pause, explicit blocked reasons, and a desk scheduler over existing room queues. Pause queued project checks with the desk, preserve room control state, and wake every eligible room on enqueue, completion, release, and error. Add graceful API operations and persist restrictions before acknowledging them. Slice 3 separately owns the final-send boundary, app-thread reservation, and uncertain-send recovery. Immediate interruption is retained under Later.

**Verification.** With several fake-agent rooms, hold Codex during two active turns and prove both finish, neither queues into a new admitted turn, and Claude proceeds. Test desk pause with new rooms, queued checks, and owner answers. Test family versus app-only versus headless-only scopes, layered manual/room holds, corrupt and unsupported policy files, failed writes, restart, concurrent release/completion, and all-room wake-up. Test the scheduler's stable eligible ordering without adding caps.

**Done when.** Graceful policy and persistence are reviewable independently, room pauses remain intact, and every blocked queued request has an accurate reason. The handoff explicitly leaves preparation/send races and app submission accounting to Slice 3.

### Slice 3: Enforce the submission boundary and reserve app threads

**Scope.** Build on Slice 2 to separate preparation from submission. Requeue unsent work if a hold arrives during preparation; check cancellation immediately before spawn/send. Preserve catch-up and briefing until actual start. Add one reservation per outstanding app-thread submission, reattachment under holds, suppressed automatic opening while held, and durable accounting for uncertain outcomes. This is the mandatory app serialization work moved earlier by crew agreement.

**Verification.** Pause or hold during a deferred snapshot and assert no send, no lost owner note, and one later delivery. Use an already-aborted signal before headless launch and before the app queue command. Fake-app tests cover two rooms using one thread, different threads, reattachment under desk/room pause, completion during restart, duplicate callbacks, no second send, and no automatic opening while held. Crash at the submission/persistence boundary or time out observation and verify the reservation remains until reconciliation. Ensure failed preparation releases only unsubmitted capacity and wakes other eligible rooms.

**Done when.** No unsent request passes a newly applied restriction, observing accepted app work is independent of sending permission, and uncertainty cannot free a thread or cause automatic duplicate submission.

### Slice 4: Design system and re-skin

**Scope.** Re-skin the current page to the prototype the owner approved on 13 Oct. Copy it into the repository as `design/prototype/toryo-desk.html`; its sample data is made up and stays that way. Its dashed *Prototype* bar (*Play the relay*, *Reset*) is a demo control and isn't built. Its Home shows how the Home slices will look; what Home shows and does still follows this plan's Home section.
- **Tokens and docs.** Light and dark tokens, as in the prototype's `:root`, in their own file under `web/`, and `docs/design-system.md` (principles, ring states, colors, type, components, motion).
- **Color means activity, never identity.** Activity colors come from the logo: purple plans, blue builds, mint reviews. Orange is only for "needs you", amber only for usage limits getting close. The neutrals come from the wordmark's navy and the tagline's slate. Per-agent colors go: agents get neutral monograms, and the Codex app's has a small window corner.
- **Activity rings** on every room tile (the rail, the room header, later Home) and on a working agent's picture, driven by the room's real state:
  - Building, reviewing and planning: a faint track with a sparkler running round it on a canvas. It has a hot point with a turning glint, sparks thrown in every direction that sometimes fork, a fading trail that cools from white to the activity color, and embers drifting off. One `requestAnimationFrame` loop runs every sparkler on one shared clock (`performance.now()` mod 2.8 s). Off-screen canvases are skipped, particles are capped, and `devicePixelRatio` is capped at 2.
  - Checks: four grey dashes marching round. Needs you: an orange ring pulsing in place. Working while a question waits: the sparkler inside, the orange pulse outside.
  - Paused: dashed. Held: dotted, with a lock. Done: solid mint with a check. Failed (needs a retry): solid red. Idle: no ring.
  - CSS animations take a negative `animation-delay` from the same clock, so re-rendering never restarts them. With reduced motion: solid rings, no canvas, no pulses.
  - The logo in the top bar is live: each block breathes while that kind of work runs anywhere.
- **The page, restyled as in the prototype:**
  - the top bar, with the mark and wordmark, the working and "need you" counts, the theme and Settings;
  - the rail, with rooms grouped by project, each tile with a one-line state, and the ring legend;
  - the room header, with a state sentence, the mode switch, and Pause, Stop and Room;
  - the timeline: turn cards whose status chip takes the color of what happens next, role chips, the checks row, slice markers, a slice's earlier rounds folded into one line, your notes as bubbles, and question cards with *Use the recommendation*;
  - the composer;
  - the side panel, with Plan, Crew and Ledger tabs, the segmented plan progress bar and the time each slice took;
  - sheets and toasts.
  - Below 1180 px the side panel becomes tabs in the room; below 760 px the page is one column with a bottom tab bar.
- **Fonts and favicon.** Lexend (headings and numbers), Figtree (text) and JetBrains Mono (commands), bundled as woff2 under `web/` with their OFL licence files. They're served like the other page files, so the page still loads nothing from the internet; if they can't be downloaded, the fallback stacks are used and the owner is told. The favicon is the logo mark.
- **Kept.** Every existing behaviour and control, and the element ids the tests and the browser check rely on (or the tests change in the same slice). Zero dependencies, and plain words for the owner.

If it's too big for one review, it's reviewed in two parts: (a) tokens, type, components, layout and docs; (b) the activity rings, the sparkler and the live logo.

**Verification.** The test suite and the browser check pass, updated for any changed markup. Screenshots at 1440, 1024 and 390 px, in light and dark, and with reduced motion. AA contrast in both themes, visible keyboard focus, and no sideways scrolling at 320 and 390 px. The page stays smooth with several rooms working at once, and makes no request outside the desk.

**Done when.** The page has the approved look in both themes and at every width, each ring shows its room's real state, every existing control still works, and the design system is documented for the Home slices to reuse.

### Slice 5: Target questions safely across every existing client

**Scope.** Finish explicit room/question targeting on the server, CLI, MCP, and current room page before the phone milestone. Cover open chat questions, multiple workflow questions, retries, and planning synthesis. Add shared checkpoint acceptance that records the displayed recommendations and default author, to be reused by Home later. Keep any sole-question CLI convenience safe by resolving and posting its ID; reject ambiguous selection. Home layout and desk-control buttons are outside this slice.

**Verification.** Use two clients to answer the same or superseded question; only the intended continuation may be queued once. Test several questions from one agent without closing unrelated questions, stale retry and synthesis requests, invalid authors, missing recommendations, and planning acceptance recording the actual choices. Drive the same races through CLI and MCP as well as HTTP and the room page. Verify a blocked recipient leaves the accepted answer queued without bypassing a hold.

**Done when.** The existing phone answer path and room UI cannot answer a replacement question or start duplicate synthesis, and Home can reuse these operations without introducing another answer implementation.

### Slice 6: Check ready plans and re-check requested changes

**Scope.** Reuse the current plan-check/revise flow to add Ask Claude (or other non-author planners) to check the plan alongside Start building, Read, and Ask for changes. Send read-only findings to the author automatically and return to Ready after their response. Add the persisted Re-check after changes setting, on by default, with one reviewer pass per owner change request and no recursive pass after the author addresses that review. Add one-click forwarding of a ready-plan discussion with a non-author as a change request to the author. Bind actions to the question/plan revision, persist the bounded cycle, and reuse the shared engine actions through page/API/CLI/MCP. Correct recommendation wrapper parsing and acceptance formatting, including the reported trailing `)?` bug. No new planning service or open-ended review loop.

**Verification.** With fake agents, exercise the requested sequence exactly: owner asks for changes → author revises → other planner checks read-only and requests a fix → author addresses it → plan is Ready again. Assert one check pass, automatic delivery of its findings, and no self-review or recursive re-check. Also test manual Ask for a check, several checkers' findings collected once, an approving check, the setting off, no other planner, and a checker question returning to that checker read-only. Forward an owner/non-author chat exchange with exact message IDs and speaker attribution; the author receives it once as a change request and enters the same cycle. Cover stale Ready cards, a file changed during checking, double clicks, restart during the cycle, holds, Stop/mode replacement, and late callbacks. The `(Recommended: yes to both)?` fixture must accept as `Go with your recommendation: yes to both.`; nested parentheses, quotes, and legitimate punctuation survive. Verify both room and chat acceptance paths and phone-sized controls.

**Done when.** A ready plan can be checked without starting a build, owner-requested changes receive the configured single automatic check, findings reach the author, and the plan returns to Ready with truthful review state. Chat discussions can be handed to the author explicitly and recommendation acceptance adds no wrapper punctuation.

### Slice 7: Threshold guard, reset release, and phone controls

**Scope.** Add per-window thresholds, enabled/disabled and auto-release settings, reset expiry, guard pause until reset, events, and notifications. Expose graceful desk/agent/guard operations and state through API, CLI, and MCP. Release must report remaining guards and offer the ready-to-run timed override command and equivalent MCP arguments. Initialize new and existing desks at the accepted enabled 90%/90% thresholds with auto-release and one notice, preserving existing explicit settings. Exclude provider-exhaustion handling, one-turn exceptions, forecasts, and Home controls from this milestone.

**Verification.** Extend `test/fake-agent.mjs` for ordinary usage reports. With a fixed clock test equality at 90%, simultaneous window causes, one resetting while another remains, late expired reports, sleep, and restart past reset. Cover no fresh Claude report, missing reset, auto-release disabled, failed persistence, shared Codex scope, manual holds overlapping guards, settings changes, and timed guard exceptions. A fake turn reports 92% usage, then fails with an ordinary error: its existing automatic retry must stay queued under the threshold hold and run once after reset, subject to remaining holds. This requires no provider-exhaustion classifier. Verify enabled 90%/90% initialization on new and existing desks, one activation notice, and migration preserving explicit disabled/custom settings. On a temporary server, assert matching HTTP/CLI/MCP behavior and an actionable Release response for each remaining threshold window.

**Done when.** Threshold holds and reset release work unattended, ordinary retries cannot bypass the guard, and the owner can control the feature from MCP. The accepted defaults and migration behavior are applied, while explicit saved choices remain intact; provider-exhaustion recovery and one-turn exceptions are outside this milestone.

### Slice 8: Home overview and recent activity

**Scope.** Add a bounded overview and feed, `#/` navigation, the Home tab, and responsive read views for questions, work, usage, blocked rooms, and Recent. Report preparing, app queue time, actual work time, and last-output age separately. Reuse SSE and refresh the overview after reconnect; do not download full transcripts.

**Verification.** API tests cover multiple live rooms, multiple questions, merged desk/room activity, completion ordering, patch deduplication, stable limits, and reconnect snapshots. Check desktop, 390px, and 320px layouts against an isolated fake-agent server. Verify deep links, back navigation, keyboard access, no horizontal overflow, escaping of hostile titles/activity, and a visible disconnected state. Ensure bursts of events do not trigger one full-history fetch per room or overwrite focused controls.

**Done when.** Home answers who, where, what, how long, and why waiting on both phone and desktop, while existing room links and workflows remain available.

### Slice 9: Home answers and control buttons

**Scope.** Reuse Slice 5's question-targeted operations and Slice 6's plan actions for Home answers, ready-plan checks/change requests, and compact planning acceptance; the full form remains in its room. Wire the already-tested pause, hold/release, guard settings, and guard-pause operations. Release shows the explicit Pause this guard until reset button for remaining applicable windows. Show the activation notice until acknowledged. Preserve drafts/focus. No new answer routing, review loop, one-turn permission, or guard engine belongs in this slice.

**Verification.** Test answering while held, named author/recommendations, stale cards after another client answers, family/app-only/headless-only controls, Release with several remaining guards and the corresponding buttons, unknown-reset explanations, refresh while typing, and failed submissions. Check keyboard and phone operation at the specified widths. Ensure Home uses the same actions, results, and question IDs already verified through CLI/MCP; refresh must not erase an explicit guard disable choice or show the activation notice repeatedly.

**Done when.** The owner can answer and control the desk from Home without losing drafts or clearing unrelated restrictions, Release offers a direct override action where appropriate, and core Home is complete without the deferred one-turn feature.

### Slice 10: Session phase timeline at the top of the room

**Scope.** Add the shared phase calculation, the structured times it needs (a checks run's start; pauses, holds, and resumes), the strip in the room's sticky header with per-phase totals in words, segment details and links, the accessible list, and the phone layout. Add the current session's totals to the room's summary, `toryo show`, `toryo status` where space allows, and `toryo_room`. Until Slice 11, a room's session is its whole history. No new session action, no Home changes beyond what the summary already carries, and no changes to how work runs.

**Verification.** Unit tests on synthetic events: each turn kind lands in its phase; parallel turns in one phase count once; overlapping phases are each counted; checks use their recorded start, or their end and seconds in older rooms; waiting for the owner runs from question to answer, with overlapping questions counted once; paused and held time; gaps over 30 minutes are compressed and labelled; rooms from before the structured times show what can be known and nothing false. With fake agents (`workMs`, sleeping checks), a real room's totals match the run within a second. In the browser: the strip appears and grows while a turn runs; a segment's details and its link to the turn; the list by keyboard; light and dark contrast; reduced motion; no sideways scrolling at 320 and 390 pixels. A room with thousands of events updates its strip without rescanning all of them on every event. The command-line and MCP lines match the page's totals.

**Done when.** Each room shows, at its top, how long its session has spent planning, building, reviewing, and running checks, in color and in words, live, on desktop and phone, and the command line and MCP report the same totals.

### Slice 11: Start a new session in a room

**Scope.** Add the new-session action to the engine, API, page (room menu and sheet), `toryo session new`, and MCP: the confirmation, the refusal while work runs, closing open questions, the new flow, the transcript marker, agents starting fresh by default (with the option to keep their memory; the Codex app keeps its thread), and starting the first step from the same sheet. Scope the timeline and totals to the session, fold earlier sessions in the transcript, and let the strip show an earlier session. The room's name, crew, settings, folder, and ledger stay.

**Verification.** Refused while a turn runs or work is queued, naming it. Accepted when idle, paused, stopped, or done: open questions close and a later answer to one is refused; a result arriving late from before the new session changes nothing; each agent's next turn starts a new agent session with the briefing, unless kept; the Codex app keeps its thread. Two clients or a double click start one session. The boundary survives a restart. The strip and totals start from zero; an earlier session's totals are unchanged and viewable; earlier sessions fold in the transcript and open again. Starting a plan or build from the sheet works as from the new-room form. API, command line, and MCP give the same results and refusals. Phone layouts at 320 and 390 pixels.

**Done when.** The owner can start a new session in a room, for example to plan the next sprint, with the timeline starting again and the earlier sessions kept and readable, without deleting the room or losing its history.

### Slice 12: Refuse a second builder in the same folder

**Scope.** Add a canonical-folder builder reservation, including the Codex app. Refuse a second shared Build, name the occupying room, and offer to wait or use a worktree once available. Keep the reservation through the build/check/review cycle, pause, hold, and restart; release only when work has ended or Stop has actually drained writers. Show the owner and waiting room on Home, in the room header, and in `toryo status`/API/MCP. This is only the cheap one-builder guard; plan/chat write coordination, external reservations, and stale reviews belong to Slice 13.

**Verification.** Race two Build starts in one temporary folder and admit one. Cover project aliases, symlinks/nested paths, distinct folders, same-room builder/reviewer handoff, holds/pauses, recovery before dispatch, Stop with a late result, and known outstanding/uncertain fake-app work. Assert the refusal names the occupying room and presents wait/worktree choices consistently on Home and in status. Never inspect or start the real app.

**Done when.** Toryo refuses a known second builder in the same folder and names the blocker without implementing a general file-access scheduler in this slice.

### Slice 13: Coordinate plan and chat writes between turns

**Scope.** Add short read/write reservations alongside the builder claim. Plan authors and writable chat wait for a quiet gap with no turn, preparation, outstanding app submission, setup, check, or review in that folder; an eligible waiting writer takes the next gap before new build work starts. Let the build keep its long-lived claim and resume afterward. Notify its room of the actual changed files, with durable delivery before the next turn. Add the owner-managed I'm using this folder reservation, protect active reviews from concurrent writes, and mark observed stale reviews out of date. Reuse existing snapshot/change lists and workspace status; no worktree creation yet.

**Verification.** A fake long-running build completes a turn, a waiting plan author writes in the gap, the build receives the changed-file note, and its next turn runs afterward without the build ending or releasing its builder claim. Test writer arrival before queued checks/reviews, a reviewer already reading, writable chat, external reservations, author holds, desk pause, simultaneous admissions, restart, notification deduplication, and an app submission whose completion is uncertain. An external edit observed during review marks that review stale. Verify a second builder stays refused throughout the borrowed gap.

**Done when.** Shared plans need not wait days for a build to finish, known writers/readers do not overlap, and the build learns exactly which files changed before proceeding. External activity remains an explicit limitation rather than a claimed filesystem lock.

### Slice 14: Make snapshots workspace-aware and lossless for supported trees

**Scope.** Introduce persisted workspace identity with main-folder defaults for existing rooms. Key snapshot caches, indexes, locks, and references by actual workspace; pin each room's base independently. Replace silent large-file omission with complete capture or an explicit failure. Preserve working contents, modes, links, binaries, deletions, and non-ignored untracked files. Detect source changes during capture and unsupported repository features. Keep project index/HEAD untouched. Object independence from source garbage collection is the separate near-term bug fix listed under Later, not part of this slice.

**Verification.** Use disposable repositories with staged plus unstaged edits to the same file, untracked files, a deletion, executable-bit change, symlink, binary, and a changed file above 20 MB. Include an unborn repository and project configured below the Git root. Two workspaces under one project snapshot their own files without cache/ref cross-talk. Fail or retry a deliberately changing source. Prove copied-private-file exclusions, missing-folder failure, and no main index/HEAD/branch change. Unsupported features produce an explicit refusal rather than a partial baseline.

**Done when.** A supported snapshot faithfully reproduces the starting files and has stable workspace provenance; an incomplete capture cannot be used to create or apply a worktree. Existing snapshot consumers remain compatible.

### Slice 15: Create and bind a room worktree

**Scope.** Add the Build workspace choice, default own-worktree for new headless crews, and native linked-worktree provisioning under TORYO_HOME/worktrees from the pinned snapshot. Keep existing rooms in place and app crews in main. Persist branch/path metadata and recover partial creation, including dirty and unborn projects without a project commit. Stage the starting snapshot in the room's private index so plain git diff starts empty; main staging stays untouched. Bind every room operation to its workspace, including files, plan readers, snapshots, read-only mounts, and fresh sessions on a folder change. Fix src/protocol.mjs so the Repository briefing names the room cwd, explains the staged baseline, and explicitly forbids main-folder edits. Add main-folder Edit/Write/NotebookEdit deny rules to Claude's write turns and use existing filesystem protection where supported; preserve Codex's workspace confinement. Show folder/branch/shared-room information in Home, header, CLI, and MCP.

**Verification.** Create two fake Build rooms from dirty main: both inherit its snapshot and then edit only their own files. Main files/index/HEAD and existing branch tips stay unchanged; room registration, branch metadata, and private-index/blob writes are the intended Git changes. Assert the worktree index equals B, plain git diff is initially empty, inherited staged/unstaged/untracked changes do not appear as room edits, a later room edit does appear, and new untracked files still enter the snapshot delta. No commit is created. Inspect first and resumed prompts: Repository and all work instructions name the worktree, and any main path appears only as a protected source/destination, never the place to edit. Capture Claude launch rules on write turns and verify main-folder denies; with the filesystem wrapper available, fake shell writes to main fail while writes in the room succeed. Cover orphan creation, subdirectory projects, path spaces, creation failures/restart, collisions, escaping links, wrong-folder app metadata, and every cwd-sensitive reader/check/snapshot path.

**Done when.** A room uses its declared workspace in both prompts and execution, Claude's write path protects main, inherited changes are staged only in the private worktree index, and no missing folder or old session silently redirects work to main. Setup, reviewed return, and cleanup remain visibly pending until their slices ship.

### Slice 16: Copy configured files and run setup before the first turn

**Scope.** Add project copy patterns and setup configuration, a preview of matched paths, and a durable setup step using the checks' output/status UI. Copy approved ignored files privately without adding them to snapshots or returned changes. Block the first agent turn until setup succeeds. Expose settings and retry/output actions through shared API/CLI/MCP operations. Integrate graceful desk/room pause, Stop, and interrupted-setup recovery.

**Verification.** Copy selected `.env` fixtures without leaking contents into events/diffs. Reject link escapes, outside paths, source-file collisions, and attempts to include protected files by changing ignore rules. Fake setup observes room cwd, creates room-local dependencies, and leaves main unchanged. Test failure/retry, restart during setup, pause before setup, agent hold during setup, cancellation without automatic replay, and setup edits appearing in the ordinary source delta. Do not run real package installs or credentials.

**Done when.** A first turn cannot outrun setup, the owner can see and retry failures, and private copied files never become part of a normal return operation.

### Slice 17: Fix the Codex app's folder check, a failed app turn, and Claude's later results

The owner's fix slice (14 Oct; [the first note](../decisions.md#2026-10-14-following-a-codex-app-turn-that-ended-with-an-error-and-a-fuller-session-timeline), [the second](../decisions.md#2026-10-14-the-codex-app-threads-real-folder-and-every-claude-result-kept)), in this order: the folder check first, since it blocks a room completely; then following a failed app turn; then Claude's later results.

**Scope.**
- **The Codex app's folder check.** `localFolder` in `src/agents/codexapp.mjs` understands `\\?\C:\…` like `C:\…`. The owner can say once, for a thread, which folder it really works in: from the room's Codex app thread setting, and through the API, the command line and MCP. The check compares that folder, not the app's recorded one. It's set only by the owner and never guessed from the log. Rooms with their own worktree still refuse the app. A refusal says what the app recorded, what the room expects, and how to tell Toryo where the thread works.
- **A Codex app turn that ended with an error.** Read `task_complete`'s `error` (its message and `codex_error_info`) and report it as the turn's error, never as an empty message. Following a turn, and following it again after Toryo lost track, goes past a failed ending: after it, a `task_started` in the same thread with no user message in between is the same work resumed, and that turn's `task_complete` reply is the result. A user message without Toryo's marker first means the thread moved on to someone else's message: the turn ends saying so, without taking that reply. With nothing after the failed ending yet, following keeps waiting and says so in the activity. The question when Toryo loses track names the app's error and says that resuming the turn in the app, then *Follow it again*, picks up the resumed turn. Not part of it: recognizing usage exhaustion (Later).
- **Claude's later results.** `src/agents/claude.mjs` keeps every `result` of a run, in order: the main answer first, any follow-up after it, marked as a follow-up (a background command's notice can wake Claude again after its answer). The status comes from the last status line, and the ledger reads the whole text. The run's cost and token totals are checked across results and counted once (in the owner's sample `total_cost_usd` is cumulative and `usage` isn't). Optionally, the briefing asks agents to stop their own background commands before their final answer.

**Verification.**
- **Folder check:** `\\?\C:\…`, `\\?\UNC\…` and plain forms map alike. A thread whose recorded folder isn't the room's, with the owner's folder set to the room's, is sent to, and one set elsewhere is refused. The folder is set and cleared through the room's setting, API, command line and MCP, and survives a restart. Worktree rooms still refuse. The refusal's wording names the recorded folder, the expected one, and how to set it. Synthetic thread lists only.
- **Failed app turn:** a fixture built from the owner's minimized sample (ids replaced; no real app files): a `task_complete` with a null `last_agent_message` and an `error`, then `thread_settings_applied`, `task_started`, developer messages, the resumed work and a `task_complete` with the handoff.
  - The first ending reports the error and its `codex_error_info`.
  - Following again from Toryo's marker takes the resumed turn's reply (its status line included) as the result, without failing on the earlier ending.
  - With only the failed ending in the log, following keeps waiting, says so, and picks the reply up when the resumed turn is appended.
  - With a user message without the marker after the error, it says the thread moved on and takes nothing.
  - The lost-track question's wording.
  - Existing app tests (markers, restarts, uncertain submissions, holds) still pass; no real app, queue or thread is used.
- **Claude's results:** a fake run with the owner's minimized stream (a long result, a background task's notice, a one-line follow-up result) keeps both texts in order with the follow-up marked. The status is the last one, the ledger sees the review's `Resolved:` and `Open:` lines, and cost and tokens aren't double-counted. A run with one result is unchanged.

**Done when.**
- The owner's app threads pass the folder check once their real folder is set, and a refusal says how to fix it.
- A Codex app turn that ends with an error shows that error, and a room whose app turn is resumed in the app picks up the resumed turn's result with *Follow it again*, without letting the turn go or restarting the build.
- A Claude run with a follow-up keeps its whole answer.

### Slice 18: Earlier sessions, a time ruler, and zoom and pan on the session timeline

**Scope.** Opening an earlier session's fold in the transcript shows that session on the strip; folding it, or *Back to session N*, returns to the current session. The strip takes the whole width of the middle column, with the totals in words on their own line. A time ruler as its x-axis: clock-time ticks (dates across days) that get finer with zoom, and compressed breaks drawn on the ruler as breaks with their length. Zoom with the scroll wheel around the pointer, pan by dragging, fit with a double-click or *Fit*; clicking a segment still goes to its turn, and a drag is never a click; keyboard zoom, pan and fit; the list stays for screen readers. Compact in the sticky header; phones keep their single bar. The shared calculation in `web/phases.js` provides the ruler's ticks and the breaks' places, so the page and its tests agree.

**Verification.** Unit tests of the ruler: tick spacing at each zoom level, clock times and dates across midnight, breaks shown as breaks with their lengths, never an evenly spaced axis across a break. In the browser: opening and folding an earlier session switches the strip, and *Back to session N* returns; the wheel zooms around the pointer and dragging pans, without page scroll or a click on release; double-click and *Fit* restore the whole session; a click on a segment still opens its turn; keyboard zoom, pan and fit; the list for screen readers; the strip's height in the sticky header; light and dark; reduced motion; no sideways scrolling at 320 and 390 pixels, where phones keep the single bar.

**Done when.** The owner can look at any session's timeline at the top of the room, read real times off its ruler, and zoom into and pan along it, by pointer or keyboard, without the strip taking more room in the header.

### Slice 19: Serialize project checks and expose room environment values

**Scope.** Run setup and checks one at a time per project across its rooms/worktrees, unless a project setting explicitly enables parallel execution. Show which room is using the slot and queue other steps. Supply TORYO_ROOM_ID, TORYO_WORKSPACE_PATH, and a stable persisted TORYO_PORT_OFFSET to room commands. The project chooses whether to use the offset; it is not a port reservation. Managed dev servers, general resource declarations, and test-database naming belong to Later.

**Verification.** Two fake room check/setup commands in separate worktrees never overlap by default; both can run when the project setting explicitly permits it. Different projects proceed independently. Verify room cwd/ID and distinct stable offsets in fake agent, setup, and check processes, then restart, queued order, desk pause, Stop/cancellation, and releasing the slot after success or failure. No test installs dependencies, provisions a database, starts a managed dev server, or binds/contacts port 4777.

**Done when.** Project setup/check concurrency follows the explicit setting and every command receives its room context. The UI states that ports/databases still need project-specific handling instead of promising service isolation.

### Slice 20: Review the full room contribution and preview return conflicts

**Scope.** Add final snapshot R, full B → R review, current-main snapshot M, and a three-way return preview computed outside main. Display both the room's contribution and the proposed destination changes, with complete large-text/binary access. Add stale-review/preview identities, conflict presentation, and regeneration after explicit isolated resolution. Use the same preview through UI, CLI, and MCP; this slice has no Apply mutation.

**Verification.** Start with dirty main, then make independent changes in main and the room: the contribution excludes inherited dirt and the destination preview preserves unrelated owner edits. Cover overlapping edits, binary conflicts, add/add, delete/edit, mode/link changes, renames represented faithfully, untracked destination collisions, branch commits when permitted, and diffs beyond current truncation limits. Repeat with staged/unstaged main changes and an unborn repository. Hash main files and index before/after every preview; nothing changes. A changed room or main invalidates the old preview.

**Done when.** The owner can inspect the full contribution and all conflicts from phone or desktop without any write to main, with honest handling of binaries and large diffs.

### Slice 21: Apply an approved preview as uncommitted changes

**Scope.** Add the explicit preview-bound Apply operation, destination reservation, final checks, worktree-only writes, durable backups/journal, and interrupted-apply recovery. Preserve main staging/HEAD and reject stale approvals before writes. Record delivery and subsequent contribution baselines to prevent duplicate application. Add no commit action; returning files remains a complete no-commit workflow. Do not restart or deploy anything.

**Verification.** Prove main HEAD, branch tips, and index bytes are unchanged after return; room changes arrive as uncommitted files and unrelated owner work survives. Conflicts, stale tokens, ignored/untracked collisions, path escape, active writers, changed reviews, and changed branch/index state all cause zero destination writes. Exercise duplicate clicks, restart after delivery, pre-existing room commits, no new commit offer or implicit commit, a second return after resumed work, and injected disk/permission failures at each write phase. Recovery must not overwrite an external edit made after a failed write. An isolated Toryo test server continues serving its startup page assets while its test source changes; never touch the live desk.

**Done when.** Only an explicitly approved, current preview can change main, no-commit projects need no exception, conflicts leave main untouched, and failures show a recoverable, truthful file state rather than silent partial success.

### Slice 22: Measure and clean up room worktrees

**Scope.** Add bounded asynchronous disk measurements, measured-at/partial states, and the room-delete choice to keep or remove its worktree/branch. Show unapplied work and optional branch commits before discard. Verify ownership, drain Toryo-managed turns/setup/checks, preserve history/apply receipts, and retain cleanup recovery records. Complete the phone, CLI, and MCP cleanup flows and document the full worktree workflow.

**Verification.** Measure temporary worktrees with dependencies, links outside the tree, and permission failures without scanning on every event or double-counting common Git storage. Test keep, explicit discard, deletion after apply, a branch used elsewhere, an unrelated replacement directory, active fake-app uncertainty, active setup/check processes, missing directories, failed removal, retry after restart, and concurrent apply/delete. Protect main, foreign worktrees/branches, and external processes. Exercise choices and path labels at 320px/390px and through CLI/MCP.

**Done when.** The owner can see each worktree's storage use and safely keep or remove it, cleanup failures remain actionable, and the complete create/setup/review/return/delete workflow is documented and verified.

## Risks and rejected alternatives

- Usage is an observation of the provider's allowance, not an exact forecast or spending reservation. Late reports and external use can exhaust it sooner. Keep age and scope visible; do not promise that a threshold guarantees the phone-control session remains available.
- The shared Codex account is the owner's belief, not detected account identity. Keep the mapping inspectable and changeable, and do not combine incompatible model-specific windows.
- App submission and local persistence cannot be one transaction. Track uncertain outcomes, retain thread reservations, and never automatically resend just because a timeout or crash occurred. This can require owner attention rather than falsely promising uninterrupted recovery.
- Passive Codex logs can be large. Bound scans, avoid unnecessary rereads, and do not let polling block control handling. Browser feed updates and history retention must also remain bounded.
- Concurrent review work can satisfy or change a planned slice. Rebase the implementation mentally on the current functions and tests; preserve other work and report what is already covered.
- Native worktrees write registration and new-branch metadata into the common Git directory. This is a deliberate change from snapshot-only access, while source files/index/HEAD remain untouched. Test Git capability support, unborn repositories, subdirectory projects, and platform path normalization; never substitute a source commit for an unsupported operation.
- Worktrees are file separation, not process isolation. Copied configuration may point at the same database or port, and a command may contain an absolute main-folder path. Scope adapter permissions, serialize project setup/checks unless parallel operation is explicitly enabled, expose the room environment values, and keep external-service limitations visible. Managed service/database isolation is deferred.
- Returning multiple files cannot be atomic against arbitrary external edits or power loss. The conflict path must write nothing; the failure path needs backups, a durable journal, and guarded recovery. Never promise that rollback can safely overwrite a file the owner changed afterward.
- Room dependencies and pinned snapshots may use considerable disk space. Measure it, keep cleanup explicit, and retain enough metadata to recover an interrupted creation/apply/removal. The room branch alone cannot reconstruct the owner's uncommitted starting snapshot.

Rejected alternatives: implementing desk pause by changing every room's pause flag loses the owner's original room choices; requiring a fresh report before reset release can deadlock Claude; measuring with probe turns spends allowance; scraping a separate account service introduces credentials and network behavior outside this scope; automatically swapping a held builder can create self-review or merely move the blockage.

For worktrees, reject starting from HEAD alone because it drops the owner's uncommitted work; committing or stashing main as a prerequisite because projects can forbid commits and the owner must retain their working state; automatically merging a room branch because branch history does not identify the room's contribution relative to its dirty starting snapshot; and applying a three-way conflict directly in main because it can leave conflict markers or change staging. A plain copied folder loses normal linked-worktree/branch behavior. Worktrees in a separate shadow Git repository avoid source registration but make project branch/history behavior surprising; prefer normal linked worktrees populated from shadow snapshots without copying snapshot commits into project history. Worktrees inside the project risk recursive scans and watcher collisions. Warning-only known builder conflicts, unlimited parallel checks by default, silently moving app threads, and letting plan authors write during another room's review all preserve the collisions the owner reported.

## Validation and handoff rules

Use Node 24 by setting `PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH`. Keep Node 22+ built-ins compatibility and zero dependencies. For implementation handoffs run `node --test --test-concurrency=1 test/*.test.mjs` plus `node --check` for affected JavaScript; honor any additional repository checks added during the concurrent review.

All tests use `test/fake-agent.mjs` or in-process fake adapters, synthetic logs, and a temporary `TORYO_HOME`. Start UI/API servers on a separate free port, never 4777. Stub passive usage reads and disable real detection. Existing external Playwright tooling may be used without adding it as a Toryo dependency. Never launch real agents, touch the Codex app's queue/threads/database/deep links, stop or request the owner's running desk, or edit the owner's `~/.toryo/` during implementation or validation. Do not commit.

Worktree tests create disposable source repositories, branches, and worktrees under temporary directories only. Fixtures may construct Git history there to exercise committed and unborn cases; never commit, create a worktree, or apply a return operation in this real repository during validation. Stub setup/install and database commands, use temporary test files/free ports, and test app folder metadata through fakes. The accepted production storage under TORYO_HOME is a product design, not permission to touch the owner's real home during this work.

For this documentation-only turn, validate local links, unique slice numbering, and compatibility with `src/plan.mjs`; no agent or server run is needed. Keep implementation completion boxes/status separate from the fact that the plan itself was written.

Each implementation handoff names the slice, describes resulting owner-visible behavior, lists meaningful verification and unverified adapter assumptions, and notes outstanding conflicts. Update [README](../../README.md) when behavior becomes available, and update [decisions](../decisions.md) only for actual owner choices or durable crew agreement. Do not mark the conflicting duplicate choices settled just because their proposed reconciliation appears in this plan.

## Later

These items preserve useful requirements and reasoning but are not numbered slices, release completion criteria, or dormant backend/UI work for this plan. The owner moved the one-turn exception, forecasts/warnings, Swap, caps, and provider-exhaustion recovery here. The additional snapshot bug fix is explicitly near-term work outside this plan. The owner has now explicitly accepted keeping immediate interruption here as well. Managed dev servers, resource declarations, and test-database naming are also deferred by the accepted review.

### One-turn exception

The owner has deferred Run this one anyway from this plan. Pause this guard until reset supplies the near-term escape hatch without adding durable per-attempt permissions. If revisited, it is a one-attempt exception for a named queued request and explicitly displayed manual/threshold causes. It cannot bypass room or desk pause, Stop, workflow dependencies, an occupied app thread, concurrency caps, or confirmed provider exhaustion. Consume the exception durably before sending; a retry, continuation after interruption, nudge, or later discussion turn does not inherit it. If sending is uncertain after a crash, do not grant it again automatically. This operation is separate from Now, which describes interruption, and from pausing a guard until reset.

Future verification must prove at-most-once consumption across retries, interruption, concurrent dispatch, restart, and uncertain submission. No other request may inherit the permission.

### Usage projections and advance warnings

Deferred to keep the first Home focused on measured usage, age, resets, and controls. A forecast adds a history store, freshness rules, and noisy estimates; it is not needed to hold or release an agent. Hold/release notifications stay in the active guard slice. The following agreed method and design notes are retained for later.

Follow the owner's selected method: recent pace over about six hours when there are at least two distinct source observations an hour apart in the same window; otherwise an average since the inferred window start. Derive that start as reset minus the known duration, label it as inferred, and label which method is shown. It is an estimate, never a control input.

For recent pace use the percentage change divided by elapsed source time. For the fallback use the reported percentage divided by elapsed time since inferred start. Calculate threshold/limit dates and estimated percentage at reset from the latest source observation, not from its later receipt time. Do not pretend a reset window extends beyond its reset: if the estimate would reach the limit afterward, show the estimated usage at reset instead.

Always show an available estimate with its method, source timestamp, and reading age; do not hide all forecasts merely because an agent has been idle for 15 minutes. Recent pace requires a latest observation no older than 15 minutes. Otherwise use the average-since-window-start fallback, including from a single older observation: allow up to one hour of age for a 5-hour window and up to 12 hours for a weekly window. Unsupported window types need a named age bound before forecasting. These are implementation quality cutoffs, not additional owner decisions.

Suppress forecasts when their observation belongs to an expired window, exceeds that window's age bound, or has invalid/unknown duration/reset, less than 15 minutes elapsed at observation time since the inferred start, inconsistent counters, or a nonpositive interval. Keep the measured usage and its age visible even when the estimate is unavailable. A flat recent pace means no predicted crossing at that pace, not an infinite timestamp. If an older estimate puts the threshold in the past, say it may have been reached since the reading; do not shift the prediction forward from now or present it as a measured limit event. Show Too early to tell or Reading too old where appropriate, not zero.

Add a bounded `usage.jsonl` history store for this later feature, keeping up to eight days of genuine observations and trimming during long-running operation as well as startup. Repeated reads of the same log event do not contribute samples; fresh reports with an unchanged percentage can establish a flat pace. Shared Codex readings must be deduplicated before calculating change.

Send one pre-hold warning per guarded window when a valid estimate predicts its threshold in the next 24 hours and before reset. Include the reading age and estimation method. Do not issue a new advance warning for an estimated crossing already in the past, a disabled or explicitly paused guard, or a threshold hold already triggered. Persist warning identity across restart. Display the same estimate and basis in Home, CLI, and MCP. Hold/release notifications remain separate and use existing configured Windows/ntfy channels; no new notification service is introduced.

**Future verification.** Fixed-clock examples cover a six-hour trend, the single-reading fallback, and transition from recent pace to the fallback after 15 minutes. A 45-minute-old 5-hour reading and an eight-hour-old weekly reading still produce labelled fallback estimates; observations beyond one hour and 12 hours respectively suppress them. Test the exact age boundaries, expired windows, insufficient elapsed time, flat usage, bursts, decreasing counters, shared-group duplicates, estimated crossings already in the past, and crossings after reset. Verify method/source-time/age labels, warning boundaries, disabled/paused guards, late estimates after a hold, and restart deduplication. Inspect readable phone copy and matching CLI/MCP text.

### Swap at a safe boundary

Deferred because role reassignment is not needed to deliver holds, Home, or isolated folders. Preserve current Swap behavior; this does not approve automatic takeover. Revisit the queued-role regression and review-boundary behavior independently.

**Retained approach.** Review the existing `swapPending` and queued-role implementation against the owner's requested fix. Retarget pending role-owned requests, refresh instructions naming builder/reviewer, and apply a deferred swap at a defined round boundary. Preserve advisor/chat requests and workflow state. Do not add a takeover offer or bypass a held reviewer. If concurrent review work already covers this behavior, supply evidence and the missing tests/docs only.

**Future verification.** Test queued build-fix, build-next, review, and review-status work; an active builder followed by checks and review; repeated Swap cancellation; a round waiting for the owner; a held prospective builder or reviewer; restart with a pending swap; and final review. Assert each request goes to its actual role, nobody reviews the work they just built because of the swap, no result is dropped, and no duplicate turn or new flow appears. Check prompt role names as well as recipient IDs. An idle room with a completed handoff must not swap that handoff into a self-review; defer until the pending review finishes.

### Parallel-turn caps

Deferred because the usage guard and worktree isolation address the immediate need. Keep headless agents unlimited until a later configured cap exists. One outstanding submission per app thread stays mandatory in the active boundary slice; it is a correctness restriction, not the optional cap feature.

**Retained approach.** Add configurable per-agent caps across rooms, initially unlimited for headless agents. Keep mandatory app-thread serialization. Count reserved, running, and outstanding submitted work once; observing the same app turn after restart is not a second reservation. Lowering a cap allows current work to finish. Expose settings in Home, CLI, and MCP and show where capacity is occupied.

**Future verification.** With cap 1 and three rooms, verify oldest eligible work starts first and continued traffic cannot starve the others. Test cap changes during preparation and execution, disabled caps, crash/error/cancellation slot release, holds overlapping caps, checks excluded from agent quotas, and reconstructed counts after restart. A reserved app slot remains occupied while its submission is outstanding even when local observation times out. Verify interface and any explicitly supported group scopes do not get confused.

When added, cap commands target a named execution agent across rooms, unlike Hold Codex's family scope. Name any future group cap explicitly. Expose the setting through Home, CLI, and MCP without making its future tool or storage schema part of this release.

### Recognized provider exhaustion

Deferred because the threshold guard evaluates reported percentages and reset times without classifying failed turns. Keep current error handling in this release; stale or unavailable readings remain visible. Revisit only if implementation demonstrates a concrete guard dependency, and record the smallest necessary scope change rather than pulling the whole recovery feature back in. Its future value is unattended recovery when external usage exhausts an allowance before Toryo receives another reading.

When implemented, recognized provider allowance exhaustion should be handled separately from an ordinary failure: preserve the interrupted request and partial-work context, hold the relevant scope, and retry once it becomes eligible after reset. Do not spend the ordinary immediate retry on a known exhausted allowance. Completion with a warning about limits must not replay an otherwise completed turn.

Candidate signals already represented in the adapters should be checked against labelled modelled fixtures:

- Claude: a `rate_limit_event` whose `rate_limit_info.status` is `rejected`, with the relevant reset information in `rate_limit_info.unifiedWindows`. `claudeLimits` in `src/agents/claude.mjs` already preserves `status` and converts each window's `resetsAt`.
- Codex, including the app log: `rate_limits.rate_limit_reached_type`, alongside the affected primary/secondary window and its `resets_at`. `parseRateLimits` in `src/agents/logtail.mjs` already uses this discriminator. Preserve its raw value so scope is not inferred from a generic truthy flag.

Add synthetic cases under `test/fixtures/limits/`, labelled as modelled rather than captured production samples. A streaming limited signal can hold future work, but requeue only a turn whose terminal result indicates that exhaustion prevented completion; a successfully completed turn must not replay. Do not guess an affected window or reset from an unfamiliar discriminator or arbitrary agent prose. If reset is unknown, retain the cause and ask for attention. Unrecognized errors retain normal error handling. A stale already-expired rejection must not cause an immediate retry loop.

When a real limit is next encountered, the owner can supply the relevant Claude turn's `output.jsonl` excerpt or the Codex session-log line. Record source/version provenance and minimize/redact unrelated content before retaining a regression fixture. Do not launch a real agent to provoke exhaustion or read the real app's files during validation. Until an owner-supplied sample verifies the candidate format, future exhaustion handling may ship fixture-tested support with that limitation stated in README and its review handoff; the current threshold guard does not depend on obtaining a sample or implementing this recovery path.

### Restore the folder to before a turn

Keep for later as an explicit owner action. **Ask first because restoring overwrites files**, including later edits the owner or another room may have made. Before asking, show the exact folder, target snapshot, and changes that would be discarded; bind approval to that preview and refuse it if the files change. Never restore automatically after a failed turn or confuse this action with ordinary pause/retry. Test refusal without approval, stale previews, and preservation of intervening owner edits. Guarded recovery of a failed Apply remains part of the active apply operation, not a general restore feature.

### Offer to commit an approved slice where the project allows it

Keep for later because reviewed uncommitted return is enough for the current workflow, and some projects forbid commits. Check the project's recorded rules before offering; unknown or forbidden permission means no offer. Show the exact changes, including any inherited uncommitted content, and require a separate explicit owner choice before committing on the room branch. Slice approval and Apply to main do not authorize a commit, push, or merge. Test forbidden/unknown policies, allowed commits, selected files, and unrelated uncommitted work before adding the feature.

### Snapshot object ownership — bug fix to do soon, outside this plan

**Bug fix, soon, outside this plan:** snapshots must keep their own copies of everything they reference, so a Git cleanup in the project cannot break old snapshots. Today shadow snapshots borrow source objects through Git alternates; a retained shadow reference alone does not protect those objects from the source repository's garbage collection.

Fix this independently for existing snapshots as well as new ones: copy reachable referenced objects into Toryo's snapshot storage before relying on it, and report already-missing data rather than treating it as an empty snapshot. The regression test uses a disposable project: take a snapshot, remove the source references and prune its objects, then prove the old snapshot still supports reading files and complete diffs without the source object store. Never run cleanup against the owner's project for this test. Worktree slices consume the snapshot API and integrate this fix when available; they must not quietly absorb its implementation into their scope or claim GC independence before it lands.

### Managed dev servers, resource declarations, and test-database names

The owner accepted deferring these features because project-level setup/check serialization plus room ID, cwd, and a port offset meet the immediate need. Worktree files alone do not isolate ports, databases, caches, or endpoints named in copied configuration; the current UI/docs must not imply otherwise.

If revisited, add explicit managed-server start/stop and process ownership, distinct available ports, named shared-resource reservations, and project-defined per-room test-database names or paths. Never kill an unrelated process to free a port, infer a destructive database command, or restart the desk automatically. Serialization alone cannot protect an independently used database. Future tests should cover distinct endpoints, external processes left alive, occupied ports, configuration collisions, and cleanup/recovery of only Toryo's own resources. These are not current worktree/check/cleanup completion requirements.

### Immediate pause

The owner explicitly accepted keeping this outside the numbered sequence to preserve the graceful-first delivery order. The earlier immediate option remains useful when work must stop now, but safely interrupting, persisting, and replaying work carries a separate set of races. Existing room Stop remains available with its existing semantics; it is not relabelled as a lossless desk pause.

**Retained approach.** Add explicit immediate timing to desk pause and manual holds while retaining graceful defaults. Interrupt cancellable turns and checks, persist pending work, and resume with partial-work context. Preserve flow invalidation and observe app submissions throughout. Expose the immediate option through API, CLI, and MCP.

**Future verification.** Test pause during preparation, active execution, result finalization, and checks. Race pause with completion, Stop, deletion, a new flow, and release. Assert exactly one continuation, no restored canceled work, no lost owner note, no gate-failure retry spent on cancellation, and no duplicate checks/review after recovery. Test Stop on chat requests too, since they may not have a workflow flow token. Fake-app tests prove no second send or opening and accurate still-running status. An immediate pause followed by restart must retain the controls and the existing recovery pause.
