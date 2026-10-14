# Home and desk controls, Slice 18: Earlier sessions, a time ruler, and zoom and pan on the session timeline

**Author:** Claude, 14 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 18, with *Earlier sessions, a time ruler, zoom and pan* under *Session timeline and new sessions* (the owner's decisions of 14 Oct, [the record](../decisions.md#2026-10-14-following-a-codex-app-turn-that-ended-with-an-error-and-a-fuller-session-timeline)).
**Tree:** uncommitted on top of Slice 17 (`d347990`).
- **New:** `test/ruler.test.mjs`, this handoff.
- **Changed:** `web/phases.js`, `web/app.js`, `web/styles.css`, `README.md`, `test/ui-check.mjs`.
- **A separate fix to Slice 14** (found while checking this one; see the end): `src/snapshots.mjs`, `test/snapshots.test.mjs`.
- **The owner's new note (N1, a Fast switch for each agent), recorded but not built:** `docs/decisions.md` (*A Fast switch for each agent*), the plan (new Slice 19; the worktree slices are now 20–23), and one sentence in README's *Planned* paragraph.

Once approved, I'll make three commits, each with only its own files: the slice first, then the snapshots fix, then the plan update. README has changes for both the slice and the plan; the plan's sentence goes in the plan update's commit. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`; the desk serves the page it started with). Nothing is stored. The only change on the desk's side is the snapshots fix: after the restart, a project's first snapshots taken in two of its folders at once can no longer turn its snapshots off until the next restart.

## After approval: your two minor notes

- **The ruler is laid out again when its width changes** (P3). A `ResizeObserver` on the strip's track redraws the strip as soon as its width changes (a resized window, a side panel opening), instead of at the next news or the minute's tick. **Test:** `test/ui-check.mjs` 5w opens the break room at 1600 px (a ruler about 928 px wide), then narrows the window to 1300 and 1181 px (rulers of about 628 and 509 px) with nothing else happening. After each change, no labels overlap or are cut off, and *9 h 00* is centred on its break. With the observer taken out (in a copy), the check fails there.
- **The intermittent Home steps explain themselves** (P3). If step 5s's wait for Home after Back, or step 5t's wait for a question's card, times out, the check prints the page's state before failing: its address, whether Home shows, the room's title, and Home's cards. It also prints:
  - the page's requests still on their way, with how long each has waited;
  - how long a request sent from the page right then takes to come back (whether the page can still reach the desk at all);
  - the page's latest navigations;
  - for 5t, the questions the desk's Home lists.

  The cause is still unknown; the next failure will say more. I checked the printout by forcing the 5s wait to time out in a copy. One thing it settled: by then the page has about a dozen live-update streams "on their way", one per earlier reload. That looked like a page whose connections were all held (a browser allows six per host). But a request sent then came back in 3 ms: Playwright simply never reports a stream replaced by a reload as closed. The printout counts those streams rather than listing them.

## Round 2: your three findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P2: A press released outside the strip, before it became a drag, left the strip panning under a pointer with no button pressed. | **A press ends wherever it's released** (`wireStrip`). From the press, the strip listens on the window (capture phase) for that pointer's `pointerup` and `pointercancel`. It stops listening when the press ends (an `AbortController`). A move without the main button held also ends the press (a release the page never heard, in another window, say). A new press ends any earlier one first. | `test/ui-check.mjs` 5xa, zoomed: press on the strip, go down off it, release over the transcript, come back across the strip with no button. The segment doesn't move, the strip isn't *dragging*, and it still shows session 2. With both guards taken out (in a copy), the check fails there. |
| 2 | P2: Clock labels either side of a compressed break overlapped (*10:00* and *19:00*, 20 px apart at 672 px), and the break's *9 h 00* was clipped inside its 20 px. | **The ruler's labels are laid out so none touches another** (`placeLabels` in `web/phases.js`, from `ruler(v, { …, px, measure })`). <ul><li>A break's length comes first, centred on the break and kept within the ruler, drawn over the ticks' lines with the header's background (`.ss-rlabel`). The hatched break keeps its place and its title.</li><li>Then the clock labels, left to right: one that would come within 6 px of a label already placed is left out, but its tick line stays, so the axis stays true.</li><li>A date left out goes on the next label drawn.</li><li>A label near the right edge sits left of its tick. That's now decided by its measured width, not by being past 88% of the ruler.</li><li>The break's gap in the lanes above (Slice 10's) printed its length the same way, cut to *9 h*. It's now a plain gap, keeping its title, with the length on the ruler right under it.</li></ul> The page measures labels in the ruler's own font (a canvas `measureText`). | **`test/ruler.test.mjs`:** <ul><li>the 9 h break session at 672, 420, 300 and 180 px: no two drawn labels touch or run off the ruler; the break's length is drawn, centred on it; every tick keeps its place; at 672 px, *10:00* and *19:00* aren't both drawn;</li><li>across midnight at 300 px, the date left out with *14 Oct 00:00* goes on the next label.</li></ul> **`test/ui-check.mjs` 5w:** a new *Break room* (two hours of work, nine idle, one more) seen at 1344 px (a ruler about 672 px wide), 1100 and 900. No drawn labels overlap, none is cut off or runs off the ruler, *9 h 00* is drawn, and it's centred on the hatched break. With the collision check taken out (in a copy), the browser check fails there. |
| 3 | P2: The Fast plan let the Claude switch show for models whose support wasn't known. | **Removed that fallback** (plan, Slice 19). Which Claude models support fast mode is established before the switch is offered, from Claude Code's or Anthropic's documentation, and kept with Claude's model list in its adapter, saying where it comes from. Only those models get the switch. If none can be established, Claude gets no switch, and the slice's handoff says so. A supported model can still be refused on a turn, and the turn says why. | The slice's verification now checks that the switch shows only for the models established as supported. |

## What changed

### Earlier sessions on the strip (`web/app.js`, the `toggle` listener)

- **Opening and folding:** opening (selecting) an earlier session's fold in the transcript shows that session on the strip. Folding it again returns the strip to the current session, if it was showing that one; so does *Back to session N*, which leaves the fold open.
- **Only your own toggles count:** the listener compares the fold's state with what it was. A fold drawn again as it was (the timeline re-rendering an open fold) isn't you choosing it, so it doesn't move the strip back after *Back to session N*.
- **Other ways in:** a segment of an earlier session opens its fold (as before), which also selects it. The list behind the totals still offers every session.

### Full width (`web/styles.css`)

The strip is one column, the whole width of the middle column: the lanes, then the ruler, then the totals in words on their own line (with the zoom buttons and *Back*), left-aligned.

### The time ruler (`ruler` in `web/phases.js`)

- **One axis, shared:** the strip's axis (`sessionAxis`, moved from the page) now lives in `web/phases.js` with the ruler, so the page and the tests use one calculation. As before, breaks are 3% of the time to scale each; the rest is to scale.
- **Ticks:**
  - **Spacing:** `ruler(v, { from, to, maxTicks })` picks the step (1 s up to 7 days) that fits `maxTicks` across the part of the session in view, counting only the time drawn to scale. Ticks are aligned to the local day (whole minutes, hours, days), so they're evenly spaced on time to scale. `maxTicks` comes from the strip's width (about one label per 84 px).
  - **Labels:** clock times, with seconds when the step is under a minute. The date (*14 Oct 00:30*) appears where the day changes, and on the first tick when the session spans days; midnight on an hourly ruler is the date alone.
- **Breaks:** each break in view is returned with its length and drawn on the ruler as a hatched break, with a title saying it isn't to scale, and its length (*9 h 00*) centred on it. No tick falls inside a break, and the ticks on either side of one are hours apart but drawn close: the ruler never suggests time is to scale where it isn't.
- **Labels never touch** (round 2): given the ruler's width and a measure, `ruler` lays the labels out. Break lengths come first, then clock times left to right, leaving out any that would touch (their ticks stay). A date left out goes on the next label drawn.

### Zoom and pan (`zoomView`, `minView` in `web/phases.js`; `wireStrip` in `web/app.js`)

- **The view:** the strip shows `{ from, to }` of its axis, kept per room and session shown (a different session starts whole). Everything on the strip (segments, shades, breaks, ruler) is placed in that view, and the track clips what's outside.
- **Zooming:** the wheel over the strip zooms around the pointer, keeping the point under it where it is, and calls `preventDefault`, so the page doesn't scroll. It never goes past the session's ends or closer than half a minute of time to scale. A session shorter than a minute can still be zoomed to half of it.
- **Panning:** a drag of more than 4 pixels pans and captures the pointer. A plain click on a segment still goes to its turn. A press ends wherever it's released, even outside the strip before it became a drag (round 2).
- **A drag is never a click, twice over:** the pointer capture makes the browser send the release's click to the strip, not to the segment under it. The strip also swallows the click that follows a drag (in the capture phase), in case a browser doesn't. Either guard alone is enough; see the mutations below.
- **Segments aren't dragged as links:** they're links, and the browser's own dragging of a link would take the drag away from the strip (and could open it where it's dropped). They're `draggable="false"`, and the strip prevents `dragstart`.
- **Fitting:** a double-click, or *Fit* (shown only while zoomed), shows the whole session.
- **Keyboard:** the strip's view is focusable (`role="group"`, with its label and `aria-keyshortcuts`). `=`/`+` zooms in, `−` zooms out, the arrow keys pan a quarter of the view, `0` or Home fits. − and + buttons beside the totals do the same.
- **Screen readers:** the list behind the totals stays, with every segment as a link. The track keeps its sentence (`role="img"`).
- **Phones (760 px and narrower):** the lanes, ruler and zoom buttons are hidden, and the single bar of the totals stays.

## How to check

- `npm test`: 316 tests, all passing (the snapshots fix's test and round 2's two ruler tests are new). The browser check and the screenshot script pass (at 320 and 390 px, nothing scrolls sideways).
- **`test/ruler.test.mjs`** (6 tests, in UTC; the last two are round 2's, in its table above):
  - **Ticks get finer as the view narrows:**
    - the whole 6 h session in hours, evenly spaced;
    - a tenth of it, in 5 minutes;
    - as close as it goes, in 5 seconds with seconds shown.
  - **Across midnight:**
    - an hourly ruler reads *13 Oct 22:00, 23:00, 14 Oct, 01:00, 02:00*;
    - a finer one, *… 14 Oct 00:00 …*;
    - zoomed into the second day, its first tick has the date;
    - a one-day session never shows one.
  - **A 9 h break:**
    - it's on the ruler with its length;
    - no tick falls inside it;
    - the ticks either side are 9 h apart but drawn under 5% apart;
    - its place agrees with the strip's axis.
  - **Zoom and pan:**
    - the point under the pointer stays put;
    - forty zooms stop at half a minute;
    - zooming out stops at the whole session;
    - a pan shifts the view and is held at the ends;
    - a 10-second session zooms to half.
- **`test/ui-check.mjs`**, new step 5xa (after the new-session steps), on a room with three sessions:
  - **Switching sessions:**
    - opening session 2's fold shows it on the strip; folding it shows session 3;
    - opening it again, then *Back*, shows session 3 with the fold left open;
    - the transcript drawn again (a saved room setting fetches the room afresh) draws the open fold again, and the strip stays on session 3.
  - **Layout:** the strip is over 85% of the header's width, the totals are under it, and the ruler's ticks read as clock times.
  - **A drag isn't a click:** a drag starting and ending on a segment, with the session shown whole, isn't a click on it. A page listener counts none, the strip still shows session 2, and the page stays in the room. It's done with the session shown whole on purpose: zoomed in, the drag would pan and redraw the segments, and a segment drawn again under the pointer is never clicked anyway, so that drag couldn't tell whether the guards work.
  - **The wheel:** zooming over the strip moves its segment. Every wheel event reaches the page with its default prevented, and nothing scrolls.
  - **Panning:** a drag to the left moves the time to the left.
  - **Fitting:** a double-click on the ruler fits.
  - **The keyboard:** `=` zooms, → shows later time, `0` fits to the same view as the double-click.
  - **Clicking:** a segment still opens its turn.
- **Why the check drags with the session shown whole:** my first version dragged on a segment while zoomed in. There, the segment's box runs past the strip's left edge, where the track clips it, and starting at the box's left edge pressed on the room list beside the strip, so the release opened another room. That was the check's mistake, not the page's.
- **Mutations** (each in a copy of the tree, through the browser check):
  - **Caught:**
    - the strip not following the folds: fails at step 5xa, line 1371;
    - the toggle listener without its *only real changes* guard: fails at 5x, line 1363 (a session started from another client redraws the transcript with session 1's fold open, and the strip jumped to session 1);
    - the wheel without `preventDefault`: fails at the new check that the page never gets the strip's wheel;
    - both drag guards taken out (no pointer capture, no swallowed click): fails at *a drag is never a click*.
  - **Survived, as expected:** either drag guard taken out alone. Each is enough on its own.
  - **Round 2, caught:**
    - both guards for a release outside the strip taken out (the window's listeners, the button check): fails at *no button pressed, no panning*;
    - the label collision check taken out: the browser check fails at the break room (*00:30* over *9 h 00* at 672 px), and the ruler tests fail;
    - the date not carried, or the break's length not centred: the ruler tests fail.
- **Also in 5u:** a fix to the check that the running segment grows. It now compares the segment's length in its title, not its width. A segment that starts with the session (the room's first event and the turn's start in the same millisecond) fills the strip throughout, so its width can't grow. That made the check fail whenever the timing fell that way.

## Worth a look

- **What counts as selecting an earlier session:** opening its fold (by you, or by a link into it). The owner's words were "open (select)".
- **The zoom is the page's own,** per room and session. A reload or another room shows the whole session again.
- **The ruler's labels are in the page's local time,** as the rest of the page's clock times are.

## Also: a project's first snapshots, taken in several folders at once (Slice 14)

- **What happened:** while the browser checks ran alongside the unit tests, `test/snapshots.test.mjs` failed once, in *two workspaces of one project*: *the project's folder isn't in a Git repository*. I reproduced it in 1 of 15 runs under CPU load.
- **The cause:** `Snapshots.ensure` makes the project's shadow repository the first time it's asked. It kept only its result, so two captures in different folders of one project (the project's folder and a room's worktree, each with its own lock) could both run `git init --bare` on the same folder. Two of those at once trip over each other (*could not lock config file*: 111 of 180 failed when I ran six at once). The one that lost cached `null`, so every later snapshot of that project said it wasn't in Git until the desk restarted.
- **The fix:** `ensure` keeps the setup's promise, so every caller shares one setup. A setup that throws is forgotten, so the next capture tries again (as before).
- **The test:** *a project's first snapshots, taken in several of its workspaces at once, make its shadow repository once*. It captures six folders at once with a slow `git init` on the PATH, as on a busy machine, and all six succeed. With the fix taken out, it failed 5 times out of 5.

## Seen while checking, not resolved

- **An earlier step of the browser check failed twice** over this slice's work, both times before this slice's step. It passed that step in the twenty or so runs since (the diagnostic runs, the mutation runs and the final run): step 5t's Home card for a new question didn't appear within 30 s (`askingRoom`, line 1013). Once, step 5s failed instead, going back to Home after opening a room from a Home card (line 906). I ran it four times with diagnostics on that step (what Home shows, what the desk lists, the page's requests in flight). All four passed, so I don't have its cause. This slice doesn't change Home or its refresh, so I believe it's older than this slice, but I haven't shown that.
- **In round 2, step 5s failed once more** (line 906, going back to Home), in a mutation run while a second browser check ran alongside it. The same mutation, run alone, reached its own check. Every other run this round passed it.

## What remains

- **Slice 19:** the owner's Fast switch for each agent.
- **Slices 20–23:** setup and checks one at a time per project, then the review, return and cleanup of worktrees.
