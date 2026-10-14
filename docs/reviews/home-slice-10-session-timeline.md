# Home and desk controls, Slice 10: Session phase timeline at the top of the room

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 10 (the owner's note N1: a timeline of the session's phases in the room's sticky header).
**Tree:** uncommitted on top of Slice 9 (`1782447`).
- **New:** `web/phases.js`, `test/phases.test.mjs`, `test/session.test.mjs`, this handoff.
- **Changed:** `src/engine.mjs`, `src/client.mjs`, `web/app.js`, `web/index.html`, `web/rings.js`, `web/styles.css`, `test/ui-check.mjs`, `README.md`, `docs/design-system.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart, every room shows its session strip under its header, built from its whole history, and `toryo show`, `toryo status` and `toryo_room` say the session's totals. Rooms from before the restart show what their events can tell (see *Older rooms* below). No settings or stored files change shape. The only new things written are a `startedAt` and `runId` on each checks result, a `closedAt` on each question when it closes, and `mark` events.

## After approval: checks cut off by a restart (your P3)

When the desk shuts down during a room's checks, `shutdown()` now records the time they ran as a `checks` mark (`why: "restart"`, shown as *cut off when Toryo stopped (run again after)*). The room still keeps the run, so the checks run again after the restart as before. Test: the cut-checks desk test now also shuts the desk down 0.6 s into a room's checks. After the restart there's a `restart` mark with the time they ran, the checks run again, and the checks total counts it. With the line taken out, it fails. `npm test`: 221 tests, all passing.

## Round 3: a handoff brought in while paused

**Finding (P2):** the calculation took an imported handoff for work the room had sent. A build started with *review first* (`reviewFirst`) while the room was paused adds an `imported: true` turn. That ended the paused time there, though the room stayed paused and its review waited.

**Fix (`web/phases.js`):** an imported turn is neither work done here nor something the room sent. Its start and end are the moment it was brought in, so it never ends a pause and isn't drawn on the strip. It's left out like a turn held before it was sent. The only other turns the desk writes are the ones it sends.

**Tests:**
- **Unit:** paused at 5, the handoff brought in at 10. At 15: 10 minutes paused, still paused, nothing in the building lane. Resumed at 20: 15 minutes at 25, no longer paused.
- **Desk:** your sequence. A room is paused, then a build starts from a handoff: the handoff is in, the only mark is *paused*, the room is still paused, and its review waits. With the desk's clock 10 minutes on, the summary and a `Timeline` rebuilt from the events (as the page does) both say 10 minutes paused. After a restart, from the saved events, the same, with no new mark. *Resume* writes *resumed*. Five minutes later, both say the pause lasted from the pause to the resume, and the review goes to Claude.
- **Mutation:** with the fix taken out, both fail.

`npm test`: 221 tests, all passing. The browser check passes, steps 0 to 6.

## Round 2: your five findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: A refresh drew the whole strip for every event it replayed. | **A refresh takes in only the events that changed** (compared with what the page last drew), adds each to the timeline without drawing, and **draws the strip once**, with the header, at the end. Live events still draw it as they come. | Browser check, new step 5w. A desk of its own with a room of 3,000 events (1,500 turns) written into its folder. The room is renamed, so the page fetches it again. No task on the page may take a second; the totals are the same after. Measured: no long task near the limit. With the old loop put back, it fails (see *Mutations*). |
| 2 | P2: A refresh neither updated running entries nor removed finished checks; checks whose first news was their output had no kind or start. | **A refresh reconciles what runs with the desk's list:** it takes the desk's kind, phase and start for each run, keeps the output the page already has, and drops what the desk no longer lists, except anything that started while the fetch was on its way. **A checks run's first news** (its output) is taken as checks (`agent: "toryo"`) from the time its output says, and asks for a refresh to get the rest. **Each checks result carries the id it ran under** (`runId`): the page drops that run as soon as its result arrives, and the calculation never counts a run twice, even if a list of what runs still names it. | Unit: a result and the same run still listed count once. Browser check, new step 5v. Checks (`sleep 4`) watched as they start show a running piece (*The checks: hh:mm–now*). A second page opened while they run shows it too. Once done, each page has exactly one piece in the checks lane, ended. |
| 3 | P2: Checks that were stopped, superseded or crashed lost their time. | **Recorded as a `checks` mark** (`runId`, `startedAt`, `why`: stopped, superseded or crashed), not as a checks result, so nothing acts on it: no review, no fix turn, no failed-checks news. The calculation counts its time in the checks lane. On the strip it says *stopped before the end* (or *cut short when the room moved on*, *crashed*) and isn't a link (there's nothing in the room to go to). A run is recorded once, result or mark. | Desk test. A room stopped 0.8 s into its checks: a mark with `why: "stopped"`, the checks total equal to the time it ran, and no checks result. A room given a new build while its checks run: a `superseded` mark once they end, its full time counted. After a restart, both rooms' checks totals are unchanged, from the saved events. Unit: a cut run counts and says why. |
| 4 | P2: A message, a new build or a new plan cleared a stop without a resume mark. | **`#markPause` writes a mark whenever the room's actual state changes**: from working to paused or stopped, or back. It's called wherever pause or stop change: Pause, Stop, Resume, a message to a stopped room, a new build, a new plan, and a restart that interrupted turns (which pauses the room). A new build clears a stop but not a pause: the room stays paused, and no mark is written. *Resumed by your message.* is now read in older rooms. And since nothing starts in a paused room, **work sent after a pause ends it** (rooms from before marks had no sentence when a new build cleared a stop). A turn already running when the pause came, or one following a Codex app turn after a restart, doesn't end it. | Desk test. Stop, then a message: *stopped*, *resumed*. Pause, Stop, then a new build: one *paused*, the room still paused. Resume, Stop, then a new plan: *resumed*, *stopped*, *resumed*, and the paused total stops growing. Another: a restart that cut a turn off pauses the room, with a *paused* mark. Unit: the older sentence, a stop a later turn shows had ended, a turn already running, a followed app turn. |
| 5 | P2: A Codex app turn counted its queue time until pickup, then its total shrank. | **A Codex app turn counts only from `pickedUpAt`.** Before the app takes it up, it counts nothing; a turn it never took up counts nothing. So totals only grow. | Unit: queued 0 min, then picked up at 6 and seen at 8: 2 min, then done at 10: 4 min, never less. A turn that ended without pickup: nothing. |

- `npm test`: 220 tests, all passing.
- The browser check passes, steps 0 to 6, with 5v and 5w.
- **Each fix taken out fails its test** (in copies of the tree):
  - **1** (the strip drawn per replayed event, every event taken in): step 5w, the page held for seconds;
  - **2** (the old refresh, output-first runs with no kind, results not ending their run, and the calculation not checking `runId`): step 5v, a finished run still drawn as running. With the calculation's check left in, the page passes: the two layers each stop the double count;
  - **3** (no mark for cut checks): the desk test of cut checks;
  - **4** (no mark on a message or a new plan): the desk test of resumes;
  - **5** (the app's turn from `startedAt` before pickup): the unit test of the Codex app.
- **Two older tests now wait for their last turn before tearing down.** A turn still being prepared when a test deleted its folder logged a harmless crash. `test/home.test.mjs` sometimes logs the same kind of line; it does so on `1782447` too, so I've left it.
- The screenshot script passes again (the strip's pieces that aren't links are now `<i>`).

**Not covered in this round:** checks cut off by the desk itself shutting down (done after approval, above).

## What changed

### One calculation, used by the page and the desk (`web/phases.js`)

A `Timeline` takes a room's events one at a time and keeps, by event id, each piece of work (turns and checks runs), each question, each answer, and each pause, resume, stop and desk hold. An event that changes again (a turn that ends, a question that closes) replaces what it said, so nothing is ever rescanned. `view({ now, live, end })` gives:

- **Segments:** each turn or checks run, in its lane: `plan`, `build`, `review` (plan checks too), `checks`, `other` (replies, discussions, second opinions). `workKind` moved here from `web/rings.js`, which now re-exports it, so the rings and the strip can't disagree about what a kind of work is.
- **Totals per phase:** the time at least one of that phase's pieces ran, so turns side by side count once. Different phases can overlap (a reply while building), and each counts its own time; `overlap` says when they did.
- **Waiting for you:** from each question to when it closed, merged, so questions open at once count once.
- **Paused or held:** from a pause or stop to the resume, and from when desk-wide controls began holding the room's work to when they let go.
- **Breaks:** any stretch over 30 minutes with nothing running, labelled *waiting for you* (if most of it was) or idle. The totals don't change; only the drawing shortens them.

Where the times come from:

| Piece | From | To |
|---|---|---|
| A turn | `startedAt`; for the Codex app, `pickedUpAt` (when the app took it up), so its queue time isn't counted as work, and a turn it never took up counts nothing | `endedAt`, or now while it runs. A turn never sent (held while prepared) counts nothing |
| A checks run | its new `startedAt` (from the run itself) | the gate event's time. While the run is going it has no event yet: the desk and the page pass it in as `live`, and its result's `runId` ends it. A run cut short: a `checks` mark with its start and why |
| A question | its time | its new `closedAt`; in older rooms, the time of the answer that closed it; if neither is known, it isn't counted |
| Pause, stop, resume | the new `mark` events, written whenever the room's state changes; in older rooms, the *Paused.*, *Pausing:*, *Stopped.*, *Resumed.* and *Resumed by your message.* lines. Work the room sent after a pause also ends it | |
| A desk hold | a `held` mark when the room's work starts waiting on desk-wide controls (`deskNotice` set), `free` when it stops | |

**Marks** are events of `type: "mark"` with `what` (`paused`, `resumed`, `stopped`, `held`, `free`, or `checks` for a checks run cut short). The room's transcript doesn't draw them, and they never reach an agent (the prompt only forwards owner notes, turns and system lines marked for agents).

### The desk (`src/engine.mjs`, `src/client.mjs`)

- **Each room's timeline is kept as events come in:** filled from its events at start, then fed by `#append` and `#patch`. Archiving a room drops it.
- **The room's summary has `session`:** `{ start, length, totals, overlap }`, with a finished room ending at its last event. So `/api/state`, Home, and everything built on the summary carry it.
- **`toryo show` and `toryo_room`** start with the session in a sentence: *This session, 5 h 20: building 3 h 10, reviewing 1 h 05, checks 22 min, waiting for you 1 h 30.* A session with only a moment of work says *under a second of work so far*; none at all, *nothing run yet*.
- **`toryo status`** adds `· 1 h 20 this session` to a room's line once it has run a minute.

### The strip (`web/app.js`, `web/index.html`, `web/styles.css`)

- **Where:** the last row of the room's sticky header (`#sessionStrip` in `#roomhead`), across its full width. The owner's note asked for it in the top sticky bar; the room's own header is the sticky bar that belongs to a room, and the desk-wide bar above has no room in it.
- **What it shows:**
  - a thin lane per phase on one time axis, in the activity colors: planning purple, building blue, reviewing mint, checks grey, other work slate (the *other* lane only when there is some);
  - waiting for you as an orange tint behind the lanes, paused or held time hatched;
  - a break drawn as 3% of the time worked, with its length written in it.
- **Each piece:** hover for *Codex, build, Slice 2: The API round 2: 14:02–14:40 (38 min)* (*–now* while it runs, *failed* for failed checks, *start estimated* for checks from older rooms). Clicking it brings its turn into view in the room, like a Home link does.
- **The totals in words** on the right (*Building 3 h 10 · Reviewing 1 h 05 · 5 h 20 in all*), as a button. It opens a sheet with the sentence, each phase's total, and every piece of work grouped by phase, each a link to its turn (which closes the sheet), then the breaks. The strip itself is an image whose label is the sentence; its pieces are out of the tab order, since the list gives the same links by keyboard.
- **On a phone** (under 760 px): one bar of the totals, in the same colors, and the words below it, 44 px tall.
- **Live:** the page keeps its own `Timeline`, built from the room's events when it opens and fed each event as it arrives, so the page and the desk work out the same thing from the same events. The strip is drawn on each live event and with the header (once per refresh); between news, every 10 seconds while something runs, else once a minute.
- **Drawn in place:** the strip's parts are built once, then each changed only when what it shows changed, so the totals button keeps the keyboard focus while news comes in.
- **Nothing on it moves,** so reduced motion changes nothing.

### Older rooms

They show what can be known and nothing false:
- a checks run without a recorded start starts at its end less the sum of its checks' seconds, marked *start estimated*;
- a question closed without a recorded time uses the answer that closed it; with no answer either, it isn't counted as waiting;
- pauses and stops come from their sentences, and end at the first work the room sent after them if no sentence says so (a handoff brought in, or a Codex app turn followed after a restart, isn't work the room sent);
- Codex app turns from before pickup times were recorded (Slice 8) count nothing: when the app worked on them isn't known;
- desk holds before this slice can't be known, so none are shown.

## How to check

- **`npm test`:** 221 tests, all passing.
  - **`test/phases.test.mjs`** (12 tests, synthetic events; round 2's three are in the table above, round 3's case is in the pause test):
    - each kind of turn in its lane, plan checks among reviews;
    - parallel turns in one phase count once, overlapping phases each counted, and `overlap` set;
    - a running turn grows to now, a changed turn replaces itself, a deferred one counts nothing, the Codex app's from `pickedUpAt`;
    - checks from their recorded start, estimated from their end and seconds, and live;
    - waiting: questions open at once counted once, `closedAt`, the answer's time for older rooms, an unknown close not counted, an open question to now;
    - paused and held from marks, and from the older sentences;
    - breaks over 30 minutes, labelled waiting or idle, with the totals unchanged;
    - the words: durations, the sentence, *under a second*, *nothing run yet*;
    - a room with 6,000 events: each taken in on its own, and a view computed quickly.
  - **`test/session.test.mjs`** (7 tests, with fake agents; round 2's three are in the table above, round 3's above that):
    - A build room where Codex works 1.2 s, Claude reviews 0.8 s and the checks `sleep 1`. Once stopped, the summary's building, reviewing and checks totals each match the turns' and checks' real times within a second. A `Timeline` fed the room's events, as the page does, gives exactly the summary's totals.
    - Pausing, resuming and a desk hold leave `paused`, `resumed`, `held` and `free` marks, which the transcript doesn't show; an answered question has `closedAt`.
    - `toryo show` and the MCP `toryo_room` start with the same sentence as `sessionWords(summary.session)`.
- **The browser check passes,** steps 0 to 6, with new steps 5v and 5w (above) and 5u:
  - a room with a 3-second reply: the strip appears with a piece titled *Codex, reply: hh:mm–now (n s)*;
  - when it ends, *now* is gone and the piece is wider than while it ran;
  - the words read *Other work n s · n s in all*;
  - clicking the piece brings the turn into view;
  - with the focus on the words, the room is paused and resumed: the strip shows the paused time, and the words still have the focus;
  - Enter on the words opens the list, and Enter on a link in it closes the sheet.
- **The screenshot script passes** (contrast, no sideways scrolling at 1440, 1024, 390 and 320 pixels, light and dark), with the strip in the build room's header and the phone bar.
- **Mutations.** Each fails a test, in copies of the tree:
  - **the desk's timeline not fed by `#patch`:** the session test (a turn stays running, so the totals are off);
  - **no `closedAt`:** the session test;
  - **no marks:** the session test;
  - **the page's timeline not fed events:** the browser check, step 5u (the piece stays *–now*);
  - **the strip rebuilt on each redraw:** the browser check, step 5u (*the words keep the focus*). An earlier run of mine caught this one by chance: the Enter after the focus went nowhere because news had redrawn the strip in between.

## Worth a look

- **A flake in Slice 9's step, seen once.** In one of six browser-check runs (in a mutation copy, with only the page's timeline changed), step 5t timed out waiting for the *Fail room* question's card on Home (`askingRoom`), before reaching anything of this slice. It didn't recur in the other five runs, and I haven't found the cause. If Home's fetch ever hung, `loadHome` would wait on it forever and Home would stop updating; that's my best guess, unproven.

- **The summary computes the view each time.** `summary()` is called for every room on each state broadcast; `view()` sorts and merges the room's work pieces, which is quick for thousands of events (the 6,000-event test) but is still per call. If it ever shows up in a profile, the view can be cached until the room's next event or the next second.
- **Questions closed by other paths:** the three places that close a question all record `closedAt`. A question closed without an answer (a stop, a new flow) keeps no close time from before, so in older rooms it isn't counted as waiting.
- **"Test" in the owner's note is the checks lane** (the project's checks: tests, lints, builds). A reviewer running tests counts as reviewing.
