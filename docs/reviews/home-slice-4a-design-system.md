# Home and desk controls, Slice 4, part (a): the design system and the re-skin

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 4: Design system and re-skin. This is its first part.
**Tree:**
- **Committed:** Slice 5 (`6fa334c`) and the plan change (`ce9b8cb`).
- **This part, uncommitted:**
  - Page: `web/index.html`, `web/styles.css`, the new `web/tokens.css`, `web/app.js`, `web/favicon.svg` and the new `web/fonts/`.
  - Desk: `src/page.mjs`, and `src/engine.mjs` (open questions carry when they were asked; round 2).
  - Tests: `test/server.test.mjs`, `test/ui-check.mjs`, `test/questions.test.mjs`, and the new `test/ui-shots.mjs` and `test/tokens.test.mjs`.
  - Docs: the new `docs/design-system.md`, the new `design/prototype/toryo-desk.html`, `README.md` and this handoff.

  Once it's approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` files belong to another room and stay out. Nothing needs an owner decision.

**Restart:** not live until the owner restarts the desk (`toryo quit && toryo`). The desk serves the page it started with, so until then the page says *Toryo has been updated. Restart Toryo to use it*. After the restart, the page has the new look; nothing else about the desk changes.

## Round 5: your finding (after the owner's answer: address it and resubmit)

| Finding | Fix | Test |
|---|---|---|
| P2: A successful *Save* deleted a newer change: one typed on in the still-open editor while the save was on its way, or one made in another tab. | **Each kept change has a revision** (`setNoteChange` gives every change a new one, at every keystroke in any tab). *Save* notes the revision it sends (`S.saving`, note to revision). When the desk replies, the change is dropped only if it's still that revision. A newer one stays, and so does its editor: the same box, still focused. While a save is on its way, the note shows as saved unless there's a newer change; then the editor shows it. If another tab has changed the note, this tab's editor takes that newer text when the note is next drawn (the browser storage is shared, and the latest wins). If a refusal arrives (the note went first), whatever is newest shows as the change that couldn't be saved. | Browser check, step 5p, on a queued note, with saves held back:<ul><li>*Same tab:* save "Version A", then type on to "Version A, and B" while it's on the way. The desk saves A. The editor still holds "…and B", also after a reload.</li><li>*Two tabs:* this tab saves "Version C". Meanwhile a second tab opens the room, sees C in its editor, and changes it to "Version D". The desk saves C, and the first tab's editor shows D, also after a reload.</li><li>*Keep as it was* drops the change. After a reload the note reads "Version C", with no editor.</li></ul>With round 4's unconditional drop put back, the same-tab part fails; with the same-tab part taken out, the two-tab part fails too. Without taking the other tab's newer text, the two-tab part fails. |

- `node --test` runs 148 tests, all passing.
- The browser check passes, twice in a row, and so does the screenshot script.

## Round 4: your finding

| Finding | Fix | Test |
|---|---|---|
| P2: A refused *Save* lost the change after a room switch and a reload. The page only kept the change when it drew the note, and by the time the refusal arrived you were in another room. | **Every change to a note is kept in the browser as you type, under the note's room** (`noteChanges`, `toryo.notechanges.<room>`). The room is the one where you opened the editor, whichever room is on screen when the change is written. *Save* writes it once more before it's sent. It's dropped only when the desk has saved it, or when you choose *Keep as it was*, *Send it as a new note* or *Dismiss*. While a save is on its way, the note's update shows what was saved, not the editor. So whatever room you're in when a refusal arrives, and however many reloads come in between, the note's room shows either the editor (still queued) or the change that couldn't be saved (gone to the crew). This replaces round 3's `toryo.unsaved` storage, which hasn't been released. | Browser check, step 5o: you press *Save*, held back until the reviewer has the note. You move to another room, and the refusal (409) arrives there with its message. You reload, then go back: the panel shows your whole change, and the note keeps its old text. *Dismiss* and a reload: gone. Step 5l: an open editor survives a move to another room and a reload; it comes back as the editor (not the panel) with your text, then saves. With changes not kept as you type, the browser check fails: at step 5l's reload, and with that part removed, at step 5n. Round 3's exact behaviour can't be put back on its own, since the storage changed. |

- `node --test` runs 148 tests, all passing.
- The browser check passes, twice in a row, and so does the screenshot script.

## Round 3: your finding and the two open ones

| # | Finding | Fix | Test |
|---|---|---|---|
| P2 | A change to a queued note was lost when the note went to the crew while you were changing it. Only 160 characters stayed, in a toast that fades. A normal handoff to the reviewer does this. | **Your change is kept until you act on it.** When the note goes to the crew mid-change, or your *Save* loses the race and is refused, the editor becomes a panel under the note: *Your change wasn't saved: the note went to Claude first*, with your whole text. *Send it as a new note* puts that text in the box, to the same agent, as a note that answers nothing. *Dismiss* drops it. The panel is kept in the browser per room (`toryo.unsaved.<room>`), so it survives redraws and reloads. The toast is gone. | Browser check, step 5n: the builder takes 6 seconds, then hands off. You change a note to the reviewer (about 300 characters), and the reviewer starts with the note. The panel shows your whole text, and still does after a reload. *Send it as a new note* puts it in the box, to Claude, and the panel goes. Step 5o: you press *Save*, but the save arrives only after the reviewer has the note. The desk refuses it, the message says so, and the panel shows your text while the note keeps its old text. *Dismiss*, then a reload: the panel is gone. Removing either fix fails its step. |
| P3 | Another redraw before the next frame could overwrite the saved cursor position. | **The text box isn't rebuilt any more.** Each redraw moves the box you're typing in into the note as it's drawn: same element, same text, same cursor and selection. Only the focus is put back, straight after the redraw. While fixing this I found that putting the cursor back a frame later was itself flaky: a click in that frame could be overwritten. Moving the box avoids that. | Step 5l now also puts the cursor at position 5 before the builder's turn ends. The timeline is drawn more than once in the same frame (that was the round-2 focus bug), and the cursor is still at 5. With the box rebuilt instead of moved, the step fails. The browser check passed three times in a row. |
| P3 | The *need you* count scrolled to the oldest question, then the room's own scroll to its end took over. | **The room opens on that question.** The count sets the question to show (`S.focusOn`). Drawing the room's timeline puts it in the middle of the view instead of scrolling to the end, opening a folded round if needed. A redraw before then does the same. | The screenshot script waits for the room to settle, a second after it opens, and checks the question card is inside the timeline's view. The chat room has a note and a reply below the question. With the old scroll, it fails. |

- `node --test` runs 148 tests, all passing.
- The browser check passes, three times in a row.
- The screenshot script passes.
- Each fix above, removed in turn, fails its check.

## Round 2: your five findings and the open one

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: On wide screens, a long timeline pushed the composer out of view. | **The relay's rows are named** (`head`, `tabs`, `log`, `composer`). The room tabs, hidden on wide screens, leave their row empty instead of the timeline taking it and the composer falling into the stretchy row. | `test/ui-shots.mjs` checks that the composer is fully in view in every room picture with the relay showing. With the rows unnamed, the 1440 px build fails: the composer starts at 900 px, the bottom of the screen. |
| 2 | P2: The desk's grid class `.body` also applied to a message's text, cutting it into two columns. | **The desk is now `.desk`**; `.body` is only a message's text again. | The screenshot script checks that every message's text is laid out normally and spans its card. With the old class back, it fails. |
| 3 | P2: Code and quotations in your notes were unreadable: page colors on the note's dark ground, about 1:1. | **Notes have their own tones** (`--note`, `--note-ink`, `--note-sunk`, `--note-line`, light and dark). Code, code blocks, quotations, links, tables and checkboxes in a note use them. | `test/tokens.test.mjs` checks the note's text on the note, and on its code background, in both themes. The screenshot script now also posts a note with inline code, a code block and a quotation, then measures every text on the screen as drawn: backgrounds, color mixes and opacity combined. Any text below AA fails it. With the page's code background back, or the quote's color, it fails. |
| 4 | P2: The side tabs stopped switching after widening the window. | **Choosing a side tab also changes the room tab** when that shows a panel, so the panel shown is always the one you chose last. | Browser check, step 5m: choose Crew as a room tab at 1000 px, widen to 1400 px, choose Plan. Plan shows and Crew doesn't. Without the fix, it fails. |
| 5 | P2: Drawing the timeline again lost a note you were changing. | **An open editor is kept in memory** (`S.editing`): its text, the cursor and whether it has the focus, saved just before each redraw. Each time the note is drawn it comes back as you left it. If the note has meanwhile gone to the crew, the editor closes and a message shows your unsaved version. Two edge cases are handled: focus counts as moved only when something else has it, not when a redraw removed the editor; and saving closes the editor first, since the desk's update can arrive before the save's reply, and reopens it if the save fails. | Browser check, step 5l: a build whose builder takes 6 seconds. You send a note to the reviewer, open its editor and type. The builder's turn ends, so the timeline is drawn again, and the question appears. The editor is still open, with your text and the focus. Saving then works. Without the fix, the step fails. |
| P3 | The *need you* count opened the most recently active room, not the oldest question. | **Open questions now carry when they were asked** (`at`, in the room summary). The count opens the room with the oldest question and scrolls to it, opening a folded round if needed. | `test/questions.test.mjs` checks `at`. In the screenshot script the planning room is the latest active, but the chat's question is older, and the count opens the chat. With the old choice, it fails. |

**About my round-1 checks.** While rechecking, I found that `test/ui-check.mjs` had a syntax error from a duplicate name, so two "caught" results were void. I fixed it, and both checks now fail for the right reason when their fix is removed.

- `node --test` runs 148 tests, all passing.
- The browser check and the screenshot script pass.
- **Each fix, removed in turn, fails a check.** That covers all six above, the two halves of fix 3 separately.

## Why in two parts

The owner allowed a split if the slice was too big for one review, and it is: the whole page is restyled. This part has the tokens, type, components, layout and docs. Part (b) brings the activity rings, the sparkler and the live logo.

The status line names this part *Slice 4a: Tokens, type, components, layout and docs*. It doesn't contain the slice's full name, so the plan panel won't tick Slice 4 when this part is approved; part (b)'s will.

## What changed

**Tokens, fonts, favicon** (`web/tokens.css`, `web/fonts/`, `web/favicon.svg`)
- **The prototype's light and dark tokens** in a file of their own. Dark follows the system unless you choose a theme with the new theme button in the top bar (system, light, dark, kept in the browser).
- **Contrast.** Every text color passes WCAG AA on the backgrounds it's used on, in both themes. Three light-theme tones are darker than in the prototype for this: muted, mint ink and orange ink. `test/tokens.test.mjs` checks every pair. The mint and orange ring colors keep the logo's values, below 3:1 on white. That's allowed because a ring is never the only way a state is shown.
- **Color means activity, never identity.** The per-agent colors are gone. Every agent's monogram (*Cx*, *Cl*, *Cu*, *Gk*) has the same neutral tone, and the Codex app's has a small window corner. This follows the owner's note, not the prototype, which still gave each agent its own tone.
- **Fonts.** Lexend, Figtree and JetBrains Mono as woff2, Latin and Latin Extended, about 117 KB, downloaded from Google Fonts. Each has its OFL licence file beside it. They're served like the other page files, and the page still loads nothing from the internet.
- **Favicon.** The logo mark: `design/toryo-vector-review-package/masters/toryo-mark-color.svg`, copied as it is.

**The page** (`web/index.html`, `web/styles.css`, `web/app.js`)
- **Top bar.** The logo and the TŌRYŌ wordmark; how many rooms are working; how many questions need you (it opens the room of the oldest); then theme, browser notifications and Settings.
- **The rail.** Rooms grouped by project, each a tile (the room's initials) with its name and one line of state. What needs you comes first, then who is working on what, otherwise the room's state. Hovering gives the same in words.
- **Room header.** The tile, the name (it opens Room settings), the project and folder, and a sentence: who is building, reviewing or planning, on which slice, for how long; whether a question waits; paused, stopped or held. Then the mode switch, *Pause*/*Resume*, *Stop* and *Room*.
- **Timeline:**
  - **Turn cards** with a monogram, a role chip, the kind, the time, and a status chip in the color of what happens next. A live turn has a working chip and its activity feed.
  - **The checks** as one row, with a failed check's output folding out.
  - **Your notes** as dark bubbles on the right.
  - **Question cards** with an orange edge, the recommendation in an orange box, and orange buttons only for answering. They keep every data attribute the tests and the answer code use.
- **Slices in a build.** The timeline is cut into slices and review rounds (`sliceStructure`):
  - A round runs from a building turn to the reviewer's verdict.
  - A slice starts at the first building turn after an approval.
  - Each slice gets a marker with its number and name, and *Approved after N rounds* or *Round N*.
  - The rounds before a slice's last one fold into one line: how long they took, how many reviews asked for changes, how many questions you answered. That's unless something in them is still open.
  - A round you open stays open when the timeline is drawn again. A jump to a message inside a folded round opens it.
  - A turn starting or ending draws the build's timeline again, so folds and markers follow.
- **The slice in progress.** The desk learns a slice's name only from the builder's handoff. So right after an approval, the header, the new slice's marker and the plan panel name the plan's next unfinished slice instead of the approved one.
- **Side panel: Plan, Crew, Ledger.**
  - *Plan* has the plan file, a segmented progress bar, the slices with the time each approved one took, the facts, the questions for you and the shared documents.
  - *Crew* has the agent cards as before, with neutral monograms.
  - *Ledger* is now its own tab.
- **Narrower screens.**
  - **Below 1180 px**, Plan, Crew and Ledger become tabs in the room, next to the relay.
  - **Below 760 px**, the page is one column with a tab bar at the bottom: *Rooms* and the current room. The room header gets compact: no tile or folder, and icons with names for screen readers.
  - **Below 420 px**, the wordmark hides.
- **Sheets** rise in the middle of the screen; toasts appear at the top right, or at the bottom on a phone. The New room sheet's mode cards have their icons.
- **Two fixes found while checking:**
  - **The timeline now opens at its latest message.** It scrolls smoothly, and drawing it again during that first smooth scroll stopped it two pixels down. Now the page's own jumps are instant (`scrollLog`).
  - **The New room cards no longer clash with the empty state's.** The empty state's mode cards don't carry `data-mode`, which the browser check uses for the sheet's cards.

**Desk** (`src/page.mjs`). The startup check now follows `url(...)` and `@import` in stylesheets. A missing font stops the desk from starting, as a missing script already does. Remote addresses, `data:` URLs and comments aren't followed.

**Design docs.** `docs/design-system.md` covers the principles, color, contrast, type, components, the ring states (marked as coming in part b), motion, layout, and how to check. `design/prototype/toryo-desk.html` is the owner's prototype, copied unchanged; its sample data is made up. The README describes the new look, and mentions the screenshot script under Development.

**Not built, on purpose:**
- **The prototype's Home and its *Design system* tab.** Home belongs to Slices 8 and 9. The design system lives in `docs/design-system.md` and in the prototype.
- **Its top-bar navigation and the guard chip.** The guard comes in Slice 7.
- **Its demo bar.**
- **The rings, the sparkler, the live logo and the ring legend.** They're part (b).

## How to check

- `node --test` runs 148 tests, all passing. New since Slice 5:
  - **`test/tokens.test.mjs`:** every text pair passes AA in both themes, and the two dark blocks are identical. It fails with the prototype's muted tone, or with a mismatch between the blocks.
  - **Page files** (`test/server.test.mjs`): the list now includes the tokens, fonts and licences. A missing font named by a stylesheet stops the desk, and `url()` and `@import` are read with any quoting.
- **The browser check passes:** `PLAYWRIGHT_CORE=… node test/ui-check.mjs`. It's updated for the new markup:
  - The rail's one-line state is *Codex app building*, and the room's tile reads *AR*.
  - A room waiting for you reads *Needs you…*.
  - *Start fresh* is on the Crew tab.
  - Everything else, the question and draft races of Slice 5 included, runs unchanged on the new page.
- **The new screenshot script:** `PLAYWRIGHT_CORE=… node test/ui-shots.mjs /tmp/shots`.
  - **What it shows:** a build in its second slice, with the first slice's earlier round folded; a question asked in chat; a planning checkpoint; and the New room and Settings sheets.
  - **The screenshots:** at 1440, 1024 and 390 px, light and dark; at 1440 with reduced motion; and at 320 and 390 px for the Crew tab and the planning form.
  - **What it fails on:** anything scrolling sideways (the page, the timeline, the side panel, the rail or a sheet), and any error in the browser.
  - I looked at every picture. The ones I adjusted for:
    - the wordmark overlapping the counts at 320 px;
    - a header too tall on phones;
    - Ask and Tell wrapping at 320 px;
    - the new slice's marker naming the approved one;
    - the timeline opening at the top.
- **Keyboard focus** is a two-pixel blue outline on every control (`:focus-visible`). Icon-only buttons have names.
- **The screenshot script** (round 2) also checks that the composer stays in view, that messages' text isn't squeezed, and every visible text's contrast as drawn. It also checks that the *need you* count opens the oldest question.

## Worth a look

- **How slices and rounds are found** (`sliceStructure` in `web/app.js`) rests on the turn kinds and statuses. It handles the usual cases: a building turn, the reviewer's verdict, and questions and notes in between. A round with an open question or a running turn never folds.
- **Drawing the whole timeline again** happens when a turn starts or ends in a build, a few times per round. Text you've opened (*Show the whole message*) and folds you've opened are kept.
- **The phone tab bar has two tabs**, *Rooms* and the room. The prototype's *Home* and *System* tabs come with Home.
