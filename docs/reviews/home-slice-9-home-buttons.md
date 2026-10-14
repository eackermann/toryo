# Home and desk controls, Slice 9: Home answers and control buttons

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 9, with *Home and remote controls* (Needs you, the desk bar, Agents and usage) and *Release and pause a guard until reset*.
**Tree:** uncommitted on top of Slice 8 (`d8f32dd`).
- **New:** this handoff.
- **Changed:** `src/engine.mjs`, `web/app.js`, `web/styles.css`, `test/home.test.mjs`, `test/ui-check.mjs`, `README.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart, Home's questions can be answered in place, and the desk's controls are buttons on Home.

No new desk operation: every button calls what the terminal and MCP already use (`POST /api/rooms/<id>/answer` with `questionId`, `POST /api/rooms/<id>/control` with `accept-checkpoint` or `plan-check`, `POST /api/desk`). Home shows the desk's own replies.

## Round 2: your five findings

| # | Finding | Fix | Test (browser check, step 5s or 5t) |
|---|---|---|---|
| 1 | P2: Text typed while a send was on its way was lost when it succeeded. | **The card is locked while its answer is on its way:** the text is read-only, its buttons are off and *Send* says *Sending…*. A second send (click or Ctrl+Enter) does nothing. It's locked in place, not redrawn, so the focus stays. Sent, the card goes; not sent, it's unlocked with your text. | The desk's reply to the answer is held back. With the card locked, typing changes nothing, a second Ctrl+Enter sends nothing, and *Send* is disabled. Let through: the answer is exactly the text sent, sent once, and the draft is gone. |
| 2 | P2: After a reload, a draft for a question answered elsewhere stayed in the browser with nothing to show it. | **Each draft keeps its question** (`draftFor`): its room and title, the question, who asked, and its kind. *Needs you* draws a closed card for every draft whose question isn't open, from the page or from the browser's drafts, whatever happened while the page was closed. The desk now sends every open question's id (`openIds`), not only the 50 Home shows, so a draft for an open question further down isn't taken for closed. | Two cases. Text written, the card left, the question answered through the API, then a reload. And text written, the page closed, the question answered, the page opened again. Each comes back as a closed card, with its room, its question and the text. |
| 3 | P2: A card being typed in when its question closed got the closed mark but kept its controls: no explanation, no *Dismiss*, and *Send* still sent. | **`markStale` changes the card in place:** *closed*, the explanation, *Open the room* and *Dismiss*, and no *Send*, without touching the text box, so the text and focus stay. Once you leave it, it's drawn again as a closed card. Any action on a closed question is refused on the page; nothing is sent. | The test no longer clicks elsewhere first. While typing, the question is answered through the API. The note and *Dismiss* appear, *Send* is gone, and the focus and text are unchanged. Ctrl+Enter sends no request. After leaving the card and more news, it's still closed with the text. |
| 4 | P2: The confirmations named the wrong recipient (a checkpoint's `from` is empty; a check went to the checkers, not the author) and took the hold from Home's earlier picture. | **Built from the desk's reply** (`reachedText`): every action returns the room's summary, with the queued work held up and why. Recipients by action: the author for a checkpoint, the checkers for a check, the asker for an answer, and for *Start building* whoever the build queued. For each, it says held up and why, already on it, or next; a paused room says it waits for you to resume it. | Accepting a checkpoint while its author (Codex) is held: *Your call is in… Codex gets it when this ends: you hold Codex…*. Asking Claude to check the ready plan while only Claude is held: *Claude gets it when this ends: you hold Claude*, and nothing about Codex. |
| 5 | P2: The working card's activity line had `data-act`, so a click on it posted an empty desk control. | **The activity line is `data-activity`,** and only Home's buttons with `data-act` do anything. | Clicking a working card's activity line opens its room, and nothing is posted to the desk. |

- `npm test`: 202 tests, all passing (`openIds` is checked in the HTTP test).
- The browser check passes, steps 0 to 6.
- **Each fix taken out fails the browser check at its own check** (in copies of the tree):
  - **no lock while sending:** *nothing typed while it's sent*;
  - **no closed cards from the browser's drafts:** the closed card after the reload never shows;
  - **closed but not changed in place:** the focused card never says it's closed;
  - **the confirmation from the old picture:** the held author's message never comes;
  - **the activity line acting again:** a desk control is posted.

## What changed

### Answering from Home (`web/app.js`)

Each card in *Needs you* (`askCard`) offers what fits its question:

| Question | On Home |
|---|---|
| An agent's question (chat, build, review, planning) | *Use the recommendation* (when there is one), *Write my own answer*, *Open the room* |
| A failed turn | *Retry*, *Retry with a note* |
| A planning checkpoint | Each question with its recommendation and who made it. *Accept all recommendations: Codex writes the plan* names the author the room's form would choose. If a question has no recommendation, it says to answer it in the form and offers *Open the form*; it doesn't accept for you. The full form stays in the room. |
| A ready plan | *Start building with this plan*, *Ask Claude to check it* (the card's checkers), *Ask for changes* (written) |
| A Codex app turn lost | *Follow it again* |

- **Drafts.** What you write is kept in this browser per question (`toryo.homeDrafts`) as you type, until it's sent, cancelled or dismissed. A reload brings the editor back open with your text. Ctrl+Enter (or Cmd+Enter) sends.
- **Not redrawn while you write.** Home is now drawn part by part (`setPart`), each part only when what it shows changed. *Needs you* is drawn card by card (`patchNeeds`): a card with the focus, or one being sent, isn't touched, so your text, cursor and focus stay. It isn't moved either; new cards are placed around it. A card with no focus is drawn again, with its draft.
- **Answered elsewhere.** A question that closes elsewhere (another tab, a terminal, your phone) while you have text in its card keeps the card, marked closed. It says: *This question was answered elsewhere, or its room has moved on. Nothing was sent from here. Your text is kept below: copy it, or dismiss it.* Nothing can be sent from it. A send the desk refuses as answered (409) does the same. Without text of yours, a notice says it wasn't sent.
- **A send that fails** keeps your text, says why in the card (*That didn't work: … Your text is kept.*), and puts the focus back in it.
- **Answering a held agent.** The answer is saved, the question closes, and the reply waits. The notice says who gets it and when: *Codex gets it when this ends: you hold Codex (headless and the Codex app).*

**The desk** (`home()` in `src/engine.mjs`) now gives each card what it needs:
- **A checkpoint:** its default `author` (the room's builder if it's a planner, else the first planner, as `synthesize` chooses), and whether every question has a recommendation (`complete`).
- **A ready plan:** its `author`, `checkers` and `planPath`.

### The desk's controls on Home

- **Pause everything,** or *Resume everything*. While paused, Home counts the turns still finishing, and says what Resume lets go: the rooms waiting only on the pause; your holds and the guard stay.
- **Your holds:** each with *Release*.
- **Each guard hold:**
  - *Let it run until the reset*, when the reset is known (`guard-pause`);
  - *Release it*, once it has reset with automatic release off (`guard-release`);
  - with no known reset time: *Its reset time isn't known* and *Turn this rule off*.
- **After a control:** what the desk said shows under the heading, and stays until dismissed. After *Release*, that's what still holds the agent, with a *Pause this guard until reset* button for each window, from the reply's `offers`.
- **Holds per agent,** in *Agents and usage*:
  - Codex's allowance: *Hold both* (Codex and the Codex app);
  - each agent's own line: *Hold* or *Release*: headless Codex alone, the Codex app alone, Claude…
- **The guard's settings** (*Usage guard*): a sheet with each allowance's windows (on or off, the threshold) and release at reset. Saving sends only the allowances you changed, and only the rules you changed. The guard's own rule (Slice 7) leaves the others untouched.
- **The guard's note** shows until you press *OK* (or *Turn it off*, which turns every rule off and counts as having read it). It doesn't come back after a reload.

### Small fixes on the way

- **The time a turn was handed to the Codex app** is now one clock reading for the run and its record. They were two readings, which could differ by a millisecond. The round 3 test of Slice 8 caught it once in about twenty runs.
- **A card you're writing in is never moved.** New cards go around it, since moving it would take the focus away.

## How to check

- **`npm test`:** 202 tests, all passing. `test/home.test.mjs` adds a test for the planning cards:
  - a checkpoint where one question has no recommendation: author Codex, not complete;
  - then the ready plan: author Codex, checkers Claude, its file.
- **The browser check passes,** with a new step 5t:
  - **The guard's note:** *OK* hides it.
  - **Holds:** *Hold both*, then Codex's question answered with *Use the recommendation* while held. The notice says Codex gets it when the hold ends; the question is closed and no reply runs. *Release both*. Then *Hold* and *Release* on Codex's line (headless only) and the Codex app's line (app only), each checked against the desk's holds.
  - **A planning checkpoint:** both recommendations and who made them, *Accept all recommendations: Codex writes the plan*, and *Open the form*. Accepting makes Codex the author, and records each recommendation as shown, as the room's form does.
  - **Answered elsewhere:** text written in a card, then the question answered through the API (another client). The card stays, closed, with the text and no send; *Dismiss* removes it.
  - **A failed send:** answering fails with an error (the desk answers 500). The card says so, keeps the text and the focus. Sent again by keyboard, it goes.
  - **Typing while news comes in:** Home fetches its summary, and the text, focus and cursor position are unchanged. After a reload the editor is open with the text, and the guard's note stays hidden.
  - **Release with guard holds:** a Codex turn's log puts both its limits over the guard, and you hold Codex too. *Release* says what remains, with two *Pause this guard until reset* buttons. One pauses the weekly guard; the deskbar's button pauses the 5-hour one.
  - **No known reset time:** a Claude reading without a reset. Home says its reset time isn't known; *Turn this rule off* ends the hold.
  - **The guard's settings:** Claude's 5-hour rule shows off. Codex's weekly threshold changed to 99 is saved. After a reload, both are as set.

  Steps 0 to 6 all pass.
- **The screenshot script passes:** contrast and no sideways scrolling, with the buttons, at 1440, 1024, 390 and 320 pixels, light and dark.
- **Mutations** (browser check, in copies of the tree). Each fails the check:
  - **a card with the focus drawn again:** at the failed send, the focus is no longer in the text;
  - **a card whose question closed dropped despite its draft:** the *answered elsewhere* card never shows;
  - **drafts not kept in the browser:** the same, since the card's text isn't kept.

## Worth a look

- **Planning checkpoint authors:** Home always uses the default; choosing another author is the form's job, in the room.
