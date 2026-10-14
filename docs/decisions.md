# Toryo decisions

Record the date, the owner's decision or durable crew agreement, and why. A proposed implementation choice is not an owner decision. Planned behavior below is not a claim that the current desk already supports it.

## 2026-10-13: Foreman is renamed Toryo

The owner chose Toryo (棟梁, the master carpenter who runs a Japanese building site) because `foreman` is already a well-known Procfile runner (Ruby gem and Debian package) and an npm package, and the clash showed up on the first day. Toryo was free on npm and in apt, and no software by that name turned up. The command, data folder (`~/.toryo`), settings (`TORYO_*`), status lines (`TORYO:`), MCP tools (`toryo_*`) and the page all use the new name. The old forms keep working so that running sessions, open pages and old data don't break. Past review records keep the name they were written with.

## 2026-10-13: Home and desk-wide controls

The owner asked for one view across several rooms, with usage guards as the main feature. The written plan is [Home, desk-wide controls, and room worktrees](plans/plan-a-home-view-for-foreman-and-desk-wi.md). It was revised after Claude's check, the owner's accepted defaults and scope, and the added plan-review request on 2026-10-13 and is awaiting review; it has not been implemented under this plan. The latest scope decision below controls delivery timing for the earlier requirements.

### Decisions clear in the submitted answers

| Decision | Why |
|---|---|
| Let current turns finish by default when pausing or holding. Immediate interruption is an explicit option. | Stopping a turn midway wastes work. |
| Make the usage guard a core feature, including automatic release at a known reset. | Several rooms should preserve allowance without requiring the owner to return and restart each one. |
| Treat headless Codex and the Codex app as sharing an allowance for the guard. | The owner believes they use the same account. Two interfaces must not evade one account's guard or have their percentages added together. |
| Release automatically at the recorded reset even if no fresh reading has arrived; label old readings expired and immediately apply later valid readings. | Claude may only report usage during a turn, so requiring a fresh reading before release can prevent any resumption. |
| Persist manual holds, desk pause, guard settings, and guard exceptions through restart. Expire eligible usage holds on startup if their reset passed. | Restart should not discard the owner's controls or strand a hold after reset. |
| Ordinary Release clears manual holds, explains any remaining usage hold, and offers an explicit Pause this guard until reset action. | The owner can make an exception directly from the result without silently disabling the guard through a generic release. Home offers a button; terminal/MCP replies provide a ready-to-run command. |
| On recognized allowance exhaustion, preserve the turn, hold until the known reset, and continue automatically when eligible. | Immediate retry and an owner question should not be the normal result of a known exhausted allowance. |
| Pause everything prevents new project checks as well as new agent turns; running checks finish by default. Agent-only holds allow checks. | A desk pause applies to the desk's work, while holding one agent need not stop local validation. |
| Holding the Codex app stops Toryo sending; Toryo continues following its accepted work. The owner must stop app work in the app. | Toryo cannot cancel or retract the app's current work. |
| Keep the Codex app at one turn, with configurable parallel-turn caps built last. | The owner identified the app's single-thread limit separately from optional headless caps. Bringing this restriction forward is the crew agreement below, not a delivery order attributed to the owner. |
| Home opens at `#/`, with a Home tab on the phone and the Toryo name as the return link. | The owner needs an overview before choosing a room. |
| Home's planning checkpoint offers Accept all recommendations and Open the form; keep the full form in the room. | A full planning form can overwhelm the phone overview. |
| Use MCP/Remote Control remotely and the existing authenticated LAN page at home; no tunnels in this plan. | Keep the established phone access paths. |
| Forecast from roughly six hours of history when sufficient; otherwise use the average since inferred window start and say which method was used. Warn once per window if the forecast puts the guard within 24 hours. | The owner wants both an estimate of where usage is heading and advance notice. Forecasts remain estimates, not guard inputs. |
| Build configurable turn caps after the guard and Home, with headless agents unlimited until configured. | Correct holds and the overview come first. |
| Fix and verify Swap so queued work follows roles, separately from any takeover feature. | A role change must not send pending work to the wrong agent or stall the relay. |
| Never switch builders automatically. | Builder/reviewer roles and continuation remain the owner's choices. |

The technical reasons above explain the chosen behavior; they do not add unrequested permissions, external services, or automatic account discovery.

### Durable crew agreement: app serialization before optional caps

On 2026-10-13, both planners agreed to implement one outstanding Toryo submission per actual app thread in the core submission-boundary slice, before optional caps. Several rooms can otherwise send competing work into one app thread, and restart observation must not free an outstanding submission's reservation. The owner chose the app's limit of one; this earlier implementation order is the crew's correctness decision. It does not enable configurable headless caps early.

### Guard activation confirmed after review

Initial activation was open in the earlier drafts. On 13 October, the owner accepted Claude's recommendation: guards start on for both new and existing desks at 90% for both the 5-hour and weekly windows, with automatic release at reset, a one-time notice, and a way to turn them off. Preserve previously saved explicit settings. This settles the earlier migration/default question; Slice 6 implements it in the current numbering.

Why: the usage guard is the main feature and should help the existing desk immediately without erasing choices the owner has already made. The notice appears in CLI/MCP status first and on Home when available.

### Earlier conflicting answers and their resolution

The original planning form contained incompatible answers to overlapping questions. Keep those answers as history; the owner's later scope decision and acceptance of Claude's review settle the current behavior below. No question from that accepted review remains open.

| Topic | Earlier submitted answers | Current resolution | Basis |
|---|---|---|---|
| Guard thresholds | 90% for both windows; elsewhere weekly 90% only; later both windows at 90% again | Enabled at 90% for both, with automatic release | The owner explicitly accepted Claude's 90%/90% and initial-activation recommendation on 13 October. |
| Manual Codex scope | Group Hold Codex everywhere across both interfaces, with both named in the result and a separate app-only control; elsewhere a hold applies only to the one named | Plain `toryo hold codex` / `release codex` cover both; `codexapp` selects app sending only; `codex --headless` selects headless only; omit `--everywhere` | Follows the owner's most specific answer. Every hold already applies across rooms; separately named interfaces retain their narrow controls. This corrects the first draft's unexpectedly headless-only plain Codex command. |
| One-turn override | Show Run this one anyway; elsewhere defer it in favor of Pause this guard until reset; the final form answer includes it again | The owner's subsequent scope decision explicitly defers it to Later, without a numbered slice | The latest instruction resolves delivery timing. Do not add its backend, UI, or dormant permissions to the current release. Earlier contradictory form answers remain recorded as history. |
| Takeover offer | Offer explicit reassignment after the core release; elsewhere exclude it from this plan until a third reviewer is tested | No takeover offer in this plan; retain it as a future owner-controlled possibility | Honors the explicit exclusion from this plan. The owner has now also moved safe-boundary Swap work to Later. |

Earlier answers remain recorded rather than erased. The accepted behavior is grounded in the owner's explicit later messages, not inferred from a technical review passing.

### Implementation boundaries proposed by the plan

These remain implementation choices rather than additional owner decisions: configurable allowance grouping; one atomic desk-policy file; stable usage-window identity; fresh-versus-expired source handling; preparation versus submission as the dispatch boundary; strict question targeting; and conservative handling of uncertain app submissions. The current plan has seventeen active slices after the new plan-review slice and the split shared-folder guard. Deferred forecast and one-turn features do not add dormant storage or commands. Initial guard activation is now confirmed as described above.

## 2026-10-13: The Codex app thread belongs to the room

The owner decided that a room with the Codex app in its crew works in its own app thread, chosen when the room is created and stored with the room. Settings holds only defaults for new rooms: one for every project, and optionally one per project, which wins. Toryo always uses the room's own thread. The thread can be changed only while the Codex app isn't working in that room. Toryo refuses or warns when another room already uses the same thread. Starting a build from the builder's finished round reads the last reply in the room's thread.

Why: with one global thread, changing it in Settings moved the next turn of every room using the Codex app into the new thread, mixing the rooms' work and context.

How it was built (crew choices, not owner decisions): a thread the Codex app is working in for another room is refused; sharing a thread with an idle room is allowed with a warning, and only one room's turn runs in a thread at a time.

## 2026-10-13: Notes get answers

The owner decided that a note written to an agent while it works is answered when that turn ends, before the relay moves on. The agent gets a short turn: its reply starts with "To you:", answers any questions, and says whether the note changes the work. If it does, a builder acts on it and resubmits; a reviewer stays read-only and may restate its verdict. Each note shows its state: waiting for the agent's turn to end, being read, then replied, with a link to the reply.

Why: Toryo said a note would go to the agent "when its current turn ends", but held it until the agent's next turn, which came after the review.

## 2026-10-13: "Waiting for you" comes first in the room list

The owner decided the room list should be readable at a glance: "waiting for you" first and loudest, because it's the only state that needs the owner; then the working agent's initials with its role (a hammer for building, glasses for reviewing); a pause symbol for paused, "Zzz" for idle and a tick for done.

Why: the owner wants to see at a glance which rooms need them.

## 2026-10-13: The desk serves the page it started with

The owner decided that Toryo loads its page files into memory once, when it starts, and serves only those, so the page always matches the code that's running. The set is every file in the page folder, not a hand-kept list. When the files on disk differ from what's served, the page says "Toryo has been updated. Restart Toryo to use it", with the command, instead of offering a reload that can't help. If a page file is missing at startup, Toryo stops with a clear message instead of serving a broken page.

Why: while a build room edited Toryo, a reload loaded a new app.js that imported a file the running server didn't serve, and the page went blank until a restart.

## 2026-10-13: Room worktrees and shared-folder protection

The owner added worktrees to the [Home and controls plan](plans/plan-a-home-view-for-foreman-and-desk-wi.md) before implementation. A planning room had written into a folder another room was reviewing, and build edits had broken the running desk's page. The owner wants two builds on one project, or a build alongside their own work, without those collisions. The separate page-at-startup decision above remains in force.

### Owner requirements

| Decision | Why |
|---|---|
| At Build creation, choose this folder (shared) or the room's own worktree. | Rooms need separate editable files when working concurrently. |
| Seed a worktree from Toryo's current tree snapshot, including uncommitted work, rather than HEAD alone. | The owner's projects retain uncommitted work that a new room must see. |
| Show the full room diff and require an explicit click to apply it to main as uncommitted changes; conflicts cause no automatic modification of main. | The owner must review what returns and retain changes made in main meanwhile. |
| Do not require a project commit for creation or return. A room-branch commit is optional only where the project's rules allow it. | Some projects forbid committing. |
| Configure copied files such as ignored `.env*` and a setup command per project. Run setup before the first turn and show it like checks. | A fresh worktree needs local configuration and dependencies. |
| Run checks and snapshots in the room's own folder. | Validation and review must describe the files the room actually changed. |
| Add a shared-folder guard before worktrees; it must refuse or clearly warn before a second builder, including Codex app work in main. | The original request put this early; the owner's later order places it after Home and before worktrees. The owner then accepted refusing a second builder, naming the occupying room, and offering waiting or a worktree. |
| On room deletion, offer worktree and branch removal; show each worktree's disk use. | Separate dependencies and branches need visible, owner-controlled cleanup. |
| Show room folder/worktree identity and which rooms share a folder on Home and in the room header. | The owner needs to see where concurrent work can collide. |
| Plan worktrees after desk-wide controls. The latest order puts Home and then the shared-folder guard before worktrees. | The usage guard remains the main feature, followed by the overview and file isolation. |

### Worktree choices confirmed after review

On 13 October, the owner accepted Claude's open-question answers: new headless Build rooms default to their own worktree, existing rooms stay in place, known second builders are refused, and the Codex app remains in main for this release. Store worktrees under `~/.toryo/worktrees` (under `TORYO_HOME/worktrees` with a configured home). No per-project location option is needed now.

Planning rooms publish into main at a quiet gap with no active turn, check, or review, then notify the build room with the changed-file list. This explicitly supersedes waiting for the entire build to finish. Checks and setup serialize per project unless settings allow parallel runs; commands receive a room ID, folder, and port offset. Managed servers, resource declarations, and test-database names move to Later. The owner's accepted choices and why are recorded in detail below.

### Proposed implementation and order

The current order keeps usage observations, graceful controls, the app boundary, and safe question targeting first, then inserts the newly requested plan-review workflow as Slice 5. The guard/phone milestone is Slice 6 and Home finishes at Slice 8. The cheap builder guard and gap coordination are separate Slices 9 and 10; worktrees follow in Slices 11-17. This implements the accepted split and the owner's early plan-review request while preserving the surrounding delivery order. Deferred work stays unnumbered under Later.

Use ordinary Git linked worktrees populated from a pinned shadow snapshot without committing the owner's dirty baseline to project history. Registration and a new room branch intentionally change common Git metadata, while main files/index/HEAD and existing branch tips stay untouched. Compare the room's final tree with its captured starting tree, then preview a three-way result against current main outside main. Apply only an explicitly approved current preview, preserving staging. Record failures durably because multiple file writes cannot be atomic against power loss or external editors. Worktrees do not isolate databases, ports, or arbitrary absolute-path commands; the plan treats those as separate resources and permissions.

## 2026-10-13: Focus the Home and worktree plan on the next release

The owner decided to narrow the plan to what is needed soon and specified this order: usage observations; graceful holds and desk pause; the app-thread boundary; safe question targeting; the usage guard with phone controls; Home overview; Home answers and buttons; then the shared-folder guard and worktrees. That revision had fifteen sequential slices, each with scope, verification, and completion criteria. The later plan-review request and accepted guard split bring the current plan to seventeen slices, as recorded below. This supersedes the earlier recommendation to put the shared-folder guard first.

The owner moved the one-turn exception, usage projections and advance warnings, Swap at a safe boundary, parallel-turn caps, and recognized provider exhaustion into a final Later section, preserving their reasoning without executable slice headings. Provider exhaustion may remain in scope only if needed by the guard. The plan's assessment is that percentage thresholds and reset release do not require failed-turn classification/recovery, so that work is deferred; demonstrate and record a concrete dependency before changing that boundary. Ordinary guard hold/release notifications and mandatory app-thread serialization remain in scope.

The owner also asked to retain these follow-ups under Later:

- Restore a folder to before a turn: ask first, because this overwrites files.
- Offer to commit an approved slice only where the project's rules allow it. No commit offer belongs in the current worktree/apply slices.
- Make snapshots keep their own copies of everything they reference so project Git cleanup cannot break old snapshots. This is a **bug fix to do soon, outside this plan**, not a hidden worktree slice requirement.

Why: the near-term release should deliver measured usage, graceful controls, phone access, Home, and isolated room folders without the extra recovery, forecasting, role-changing, and commit workflows delaying it. That instruction settled one-turn deferral. The owner subsequently accepted Claude's answers on initial guard activation and worktree defaults, recorded below.

Immediate pause initially moved to Later as the author's interpretation of the narrowed sequence. Claude correctly identified that it had not yet been authorized. The owner has now explicitly accepted keeping it in Later; existing room Stop remains the emergency control.

## 2026-10-13: An answer to a reviewer's question goes back to the reviewer

The owner decided that when a reviewer asks a question mid-review (`TORYO: OWNER`), the owner's answer goes back to that reviewer. The reviewer, still read-only, then finishes its review with a verdict (APPROVED, CHANGES, or another question). This holds for the final review too. The builder sees the answer in the room as usual.

Why: the answer used to go to the builder, so the review that asked never reached a verdict. Codex recommended returning it to the reviewer, and the owner agreed.

## 2026-10-13: Accepted plan review and worktree defaults

The owner answered yes to both parts of Claude's recommendation: accept the open-question answers, including the revised planning-room behavior, and keep Pause right away in Later. The owner then explicitly instructed Codex to address every review point and record the decisions. These choices are settled, not pending questions.

| Owner decision | Why |
|---|---|
| Enable the guard on new and existing desks at 90% for both the 5-hour and weekly windows, with automatic reset release, one notice, and an off action. Preserve saved explicit settings. | Deliver the main feature immediately while respecting the owner's existing choices. |
| Default new headless Build rooms to their own worktree; keep existing rooms where they are. | Separate new work without relocating active sessions. |
| Refuse a second builder in the same folder, identify the occupying room, and offer waiting or a worktree. | A warning alone still allows the observed collisions. |
| Keep the Codex app in main for this release. | Its selected thread remains tied to its own folder. |
| Store worktrees under `~/.toryo/worktrees`. A configured TORYO_HOME supplies the equivalent worktrees subfolder. | Keep room folders out of watched project trees; the chosen location also suits the owner's Linux project storage. Do not promise package hard links across arbitrary filesystems. |
| Run setup/checks serially per project unless project settings explicitly allow parallel runs. Supply room ID, folder, and port offset. | Keep the immediate behavior small and predictable; an offset is not a guaranteed free port. |
| Defer managed dev servers, resource declarations, and test-database names. | These were beyond the immediate checks question and should not delay worktrees. |
| Planning rooms write into main during a gap with no running turn, check, or review, then notify the build room of changed files. | A Codex-app build can last days; a shared plan should wait for a safe gap, not for that whole build to end. |
| Keep Pause right away in Later. | Graceful controls ship first, with room Stop available for emergencies. |

Review implementation choices, distinct from the owner's product decisions: split the cheap one-builder guard from gap/read/write coordination; pass the actual room workspace into src/protocol.mjs's Repository briefing and forbid main-folder edits; add Claude main-folder edit-deny rules for write turns; stage the starting snapshot only in the worktree's own index so plain git diff starts clean without a commit; and test an ordinary failed turn whose reported 92% usage holds its automatic retry until reset. That retry test uses the threshold guard and does not pull deferred provider-exhaustion recovery into scope.

## 2026-10-13: Plan checks and discussion handoffs

The owner requested a small early slice to improve ready-plan review. Beside Start building, Read, and Ask for changes, offer Ask Claude (or the other non-author planners) to check the plan. The check is read-only; findings go to the author automatically, the author revises, and the plan returns to Ready.

After an owner-requested change, the other planners re-check the revised plan once automatically. Make this a room setting, on by default. If the owner discusses a Ready plan with a non-author, offer one click to send that discussion to the author as a change request. Fix recommendation acceptance so the stray wrapper characters in “Go with your recommendation: yes to both)?” do not become part of the answer.

Why: the owner had to ask for a revised plan to be checked manually and relay a chat discussion back to the author. A requested change should get its review without another manual handoff. The required regression scenario is owner asks for changes → author revises → other planner checks → author addresses findings → Ready again.

Implementation choices: put this in Slice 5 after safe question targeting; reuse the existing plan-check/revise flow; bind actions to the plan revision; and give each owner change request one check round with one author response, not an unbounded review loop. Forward selected original messages with their authors and IDs after the owner's click. Preserve the distinction between owner decisions and planner suggestions. None of this changes the read-only review rule or automatically starts a build.

## 2026-10-13: Cursor's read-only turns use the read-only mount, not Ask mode

The owner decided that Cursor's read-only turns no longer pass `--mode ask`. Read-only is enforced by Toryo's read-only mount of the project, and `--mode ask` is only the fallback where the mount isn't available. Write turns keep `--force`. Cursor's turns now report their token usage, and the adapter is marked tested.

Why: the owner tested this against the real Cursor CLI (2026.10.01). Cursor keeps a resumed chat's mode, and `--mode` accepts only plan or ask. After one Ask turn, the chat could never edit again: the next write turn replied "Ask mode is on". Under the mount, a write attempt failed with EROFS, so read-only still holds.

## 2026-10-13: Empty turns are errors; fresh sessions and the reviewer's ledger; editable notes

The owner decided, after two review prompts in a long-running project room were dropped by a Claude Code plugin's hook:

| Decision | Why |
|---|---|
| A turn that returns no text, or whose prompt a hook dropped ("Prompt dropped by a hook: …"), is an error with Retry. It never counts as a reviewer's verdict. A hook drop names the hook and goes to the owner at once. | Toryo had read the empty review as "changes requested" and sent the builder an empty review. |
| *Start <agent> fresh in this room* forgets that agent's session in the room. Its next turn starts a new session with the briefing, the plan and the latest handoff. | A long-running reviewer session had grown to 344k tokens, which is expensive whenever the cache goes cold. |
| A room setting, *Fresh reviewer for each new slice*, **on by default** (the owner first said off, then changed it to on). The final review of a plan always uses a fresh reviewer. | Better for long-running rooms: smaller sessions, and each slice reviewed more independently. |
| A fresh reviewer gets a ledger of open findings from earlier slices and the owner's decisions about them. Toryo keeps the ledger from the reviews' findings and how each was resolved. | A fresh reviewer mustn't lose what earlier reviews left open, or what the owner decided. |
| A note can be edited or cancelled while it's still queued, never after it has been sent. | Correct or withdraw a note before an agent acts on it. |
| In the chat box, Enter sends and Shift+Enter starts a new line. | The owner's preference. |

How the ledger is kept is a crew implementation choice. A review asking for changes adds an open finding, closed when that slice is approved. A reviewer that approves while leaving something for later writes it on a line starting `Open:`, and a later review closes it with `Resolved: L<n>`. The owner's answers to a build's questions are its decisions.

## 2026-10-13: Notes don't turn building into answering (Ask or Tell)

The owner decided this, superseding part of "Notes get answers" above. A note mid-turn no longer gets its own "To you:" reply turn.

- **Instructions to the builder while it works.** They go into its next turn as a build turn, *Building: your notes*, not *Answer to your note*. Then the relay carries on as it would have: checks, then review.
- **Acknowledgements.** That turn's message opens with one line per note: done now, scheduled (for which slice) or declined (and why). Each note shows that outcome.
- **Questions.** Only a note that asks something (a question, "what do you think?", a choice) needs an answer.
  - The builder answers it in the same build turn.
  - A reviewer, or an agent in a room that isn't building, answers in a short read-only turn, *Answering your question*. Then the room goes back to exactly what it was doing.
- **Ask or Tell.** The owner marks each note Ask or Tell. By default the text decides: a question mark or a question means Ask.

Why: notes were turning building into answering. A separate reply turn for every note delayed the work, and a reply could even change the relay's course. The owner wants instructions acted on as part of the work, every note's outcome visible, and only questions answered.

The crew's implementation choices:
- Notes are numbered N1, N2… in the building turn's prompt, and the agent writes "N1: done — …".
- An instruction (Tell) to a reviewer adds no turn: it goes with the reviewer's next turn.
- A question to an agent that isn't working and isn't the builder is answered at once, beside the work.
- The answer turn's own status line is ignored, so answering never changes a verdict.
- The CLI takes `--ask` or `--tell`, and MCP's `toryo_say` takes `intent`.

## 2026-10-13: The approved prototype is Toryo's look, built in a new Slice 4

The owner decided:
- **The look.** On 13 Oct the owner approved a clickable prototype as the look for Toryo: Home, rooms, and the design system it shows. Slice 4 copies it into the repository as `design/prototype/toryo-desk.html`; its sample data is made up and stays that way. Its Home shows how the Home slices will look; what Home shows and does still follows the plan.
- **A new slice.** *Slice 4: Design system and re-skin* goes right after Slice 3, to be built as soon as Slice 3 is approved. The later slices move up by one (4–17 become 5–18), so slice numbers in the entries above are one lower than in the plan now.
- **Color means activity, never identity.** Activity colors come from the logo: purple plans, blue builds, mint reviews. Orange is only for "needs you", amber for usage limits getting close, and the neutrals come from the wordmark's navy and the tagline's slate. Per-agent colors go: agents get neutral monograms.
- **Nothing from the internet.** The fonts (Lexend, Figtree, JetBrains Mono) are bundled with the page with their licences.
- **Review size.** If the slice is too big for one review, it's reviewed in two parts: (a) tokens, type, components, layout and docs; (b) the activity rings, the sparkler and the live logo.

Why: it's the design the owner chose for Toryo.

The order: when the plan changed, safe question targeting (now Slice 5) was already built and in its last review round, so it finishes that review first. The owner confirmed it: once Slice 5 is approved, Slice 4 is built next, then Slice 6 onwards.

## 2026-10-13: A timeline of each session's phases, and new sessions in a room

The owner asked for:
- **A session timeline** in the sticky bar at the top of the room, showing how long each phase of the current session took: build, review, test (the project's checks) and plan.
- **New sessions.** A room is usually one session, but the owner wants to be able to reset a room or restart its session, for example to plan the next sprint of work.

Why: to see at a glance where a session's time went, and to start new work in a room that already has a history.

The owner left it to the builder to work this into the plan "wherever and however it makes sense". So these are proposals in the plan, open to the owner's review, not owner decisions:
- **Where in the plan.** Two new slices right after Home: *Slice 10: Session phase timeline at the top of the room* and *Slice 11: Start a new session in a room*. The later slices move up by two (10–18 become 12–20).
- **Where on the page.** The strip sits in the room's sticky header, since a session belongs to one room.
- **What a reset is.** It starts a new session and deletes nothing. Earlier sessions stay in the room, folded. Agents start fresh by default, and the ledger stays.

## 2026-10-14: Following a Codex app turn that ended with an error, and a fuller session timeline

The owner added two pieces of work to the [Home and controls plan](plans/plan-a-home-view-for-foreman-and-desk-wi.md), to come after Slice 16 (copied files and setup), the fix first. They are the owner's decisions.

**1. A Codex app turn that ended with an error (a bug fix).** On 14 October a turn Toryo handed to the Codex app ended with a `task_complete` whose `last_agent_message` was null and whose `error` said *Selected model is at capacity* (`codex_error_info: server_overloaded`). Hours later the app picked the work up again as a new turn in the same thread, with no new user message, and finished it with a proper handoff. Toryo reported the first ending as an empty message, and *Follow it again* failed every time, because it always reached the failed ending first and never the resumed turn's reply. The room was blocked until the owner let the turn go and restarted the build.

| Decision | Why |
|---|---|
| A `task_complete` that carries an `error` is reported as that error (its message and `codex_error_info`), never as an empty message. | The owner should see what the app said went wrong. |
| Following again goes past a failed ending. A turn the app starts in the same thread with no new user message in between is the same work resumed: Toryo follows it and takes its reply as the turn's result. | That's how the app resumes work after an error. |
| If a new user message without Toryo's marker comes first, the thread has moved on to someone else's message: Toryo says so plainly, and doesn't take that reply. | A reply to someone else isn't the room's result. |
| If nothing has followed the error yet, Toryo keeps waiting (the app may be resumed later) and says so in the activity. | Following again shouldn't fail just because the app hasn't been resumed yet. |
| The "lost track" question names the app's error, and says that resuming the turn in the app and then choosing *Follow it again* picks up the resumed turn. | The owner needs to know how to get the room going again. |
| This is a capacity error, not a usage limit: it stays separate from the deferred *Recognized provider exhaustion* work. | Different causes, different handling. |

**2. The session timeline (the strip at the top of the room).**

| Decision | Why |
|---|---|
| Opening an earlier session in the transcript shows that session's timeline on the strip. Folding it again, or *Back to session N*, returns the strip to the current session. | Today an earlier session reaches the strip only through the list behind the totals. |
| The strip uses the whole width of the middle column; the totals in words go on their own line. | More room for the timeline. |
| A real time ruler as its x-axis: clock times (dates when the session crosses days), finer as you zoom in. A compressed break shows on the ruler as a break with its length, so the ruler never suggests time is to scale where it isn't. | To read when things happened, honestly. |
| Zoom and pan: the scroll wheel over the strip zooms around the pointer, dragging pans, a double-click or *Fit* goes back to the whole session. Clicking a segment still goes to its turn, and a drag never counts as a click. Keyboard equivalents for zoom and pan; the list stays for screen readers. The strip stays compact in the sticky header, and phones keep their single bar. | Long sessions need a closer look without losing the whole. |

## 2026-10-14: The Codex app thread's real folder, and every Claude result kept

Later that day the owner added two more bugs to the same fix slice (Slice 17), still after Slice 16. The first comes first in the slice, since it blocks a room completely. These are the owner's decisions.

**A. The Codex app's folder check (Slice 15's) can't pass for how the owner's app threads work.** The app records every thread's folder with Windows' long-path prefix (`\\?\C:\Users\you\project`), which Toryo didn't understand, so every app turn was refused before anything was sent. And the owner's threads are opened in a Windows folder of scratch files while they do their real work in the WSL project, running their commands through `wsl`: the recorded folder is never the room's.

| Decision | Why |
|---|---|
| `\\?\C:\…` is understood like `C:\…`. | It's how the app records every thread's folder. |
| The owner can say once, for a thread, which folder it really works in, from the room's Codex app thread setting (and through the API, the command line and MCP). The check then compares that folder, not the app's recorded one. It's set only by the owner, never guessed from the log. | The recorded folder isn't where these threads work, and only the owner knows where they do. |
| Rooms with their own worktree still refuse the app. | The app can't work in a room's worktree. |
| A refusal says what the app recorded, what the room expects, and how to tell Toryo where the thread works. | So the owner can unblock the room. |

**B. A Claude run with more than one result keeps only the last.** Claude finished a long review; a background command it had left running was stopped about 7 minutes later, and the stop notice woke Claude for a one-line follow-up in the same run. Toryo kept only that line as the turn's message, so the review was lost from the room, the builder would have got only the line, and the ledger never saw the review's `Resolved:` and `Open:` lines.

| Decision | Why |
|---|---|
| Every result's text is kept, in order: the main answer first, any follow-up after it, marked as a follow-up. The status comes from the last status line, and the ledger reads the whole text. | Nothing the agent answered is lost. |
| Check how the totals add up across results: in the sample, `total_cost_usd` looks cumulative but `usage` doesn't. | So the run's cost and tokens are right, counted once. |
| Optional: the briefing could ask agents to stop their own background commands before their final answer. | Waiting for one cost 7 minutes here. |

## 2026-10-14: A Fast switch for each agent

The owner added a slice to the [Home and controls plan](plans/plan-a-home-view-for-foreman-and-desk-wi.md), as its own slice after the fix slice (Slice 17). Slice 18 was already built and in review when it came, so it's Slice 19, before the remaining worktree slices. Several agents have a fast mode: quicker answers in exchange for more of the owner's allowance. These are the owner's decisions.

| Decision | Why |
|---|---|
| A *Fast* switch for each agent in a room's crew settings, with a desk-wide default. | The owner chooses where speed is worth the extra usage. |
| It shows only where the agent and the model chosen for it support a fast mode, and it's off unless the owner turns it on. | Fast costs more of the allowance, so it's never on by surprise. |
| Each turn records whether it actually ran fast. If the owner asked for fast and the agent says it's off or paused, the room says why, rather than quietly running at standard speed. | Asking for fast doesn't guarantee it. |
| Whether a turn ran fast shows with the turn's usage. | So the owner can see what fast costs. |

**What the owner found by hand on 14 Oct (outside any room), for the slice to build on:**

- **Claude.** A headless `claude -p` run ignores the fast mode saved in the interactive settings: its `system/init` event says `"fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"`. With `--settings '{"fastMode":true}'` it says `"fast_mode_state":"on"`, with no reason. The states are `off`, `cooldown` (paused after a rate limit) and `on`. The reasons include `extra_usage_disabled`, `model_not_allowed` and `not_first_party`.
- **Codex (headless).** `service_tier` is a config key: `codex exec -c service_tier="fast"`. Codex's model list (`models_cache.json`) gives each model `"additional_speed_tiers":["fast"]` and `"service_tiers":[{"id":"priority","name":"Fast","description":"2x speed, increased usage"}]` (some models say 1.5x). `exec` accepted both `"fast"` and `"priority"`, but the session log doesn't record the tier, so it's not confirmed that a turn ran fast. The owner asked to check which value is right, and to read each model's tiers from that list rather than hard-code them.
- **The Codex app.** It keeps the speed per thread (its log's `thread_settings_applied` event has `service_tier`), and Toryo can't set it through `codex queue`. Toryo shows the thread's current speed, read from the log, and says it's changed in the app.
- **Cursor.** Fast versions are separate models in `agent models` (names ending in `-fast`). The owner left the choice open: the switch can pick the model's fast version when there is one, or just say that fast versions are in the model list.
- **Grok.** Not checked yet: the slice finds out whether its CLI has a fast mode or fast models.
