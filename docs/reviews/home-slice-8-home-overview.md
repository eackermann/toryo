# Home and desk controls, Slice 8: Home overview and recent activity

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 8, with *Home and remote controls* (what Home shows, in what order, and how it's served). The look follows the approved prototype's Home (`design/prototype/toryo-desk.html`), without its buttons: those are Slice 9.
**Tree:** uncommitted on top of Slice 7 (`73a1a4f`).
- **New:** `test/home.test.mjs` and this handoff.
- **Changed:** `src/engine.mjs`, `src/server.mjs`, `src/agents/codexapp.mjs` (round 3), `test/codexapp.test.mjs` (round 3), `web/app.js`, `web/index.html`, `web/styles.css`, `web/meters.js`, `test/fake-agent.mjs`, `test/ui-check.mjs`, `test/ui-shots.mjs`, `README.md`, `docs/design-system.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- **The page opens on Home** (`#/`) instead of the first room. Links to rooms (`#/r/<id>`) open the room as before.
- **Getting back:** the Toryo name and the rail's *Home* lead back to Home, and Back and Forward move between Home and rooms. A phone's tab bar has Home, Rooms and the room.
- **Recent** starts with what the rooms already hold. The desk's journal (`desk-events.jsonl`, from Slice 7) adds its own events.

## Round 3: your finding

| Finding | Fix | Test |
|---|---|---|
| P2: A Codex app turn the app took up while Toryo was stopped got the restart's time as its pickup (Home said hours queued and no time working), and kept it. | **The app's log says when** (`src/agents/codexapp.mjs`): the line carrying the turn's marker has its own timestamp, and the adapter passes it to `onStarted` (`at`). **The desk takes it** (`onStarted` in `src/engine.mjs`): working since that time, if it's a real time and not ahead of now; otherwise now, as before. It's kept as `pickedUpAt` on the new turn and on the first one (round 2's change), so another restart still knows. | **Adapter:** the restart test's marker line now has a timestamp (10:30), and the adapter reports `{ sessionId, at: "…10:30:00.000Z" }`. **Desk:** a new test with the stand-in app hands the turn over, and Toryo stops. The app takes it up while Toryo is down. Toryo starts again, and the app's log gives that time: Home's card is working since the pickup, still handed over at the first time. After one more restart (with the log no longer saying), it's still working since the pickup, and the first turn has it as `pickedUpAt`. Each test fails with its half of the fix taken out. |

- **Files:** this round also changes `src/agents/codexapp.mjs` and `test/codexapp.test.mjs`.
- `npm test`: 201 tests, all passing.
- The browser check passes.

## Round 2: your five findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P2: With Home showing, the room behind it took in new events and marked them read (the hidden layout passed the scroll check), so going back lost *While you were away*. | **Read means on the screen.** `markSeenSoon`'s timer marks nothing unless the room is the page shown, also when a timer set earlier fires later. With Home showing, the hidden room no longer takes in events at all: no timeline drawn, no activity lines. Going back to it fetches it afresh. | Browser step 5s: in a room long enough to have read it, then Home, while Codex replies twice in that room. Back in the room: *While you were away: 2 turns*. With the old marking, the check fails (see below). |
| 2 | P2: Adding the first project left the welcome page up: onboarding had set the page, so nothing routed to Home. | **The welcome page is remembered** (`S.welcome`). Once there's a project, the next state routes, to Home or to the room the address names. | Browser step 5s starts a second desk of its own, with no project. Its welcome page adds the first project, and Home opens (*All quiet*) without a reload. Without the fix, the check fails. |
| 3 | P2: A working card named the slice just approved (during `build-next`) and undercounted rounds. | **The slice and round as the room shows them** (`#currentSlice`). The slice named, unless it's approved; then the plan's first slice not approved, read from the plan file, which happens only while a build moves to its next slice. Without a plan, *the next slice*; with nothing known, no slice, and the card says the task. The round is the one going on: `build.round` counts the change requests before it, so it's `build.round + 1`, as the timeline shows. | New engine test, with a plan of two slices. The reviewer asks for changes once; during the second review, the card says *Slice 1: One*, round 2. Once approved, the builder's card says *Slice 2: Two*, round 1. With the stored slice, or the stored count, it fails. |
| 4 | P2: A Codex app turn followed again after a restart lost its times: working from the reconnect, and no time handed over (attached turns skip `onSubmitted`). | **The first turn's times are kept** (`#appOrigin`): the turn the app was first given, found by its marker. A turn followed again copies its `submittedAt` and `pickedUpAt` (falling back to `attach.since`, when the app was given it). If the app had taken it up, it's working since then. A pickup seen while the turn is being followed again is also written on the first turn, so a later restart still knows. | New engine test, with a stand-in app across two restarts. Handed over and still in the queue: after the restart, *in-app* since it was handed over, not working. Then the app takes it up; after another restart, working since that pickup, still handed over at the first time. Without the fix, it fails. |
| 5 | P2: Reconnecting while Home showed downloaded the hidden room. | **Reconnecting fetches the room only if it's the page shown;** a refresh timer set earlier checks again when it fires. Home fetches its summary as before. | Browser step 5s: with Home showing (and a room opened earlier), the desk stops and starts again. Between the reconnect and a second after it, the page fetches `/api/home` and no room. Without the fix, the check fails. |

- `npm test`: 200 tests, all passing; `test/home.test.mjs` now has 7.
- The browser check passes, with steps 0 to 6 including the new ones.
- The screenshot script passes.

## What changed

### The desk: one bounded summary, and Recent page by page (`src/engine.mjs`, `src/server.mjs`)

**`GET /api/home` (`engine.home({ recent })`)** is everything Home shows, built from what the desk keeps in memory. It never reads a transcript.
- **`questions`:** every open question in every room, oldest first, with its room (at most 50; `questionCount` says how many in all).
- **`working`:** each turn or checks run going on now. It gives:
  - **where:** the room, its project and folder, and the rooms sharing that folder;
  - **who and what:** the agent and its role, the kind of work, the slice and round (or the task, or the planning topic), and the room's open questions;
  - **its times, apart:** `startedAt` (when it began preparing), `submittedAt` (handed to the Codex app), `workingAt` (the agent started), `lastOutputAt`, and the latest activity line.

  `run.workingAt`, `run.submittedAt` and `run.role` are new on each run. A checks run is working from its start.
- **`rooms`:** the rooms not working: their status, paused, held (with the reasons from the room's own `blocked`), done, questions, last change, project, folder, and the rooms sharing it.
- **`usage`:** the usage per allowance (`UsageBook.groupView`).
- **`agents`:** one row per agent: its allowance, where it's working, and what holds it (`blockersFor`). Headless Codex and the Codex app share an allowance and each has a row. Which agents: the ones found on this machine, or before detection the configured ones, plus any at work.
- **`desk`:** `deskView()`, with the guard.
- **`recent`:** Recent's first `recent` items (40 by default, at most 100).

**`GET /api/feed?limit=&before=` (`engine.feed`)** is Recent, newest first.
- **What's in it:** each room's notable events, merged with the desk's journal (your pauses and holds, now journaled too, and the guard's changes from Slice 7).
- **Notable:** a finished or failed turn, a question, your answer or change request, failed checks, a slice's approval, the plan's completion.
- **Said once:** a turn that asked you something appears as its question. A failed turn's retry question appears as the failure.
- **Order:** by when each happened; for a turn, when it ended. In the same millisecond the order is fixed: the turn, then its checks, the approval, the question, your answer.
- **Ids and cursors:** each item has a stable id (`<room>:<event>`, or `desk:<journal id>`). The cursor is `time|rank|id`, compared as plain strings everywhere: the sort and the cursor use the same order, and it doesn't change across a restart.
- **Kept up to date without rescanning.** Each room's notable events are kept in an index (`#noteNotable`). It's filled once when Toryo starts, then kept up to date by `#append` and `#patch`. A turn patched from running to done joins it once, and holds a reference to the event, so it shows the event as it is now: an event patched again is still one item. Each room keeps its last 300, and the journal its last 300 lines.

### The page (`web/app.js`, `web/index.html`, `web/styles.css`)

**Navigation.**
- **The address decides** (`route`): `#/` (or nothing) is Home, and `#/r/<id>` a room.
- **History:** opening a room from the rail, Home, a new room or the top bar's count adds a step to the browser's history, so Back returns to where you were.
- **Fetching a room again** (a reconnect, a saved setting) never takes you away from Home. A room deleted, or no longer there, goes to Home.
- **Phones:** the tab bar has three tabs.

**Home** (`renderHome`) follows the prototype:
- **A sentence:** how many rooms are working and how many questions need you. Beside it, what holds work up desk-wide, in words: Toryo's problems, Pause everything, your holds, the guard's holds or its paused windows. While it's new, the guard's note.
- **Needs you:** oldest first: the room's tile with its ring, who asks, how long it has waited (live), the question, the recommendation, and *Open the room at this question*. That link opens the room scrolled to the question.
- **Working now:** a card per turn:
  - **What:** the room, its project and folder, a chip for the kind of work, the agent and its role, and what (*building Slice 1: Schema, round 2*).
  - **Its times:** *preparing for 0:03*, or *prepared in 6s*; *in the Codex app's queue for 2:10*, or *waited 2 min in the Codex app's queue*. The working time is the large number. Then the last output's age, and the latest line, which arrives live without a fetch.
  - **Sharing:** the rooms sharing its folder: one or two by name, more as a count, with the names on hover.
- **Other rooms:** each room's line from the rail (*Held: you hold Claude*, *Paused*, *Done*…), its project, its shared folder, and when it last changed.
- **Agents and usage:** per allowance:
  - **The guard:** its rules, and its holds in red (or *paused until it resets*).
  - **A meter per window:** the percentage, a line across the bar at the guard's threshold, the exact reset date and time in your time zone with the time left, and how old the reading is and from which agent.
  - **Each agent:** what it's doing (*building in A, B and C*), or *idle*, and what holds it.
- **Recent:** an icon, the event in words (*Claude asked for changes*, *You answered “Keep going?”: Yes.*, *Checks failed: Unit tests*, *You held Claude*), a link to its room, and how long ago. *Show older* asks for more (up to 100), so nothing falls in a gap between pages.
- **No rooms yet:** Home offers the three ways to start one (what used to be the empty room page).

**Fetching, and keeping up.**
- **One summary at a time:** Home fetches the summary (`loadHome`) when it opens, on news (`room`, `event` and `state` events), and when the connection comes back. Only one fetch is ever on its way, and news meanwhile asks for one more after it.
- **Bursts:** news in a burst waits for a quarter of a second of quiet, and never more than a second, so a burst costs a few fetches, not one per event or per room.
- **The hidden room:** the room you were in isn't fetched again while Home shows; going back to it fetches it fresh.
- **Live, without a fetch:** the latest activity lines, and the running timers (`data-since`, and the new `data-ago` for times ago).
- **Every 30 seconds:** the usage panel is drawn again, so a limit that resets while the page sits idle shows as reset (as the room's meters already did).
- **Drawn again with news:** the scroll stays. So does the keyboard focus: a link or button you'd reached is focused again after the redraw.
- **Cut off:** a red note at the top: *Reconnecting to the desk… What you see here may be out of date.* It goes when the connection is back, and Home fetches afresh.
- **Everything is escaped** (`esc`): titles, questions, activity lines and folders.

**Styles:** the prototype's Home, scoped under `.home`. The room's activity list already uses `.feed`, so Recent's list is `.recent`, and Home's empty states are `.hempty`. Under 1180 px it's one column. On a phone, cards wrap, and the question links fill the card's width at 44 px tall. `limitMeters` (`web/meters.js`) can now draw a box without an agent, so the per-agent redraw leaves Home's alone.

### The fake agent

A rule's `progress` reports one activity line (a command) as the turn starts, before `workMs`, so a turn at work has its latest output.

## How to check

- **`npm test`:** 201 tests, all passing. `test/home.test.mjs` is new (8 tests; two from round 2 and one from round 3, above):
  - **Several rooms at work:** a build and a chat, both working. Each says:
    - where it is: the room, project and folder, and that they share it;
    - who and what: the agent, role, kind and task;
    - its times, in order: started, working, last output, with the latest activity line;
    - the agent row for each.
  - **Questions from every room, and what keeps the rest:** two rooms' questions, oldest first, with titles, askers and ids. A paused room and a held room, with the held one's reasons. The Codex row's holds and allowance.
  - **Recent, merged and paged:**
    - **Order:** a slow turn that started first and ended last, a quick turn that asked something (said once, as its question), and your hold, merged newest first.
    - **Said once:** each item once, the slow turn's patches as one item, your answer once with the question it answered.
    - **Paging:** pages of 2 then the rest add up to the whole list with nothing twice. A new item arriving between pages doesn't shift a page already seen, and your release appears at the top.
  - **What Recent keeps:** a failed checks run, with the check's name. Not your plain notes, nor running turns.
  - **Over HTTP:** `/api/home` has everything Home needs, the hostile title as it is (the page escapes it), and the guard. `/api/feed` pages by cursor without repeating.
- **The browser check passes,** with a new step 5s:
  - **The address:** the Toryo name opens Home (`#/`, the room hidden, the rail's Home current).
  - **A hostile title:** a room called `<img src=x onerror="window.__xss=1">` shows as text: no image, no script run.
  - **Questions:** Home's cards are in the desk's order. *Open the room at this question* opens the room with that question in view; Back returns Home.
  - **The keyboard:** the link has the focus, keeps it while Home is drawn again with news, and Enter opens it.
  - **A turn's times:** a turn that takes a while to start shows *preparing for 0:0x*, then its latest output live, then *prepared in Ns* and *working · last output Ns ago*.
  - **A burst of news:** eight notes in a row cost between one and six fetches of the summary, and no room fetched whole.
  - **Cut off:** this check's own desk is stopped, and Home shows *Reconnecting to the desk…*. The desk is started again: the note goes, and Home fetches afresh (the rooms whose turns were cut off show as paused).

  Step 0, which checked the usage meters on the first page, now checks Home's: each window's reading age, and a limit that resets while the page sits idle shows as reset. All the other steps pass unchanged.
- **The screenshot script passes** with Home added:
  - **Pictures:** 1440 and 1024 in light and dark, 390 in both, 320, and with reduced motion. Each Home shot also gets a `-full` picture of the whole page.
  - **Checked:** every text's contrast, and nothing scrolling sideways (Home's own scroll area included).
  - **The rings check** now reads only the rooms' links (the rail's Home item has no ring).
- **Mutations** (in a copy of the tree):
  - Recent not updated when a turn ends, a turn that asked said twice, and the cursor ignored: each fails `test/home.test.mjs`.
  - **The page:** with the escaping of a room's title on Home taken out, the browser check fails: an `<img>` appears on Home. With the hidden room fetched again on news, it fails *no room fetched whole*.
  - **Round 2, the page:** each change taken out fails the browser check at its own check:
    - the hidden room marked read: *While you were away* never shows;
    - no routing after the first project: Home never opens;
    - the hidden room fetched on reconnect: *no room fetched behind Home*.
  - **Round 2, the desk:** the stored slice, the stored round count, and the app's times taken from the reconnect each fail their new engine test.

## Worth a look

- **Home is the first page now,** as the plan says. Bookmarks to rooms still open rooms.
- **Home is drawn whole** when news comes, keeping scroll and focus. Slice 9 adds inputs (answers), and those must be patched in place rather than redrawn. I'd do that there, where the inputs are.
- **The page doesn't show** the guard's or the desk's controls as buttons yet, nor answer questions in place: Slice 9.
- **`toryo status`** isn't changed here. It already lists the rooms, their questions with ids, and the desk's holds and guard.
