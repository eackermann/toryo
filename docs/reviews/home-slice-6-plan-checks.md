# Home and desk controls, Slice 6: Check ready plans and re-check requested changes

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 6. The owner's decision behind it is in `docs/decisions.md` (*2026-10-13: Plan checks and discussion handoffs*).
**Tree:** uncommitted on top of Slice 4b (`d82ee7e`).
- **New:** `test/plancheck.test.mjs` and this handoff.
- **Changed:**
  - **Desk and tools:** `src/engine.mjs`, `src/protocol.mjs`, `src/server.mjs`, `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`.
  - **Page:** `web/app.js`, `web/styles.css`.
  - **Tests:** `test/fake-agent.mjs`, `test/helpers.mjs`, `test/questions.test.mjs` (its server and MCP helpers moved to `helpers.mjs`, unchanged), `test/ui-check.mjs`, `test/ui-shots.mjs`.
  - **Docs:** `README.md`, `docs/design-system.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision.

**Also in this round: a plan change** (the owner's note N1; see the section below). It changes `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, `docs/decisions.md` and the README's *planned* paragraphs. As with Slice 4's plan change, I'll commit it on its own, before this slice.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- a ready plan's card says how it was last checked, and offers *Ask Claude to check it*;
- asking for changes gets the other planners' check of the revision, and their findings go to the author;
- a planner's reply to you about a ready plan offers to send the discussion to the author;
- *Use the recommendation* no longer carries a wrapper's `)?` into the answer;
- `toryo plan` and the MCP tool `toryo_plan` exist;
- the page no longer brings back a question answered elsewhere when it fetches a room again (a fix found on the way, below).

Plan rooms already open carry on. A Ready card from before the restart has no *Ask … to check it* button, because it doesn't list who can check. The other actions on it work, and the next card has the button. A desk that hasn't been restarted refuses `toryo plan` with a sentence saying to restart it.

## Round 2: your three findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: A check with no status line, or with `TORYO: REPLY`, counted as an approval: *Claude checked it and approved.* | **Approval needs an explicit `APPROVED` from every checker** (`#afterPlan`). A check that ends without a verdict is asked once, read-only, for the verdict alone (`prompts.planVerdict`, a `plan-check` with `verdictOnly`). It stays open until then. If it still gives none, it's recorded as having no verdict (`NONE`), never as an approval. The card then says so: *Claude checked it but didn't say whether it approves.* (verdict `incomplete`). That sentence also appears beside the others' approval, or after *… asked for changes, and Codex addressed them.* Findings from a checker who asked for changes still go to the author. | Two new tests: <ul><li>**One checker.** No status, then still none when asked: asked once, read-only, and the card says no verdict, not "approved". Then a `REPLY` followed by `APPROVED` when asked: approved.</li><li>**Two checkers.** Claude approves and Cursor gives none: both said. After a change request, Claude asks for changes and Cursor replies with `REPLY`, then nothing: Codex addresses Claude's findings, and the card names Cursor as having given no verdict. Cursor is asked once in each check.</li></ul> Both fail with no-verdict counted as approval, and both fail with no request for the verdict. |
| 2 | P2: Forwarding left out your answers given on a question card, even when named by id. | **Your answers count as part of the discussion** (`#discussion`): owner events of kind `answer`, as well as plain notes, by the exchange or by their ids. Each is quoted as *The owner (answering Claude: “Switch the cache to Redis?”)*. A planner's message that asked you something keeps its question: *(Question for the owner: …)*, since its status line is taken off. Delivery stays deduplicated: the answer's id is in `forwarded`, so the author's catch-up skips it and the author reads it once. | New test, your scenario: Claude suggests Redis and asks; you answer *No. Keep SQLite.*; Claude says *Understood*. Forwarding by the exchange gives the four messages with their exact ids and speakers, and your answer with the question it answered. Codex's prompt has your answer once. The re-check approves. Then your answer alone, named by its id, is forwarded from the next card. Fails with answers left out. |
| 3 | P2: Quoted parentheses cut a recommendation short. `use ')' as the closing token` came out as `use '`, and an escaped `\"` ended a quotation. | **Quotations are read whole** (`quoteEnd` in `src/protocol.mjs`): `` `code` ``, `"text"` (where `\"` doesn't end it), `'text'` and `‘text’`. An apostrophe inside a word (*don't*, *the owners'*) opens nothing, a single quote followed by a letter (*it's*) closes nothing, and a quote that's never closed is just a character. *Delimiter? (Recommended: …)?* no longer gives *Delimiter??*. | Parsing units: your example, an escaped `\"(\"`, an apostrophe beside a quoted `')'`, *the owners'*, curly quotes, and an unclosed `'tis`, each with the whole answer. The checkpoint parser too. Accepting through the desk: your delimiter question in chat, and an escaped-quote recommendation in a build, each send the whole recommendation. Both fail with single quotes not recognized, and with `\"` ending the quotation. |

**Two tests had been passing for the wrong reason, and now don't need to.** In the forwarding tests, the re-check's prompt quotes the forwarded discussion, so the fake agent matched an earlier chat rule and answered `TORYO: REPLY`. That counted as an approval: exactly finding 1. With the fix, they failed. I put the re-check's rule first, so the fake answers the check, and they pass for the right reason.

- `npm test`: 169 tests, all passing.
- The browser check passes, two runs out of two. The page didn't change this round.

## After approval: your P3 note

A question you ask a checker while it gives its verdict was answered, but the answer's turn dropped `verdictOnly`, so the check was asked for its verdict a second time. The turn's outcome now carries the flag (`#afterTurn`, `#carryOn`). A new test sends that question during the verdict-only turn. Claude answers it, the check is asked for its verdict once, and the card says no verdict came. Without the fix it fails. `npm test`: 170 tests, all passing.

## The owner's note N1: a session timeline and new sessions, added to the plan

The owner asked for a timeline in the sticky bar at the top of the room, showing how long each phase of the session took (build, review, test, plan). They also asked for a way to reset a room or restart its session, for example to plan the next sprint, and left it to me to work this into the plan where it makes sense.

- **Two new slices, right after Home.**
  - *Slice 10: Session phase timeline at the top of the room*;
  - *Slice 11: Start a new session in a room*.

  Slices 10–18 become 12–20, with every reference in the plan's text. They come after Home because Home completes the guard milestone the plan is built around. They come before the folder guard and worktrees, which are larger and don't depend on them.
- **A new section in the plan,** *Session timeline and new sessions*.
  - **The strip:** lanes for planning, building, reviewing and checks in the activity colors; totals in words; waiting for you and paused time shaded; long idle gaps folded; details on hover or tap; a list for the keyboard; a compact phone layout.
  - **The data:** where the times come from, including the few times the desk doesn't record yet (when a checks run starts; pauses, holds and resumes as structured events).
  - **New sessions:** what they keep and what they end.
- **Plain readings of the request, marked as proposals.** In the plan, `docs/decisions.md` and the README:
  - **"Top sticky bar":** the room's sticky header, since a session belongs to one room. If the owner meant the desk-wide top bar, it's the same strip there, showing the open room.
  - **"Reset":** it starts a new session and deletes nothing. Agents start fresh by default, earlier sessions fold in the room, and deleting a room is still how to remove one.
- **`docs/decisions.md`** records what the owner asked and why, and lists the placement and design as proposals open to the owner, not decisions.
- **README:** the *planned* section describes it as planned, not available.
- **Checked:** the plan still parses into slices (`parseSlices`: 20), each number is used once, and the new link to the decision entry matches its heading.

## What changed

### The check cycle (`src/engine.mjs`)

Every round is bounded: one check, then at most one answer from the author, then Ready.

| What starts it | Then |
|---|---|
| The plan is first written | The other planners check it, read-only (as before). If any asks for changes, the author addresses them once. Then Ready |
| You ask for changes (a written answer on the Ready card) | The author revises. With *Re-check after changes* on, the other planners check the revision once, then the author addresses their findings once. Then Ready |
| You forward a discussion (below) | The same as asking for changes |
| *Ask Claude to check it* (`plan-check`) | Those planners check the ready plan. Findings: the author addresses them once. An approval: Ready as it was |

- **State.** The plan keeps `revision` (one more each time the author writes or revises), `cycle` (`why`, `stage`: revise, check or address, the `checkers`, who is `asking` for changes, and the plan file's fingerprint when the check started), and `review`, which says how the last cycle ended. The old `revisions` counter is gone. A plan saved by an older desk, with no `cycle`, falls back cleanly: its checks are taken from `plan.checks`, and a revision in progress ends at Ready, "unchecked".
- **Never recursive.** The author's answer to a check ends the cycle (`stage: "address"` → Ready): nothing checks it. The author never checks its own plan, since the checkers are the planners minus the author (`#checkers`).
- **Read-only.** Checks are `plan-check` turns with `access: "read"`, as before. A checker's question comes back to that checker as a read-only turn: the plan's existing `retryReq` path.
- **A verdict, or none** (round 2). Approval needs an explicit `APPROVED` from every checker. A check without one is asked once for it alone, and is otherwise recorded as having none.
- **The Ready card** (`#planReady`) says, in a sentence, how the plan was last checked (`#reviewSentence`):
  - *Claude checked it and approved.*
  - *Claude checked it but didn't say whether it approves.* (after another checker's approval, or after *… addressed them.*)
  - *Claude asked for changes, and Codex addressed them.*
  - *Nobody has checked it since your change: Re-check after changes is off in this room.*
  - *There's no other planner here to check it.*
  - *The check was stopped before it finished.*

  If the plan file changed while it was checked, it adds: *That check was of an earlier version: the plan file changed while it ran.* The comparison is a SHA-256 of the file, taken when the check starts and when the last check is in. The card's question event now carries `checkers` and `revision`.
- **Bound to the card.** `plan-check` and `forward-discussion` name the Ready card (`questionId`) and take it off the waiting list before anything starts. A second click, or an older card, gets 409: *That plan has moved on: it's being revised or checked, or a newer version is ready.* Over HTTP, both need `questionId` (400 otherwise), like `retry` and `synthesize`.
- **Restart, holds, Stop, mode.**
  - **Restart:** the cycle is saved with the room. The turn cut off by the restart runs again on Resume, as any interrupted turn does, and the cycle carries on from the stage it was at.
  - **Holds:** a hold holds the check like any other turn; nothing is skipped.
  - **Stop:** the queue empties and a new flow starts, so a check finishing late moves nothing. *Resume* brings back the Ready card: *The check was stopped before it finished.*
  - **Switching mode:** the cycle's queued work is dropped, and a late result is stale.

### Forwarding a discussion (`forward-discussion`)

- **What goes.** Your exchange with one planner since the Ready card: your notes to that planner, your answers to its questions (round 2), and its finished replies. A client can instead name exact messages (`eventIds`). Those may only be your notes and answers and other planners' replies; each must be in the room, and they're put in timeline order.
- **How it's written.** It goes to the author as a change request: an owner event `kind: "change-request"`, `to: [author]`. It records `forwarded: [{ id, from }]`, the exact message ids and speakers.
  - Its text quotes each message under its speaker and id (`**The owner (to Claude)** [id]:`), with the status line taken off the planner's replies.
  - It adds, as the decision asks: *What the owner says there is the owner's; Claude's replies are a planner's suggestions, which count as decisions only where the owner agreed with them.*
- **Delivered once.** The author's catch-up skips the forwarded messages themselves (`#catchUpItems`), so each reaches it once: inside the change request.
- **Then the same cycle as asking for changes:** revise, re-check, address, Ready.

### The recommendation fix (`src/protocol.mjs`)

**`splitRecommendation(text)`** reads a `(Recommended: …)` up to its own closing parenthesis:
- It counts the parentheses it opens, and ignores any inside a quotation: `` `code` ``, `"text"` with `\"` inside, `'text'` or `‘text’` (round 2). Apostrophes aren't quotes.
- *Do X and Y (Recommended: yes to both)?* gives the question *Do X and Y?* and the recommendation *yes to both*.
- Without parentheses (*I recommend Z*), the recommendation runs to the end of the line, less a closing parenthesis left over from a wrapper and what follows it.

**Where it's used:**
- `parseQuestions` uses it, for the planning checkpoint.
- So do every question's `question` and `recommendation`: build, review, plan and chat (`questionIn`, `recommendationIn`). The status line's own recommendation comes first.

**`acceptRecommendation(rec)`** writes the answer: *Go with your recommendation: yes to both.* It never doubles the full stop, and adds none after `?` or `!`. Both acceptance paths use it: the room's (`answer`) and chat's (`#answerChat`).

### The setting

`recheckAfterChanges`, on by default (`DEFAULT_SETTINGS`, `sanitizeSettings`).
- It's in **Room** settings under *Planning*: *Re-check after changes: when you ask for changes to a ready plan, the other planners check the revision once, and the author addresses what they find.*
- The plan panel says *After your changes: the other planners check them once*, or *no check (Re-check after changes is off)*, or *no other planner to check them*.

### The page (`web/app.js`, `web/styles.css`)

- **The Ready card:** *Start building with this plan*, *Read the plan*, **Ask Claude to check it** (it names the card's `checkers`), and *Ask for changes*. The button is disabled while its request is on its way. A refusal re-enables it and shows why.
- **Under a planner's reply**, while the plan waits on its Ready card: **Send this discussion to Codex as a change request**. It's on that planner's latest reply after the card, and only there.
  - It takes the author (`from`) and the planners (`checkers`) from the card, not from the page's copy of the room. That copy can be a moment older: the browser check caught the button missing when the reply arrived before the room was fetched again.
  - The timeline is drawn again when a turn ends while a plan is ready, or when a Ready card opens or closes, so the button moves to the latest reply and goes when the card closes.
- **The change request** shows in the timeline as *Change request · You → Codex*. It can't be edited or withdrawn, like an answer.
- **On a phone** (under 760 px), a question's buttons and the forward button fill the card's width, at least 44 px tall, their words wrapping. Elsewhere, the forward button wraps instead of overflowing.

### A page fix found on the way: a room fetched again could bring back an answered question

**What happened.** The page fetches a room whole when you open it, and again (`refreshRoomSoon`) after any change to it. It then wrote every event it got back over its own copy. Some fetches left before an update, and came back after it arrived live. Such a fetch put the older copy back, and nothing corrected it afterwards.

**What I saw.** The browser check's step 5j failed now and then (*409 !== 200*): the first tab's note was tied to a question the desk had already closed. Logging showed the page reopening that very question after a fetch. The same could reopen a Ready card that had closed, so the forward button named a card that had moved on, and the desk refused it. That is the click that "did nothing" now and then in step 5q.

**Not new, but more frequent here.** The code is older than this slice. Ten runs of the last commit's check all passed. This slice's check, before the fix, failed 10 runs out of 18: five at 5j and five at 5q's forwarding. I can't say for sure why 5j loses the race more often with this slice; the race itself is the same.

**The fix** (`fetchView` in `web/app.js`):
- While a room is being fetched, the updates that arrive live are kept and laid over what the fetch brings back, with any events it missed.
- A refresh overtaken by a newer one is dropped.
- Every update also arrives live, so what is laid over is at worst a moment old, and the next update corrects it.

**The test.** Step 5r of the browser check makes it happen on purpose:
- a room is fetched again, and the desk's answer is held back;
- the question is answered from outside (the API, as a phone would), and the page shows it answered;
- then the held answer is let through.

The question stays answered. With the fix taken out, this step fails, two runs out of two. (With 5q left in, the run fails earlier, at 5q's forwarding.) With the fix, the whole check passed five runs out of six; the other run failed at step 5d (see *Worth a look*).

### Command line, MCP, API

- **`toryo plan check [--room R] [--question ID] [--checker claude]`**, and **`toryo plan forward [--room R] [--question ID] [--from claude]`**. `--from` can be left out when there's only one other planner.
- **The MCP tool `toryo_plan`**: `{ action: "check" | "forward", room?, question?, from?, checkers? }`.
- **Which plan:** both act on the only ready plan (in the room named, or in any room), or the card named. With several ready, they send nothing and list them with their ids.
- **An older desk** refuses with: *Toryo was started before this update, so it can't do that yet. Restart it first: toryo quit && toryo*.

## How to check

**`npm test`** (`node --test --test-concurrency=1 test/*.test.mjs`): 169 tests, all passing. `test/plancheck.test.mjs` is new. Each line below is one of its tests, against the plan's verification list:

| Plan's verification | Test |
|---|---|
| The exact sequence | You ask for changes: Codex revises, then Claude checks once, read-only (`--disallowedTools`), and sees your request. Claude asks for a fix, and Codex addresses it, the findings in its prompt. The plan is Ready again: *Claude asked for changes, and Codex addressed them.* One check of the change, none of the answer, `revision` 3, `cycle` null |
| Manual check; approving check; stale card; double click | *Ask Claude to check it* runs one more check. An approval leaves the plan as it was, with no revision. The same card a second time gets 409 |
| Setting off; no other planner | With the setting off, your change is revised and Ready: *Re-check after changes is off*. With one planner, the card lists nobody to check it (so the page shows no button), says there's no other planner, and `plan-check` is refused |
| The `(Recommended: yes to both)?` fixture; nested parentheses, quotes, punctuation | Parsing units |
| Room and chat acceptance | A build question and a chat question, each accepted, send exactly *Go with your recommendation: yes to both.* |
| Several checkers | Claude and Cursor both check once. Both findings reach Codex in one turn |
| A checker's question | It comes back to that checker, still read-only, and the cycle carries on |
| A check without a verdict (round 2) | One checker, then two: asked once for the verdict, never counted as approval, named on the card (above) |
| Forwarding your answers (round 2) | Your answer to the planner's question, forwarded with the question it answered, by the exchange and by its id (above) |
| Forwarding with exact ids and speakers | Two exchanges with Claude are forwarded: exact `forwarded` ids and speakers, the quotes, no status lines, and the owner/planner sentence. Forwarding the author's discussion is refused, and a second click gets 409. Codex's prompt has each message once. The same cycle follows: one check |
| File changed during checking | The plan file is edited while Claude checks it: the card says the check was of an earlier version, and the room says the file changed |
| Restart during the cycle; holds | The desk stops mid-check, after Claude has read the check, and starts again; Resume. With Claude held, the check waits (the stage stays `check`). Released, it runs again (*Toryo restarted while you were working*), then the author addresses it once |
| Stop; mode replacement; late callbacks | Stop during a check: the late result starts no revision, and Resume brings the card back (*stopped*). Switching to chat during a check: the late result changes nothing, and nothing waits |
| Page, API, CLI and MCP | Over HTTP, both actions without `questionId` get 400. `client.plan(…, "check")` with one plan ready, then the same card named again: refused. The HTTP 409 too. MCP's `toryo_plan` forward without `from`: sent, and a second call has no plan to act on |

**The browser check passes** (five runs out of six; see *Worth a look*). Its new step 5q, in a real browser:
- *Ask Claude to check it* is on the card. A double click sends one request, and the plan is Ready again after one more check.
- You write to Claude; its reply has *Send this discussion to Codex as a change request*, on that reply only. Clicking it sends one request. *Change request · You → Codex* appears, the button goes, and the plan comes back revised and checked, with `forwarded` from the owner and Claude.
- **Room** settings show *Re-check after changes*, ticked. Unticked and saved, the plan panel says so.
- At 390 and 320 px: nothing scrolls sideways, and the card's four buttons and the forward button are inside their cards, each at least 44 px tall.

**The screenshot script passes.** It adds a ready plan talked over with Claude (*Export plan*), in light and dark at 1440 and 390, and in light at 320 and 390 high. The script checks every text on screen for contrast and that nothing scrolls sideways.

**Each safeguard, removed in turn, fails its test** (mutations in a copy of the tree). In the desk:
- a check of the author's answer;
- forwarded messages delivered again;
- the old recommendation parsing;
- no stale check;
- the setting ignored;
- an older card accepted;
- Resume not bringing the card back;
- findings not sent to the author;
- no verdict counted as approval, or no request for it (round 2);
- your answers left out of a forwarded discussion (round 2);
- single quotes not recognized, or `\"` ending a quotation (round 2).

On the page:
- With no double-click guard, a double click on *Ask Claude to check it* sends two requests (*a double click asks once*: 2 !== 1).
- With no protection from a late refresh, step 5r fails (above).
- Built from the page's copy of the room, the forward button was missing in three of four repeated runs of step 5q (six rounds a run, each run stopping at its first failure, which came in its first or second round). Built from the card, two runs of six rounds pass.

## Worth a look

- **One browser check run failed at step 5d**, the planning checkpoint: *Accept all recommendations* recorded Codex's question only, as if Claude's proposal had been missed when the questions were gathered. It happened once in about 35 runs and didn't come back.
  - This slice changes how each question line is read (`parseQuestions`), but that reading doesn't depend on timing, and Claude's same line is read correctly in every other run.
  - What gathers the proposals is unchanged: `#checkpoint` in `src/engine.mjs` picks the round's turns by their start time.
  - I've left it as it is; worth knowing if it comes back.
- **A plan saved by an older desk.** A plan mid-revision when the desk restarts onto this version ends Ready, "unchecked". A plan mid-check finishes its check as before, then follows the new cycle.
- **Who sees a change request.** It's addressed to the author. The other planners see it on their next turn, *for your information*, as with any note to someone else. So the checker of a forwarded change sees what was asked.
- **Forwarding only your notes.** If the planner hasn't replied yet, the command line can still forward your notes alone (*these notes*). The page offers the button only under a reply.

## What remains

Nothing in this slice. Slice 7 (threshold guard, reset release, and phone controls) is next; the session timeline and new sessions are Slices 10 and 11.
