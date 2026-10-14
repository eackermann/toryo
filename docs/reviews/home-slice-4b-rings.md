# Home and desk controls, Slice 4, part (b): activity rings, the sparkler and the live logo

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 4: Design system and re-skin. This is its second and last part; part (a) is committed (`4e7eedd`).
**Tree:** This part is uncommitted on top of part (a).
- **New files:** `web/rings.js`, `test/rings.test.mjs` and this handoff.
- **Changed:** `web/app.js`, `web/styles.css`, `web/index.html`, `src/engine.mjs` (the summary's `paused` and `held`, round 2), `test/ui-shots.mjs`, `docs/design-system.md` and `README.md`.

Once approved, I'll commit only those, and Slice 4 is done. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** not live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- room tiles and working agents wear their rings, with the sparkler for work in progress;
- the logo in the top bar is live;
- the rail has the legend.

Apart from two new fields in each room's summary (`paused` and `held`), the desk doesn't change; the rest of this part is in the page.

The status line names this part *Slice 4: Design system and re-skin (part b: activity rings, the sparkler and the live logo)*, so its approval ticks Slice 4 in the plan panel.

## Round 2: your three findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P2: With a question waiting, a paused or held room showed only orange. The desk's status is "waiting" before it checks for a pause or a hold. | **The room summary now carries `paused` (paused or stopped) and `held`** (all its queued work held up) apart from its status (`src/engine.mjs`). `ringFor` uses them, so the dashed ring or the lock stays, with the orange pulse outside. A room still finishing its turn while it pauses shows the work until the turn ends, then the pause. | `test/rings.test.mjs` adds a test on real desk summaries:<ul><li>A chat question, then you pause the room: its status is "waiting", its ring dashed with the pulse.</li><li>A question, and the only queued work is for Claude, whom you hold: its status is "waiting", it's `held`, its ring dotted with the pulse.</li><li>Paused while a turn runs: the work's ring until the turn ends, then the pause.</li></ul>With the status-only logic back, the test fails. |
| 2 | P2: Zooming misaligned and clipped the sparklers. The bitmap was sized once, but drawn at the current pixel ratio. | **The bitmap follows the pixel ratio.** Each sparkler remembers the ratio it was sized for. When the capped ratio changes, its canvas takes the new size, and its sparks carry on: they're kept in CSS pixels. | The screenshot script changes the page's pixel ratio to 2, then 3 (capped at 2), then back to 1. Each time, the header tile's canvas takes the size for that ratio. With the bitmap sized once, it fails. |
| 3 | P3: Turning reduced motion off left the sparklers frozen until something else on the page changed. | **A listener on the reduced-motion setting** wakes the drawing loop when it turns off; when it turns on, the loop stops by itself. | The screenshot script opens the finished build's room with reduced motion (no timer ticks there), checks nothing has been drawn, then turns reduced motion off. A sparkler is drawn within half a second. Without the listener it fails, three runs out of three. |

You said the browser check couldn't run for you because `/tmp` was read-only in your environment. Both scripts create their temporary folders with Node's `os.tmpdir()`, which follows `TMPDIR`, so `TMPDIR=/some/writable/folder` lets them run elsewhere.

- `node --test` runs 154 tests, all passing.
- The browser check passes, and so does the screenshot script.
- The bugs above, put back in turn, fail their checks.

## What changed

**The ring for a room** (`ringFor` in `web/rings.js`, from the room's summary):

| The room | Ring |
|---|---|
| Done | `done`: solid mint, with a check |
| A turn failed (an open error question) | `error`: solid red |
| Paused, or stopped | `paused`: dashed, with a pause badge |
| Held (its queued work waits on a desk hold or pause) | `held`: dotted, with a lock |
| Someone works | Ring by the work's kind: `build`, `review` (and plan checks), `plan`, `checks` (the project's checks), `chat` (a reply, in slate) |
| A question waits, nobody works | `needs`: orange, pulsing in place |
| Nothing | `idle`: no ring |

A waiting question also adds the orange pulse outside a working, paused or held ring (`data-needs`).

**Where rings show**
- **Room tiles**, in the rail and in the room's header.
- **An agent's monogram while it works:** on its live turn card, and on its crew card.
- **The plan panel:** the slice being built gets a ring in the color of what's happening to it (blue building, mint review, grey checks), and its segment in the bar pulses.
- **The legend** *What the rings mean* is under the rooms.

**The sparkler** (`web/rings.js`): the prototype's drawing, kept as it is.
- **What it draws:** a hot point with a turning glint, sparks in every direction that sometimes fork, a fading trail cooling from white to the activity's color, and embers drifting off.
- **One loop for all of them.** All sparklers are drawn by one `requestAnimationFrame` loop on one clock (`performance.now()` mod 2.8 s). The loop runs only while a sparkler is on the page. A `MutationObserver` wakes it when one appears.
- **Limits:** canvases off the screen are skipped; sparks (150) and embers (170) are capped per sparkler; the pixel ratio is capped at 2.
- **Theme changes** recolor every sparkler: the theme button, or the system switching.

**One clock for the CSS too.** Each tile carries its animations' delays as negative values from the same clock (`--phb` for the halo, `--phn` for the pulse, `--phm` for the marching dashes). The rail is redrawn whenever any room changes, but a tile that still shows the same thing is kept as it is (`data-ring-key`), so its sparks carry on. The header's tile works the same way.

**The live logo.** The logo's three blocks fade on their own (`--ob`, `--op`, `--om`, registered with `@property`). Each block breathes while that kind of work runs anywhere on the desk (`markAnimation`), with its delay from the same clock.

**Reduced motion.** The rings stay, solid. No sparkler is drawn (the canvases are hidden and the loop doesn't run), nothing pulses or marches, and the logo is still.

**Docs.** `docs/design-system.md` now describes the rings as built: where they show, the slate ring for replies, the one loop and clock, the logo, the plan's progress and the legend. The README's *What you see* describes the rings and the live logo.

## How to check

- `node --test` runs 154 tests, all passing. `test/rings.test.mjs` is new:
  - the kind of each request;
  - the ring for every room state, including a question on top of each;
  - delays from the shared clock;
  - a ring's parts: sparkler, badges, outer pulse;
  - the live logo's animation.
- **The browser check passes**, unchanged.
- **The screenshot script passes.** It now sets up a room in every state a ring shows:
  - **At work:** five rooms building, one checking (a project whose check sleeps).
  - **Finished or failed:** one failed twice, one done after its final review.
  - **Waiting or still:** two with a question, one paused, one held (Claude held, and Claude is its builder).

  Then it checks, in light and dark:
  - **The rings:** each room's tile has its ring; working tiles have a sparkler that's being drawn; the done tile has its check and the held one its lock; the working agent wears its ring; the logo breathes for the building.
  - **Redraws:** drawing the rail again keeps an unchanged tile (the same element), and the tiles' delays come from the clock.
  - **Smoothness:** with 8 sparklers on the page, 181 frames in 3 seconds; 95% within 16.7 ms, that is 60 frames a second.
  - **Reduced motion:** the rings are there; no sparkler is shown or drawn; no animation is running.
  - **Pictures:** `rings-1440-light.png` and `rings-1440-dark.png` show every state; the build, chat, plan and sheet pictures from part (a) now show their rings too.
- **Each safeguard, removed in turn, fails the screenshot script:**
  - drawing the rail again replaces every tile;
  - no delays from the clock;
  - the sparkler still shown with reduced motion;
  - the drawing loop never waking;
  - pulses still running with reduced motion.

## Worth a look

- **A reply in chat has a slate sparkler.** The plan names building, reviewing and planning; a reply is none of those, so it takes no activity color. It's still a sparkler, because something is at work.
- **A failed turn shows red, not orange.** Its question is the retry, and red says what happened. Its line in the rail still says *Needs you*.
- **The checks only have a ring on the room's tile.** The prototype also marched the dashes in the timeline's checks row while they run. Toryo writes that row only when the checks have finished; while they run, the timeline shows *Running checks before review*.
