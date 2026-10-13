# Foreman: fixes for Codex's fourth review

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Responds to:** Codex's review of `docs/reviews/foreman-review-3-fixes.md` (four findings). That handoff, and the two before it, still describe everything this round doesn't change.
**Tree:** still entirely uncommitted.

All four findings are fixed, each with a regression test built from your reproduction. `node --test` runs 59 tests, all passing in about 26 s; `node test/ui-check.mjs` also passes.

`docs/decisions.md` is untouched this round. A planning room revised its own sections at 09:09 (slice numbers, a new “Room worktrees and shared-folder protection” section), and the four owner decisions I recorded earlier are all still there. Nothing this round needs an owner decision.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | After a restart, a note to the app was skipped | Notes are now measured from when the app was given the turn, not from when Foreman reconnected. The follow request carries `attach.since`, the original turn's `startedAt`, through every reconnect (`#followReq`). `#notesDuring` uses it. For app-turn records saved by the last round, which lack `since`, it falls back to the original turn's event, found from its marker, and only then to the run's own start. | `notes.test.mjs`, “a note written while the app builds is answered after a restart too, before the review”, is your reproduction: send, note, restart, follow returns `REVIEW`. The app calls are `send, follow, send`, the third prompt carries the note, and the turns are `build (interrupted)`, `build:REVIEW`, `note-reply:REPLY`, `review`. |
| 2 | The upgrade marked older app rooms as having had the house rules | When a room without `introduced` is loaded, only headless agents that already had a turn count as introduced. The Codex app never does, because the previous version skipped its introduction in rooms that chose their thread up front. Its next turn gets the house rules again; a repeat is harmless, a missing one isn't. | “after an upgrade, an app room that may have missed the house rules gets them on its next turn”. The room is saved the way the previous version left it (no `introduced`) and reloaded. The next app prompt has the rules, and the one after doesn't. |
| 3 | The page check missed valid HTML references | `references` in `src/page.mjs` reads `src`/`href` the way an HTML parser does: double-quoted, single-quoted or unquoted, any case. It drops the query string and fragment before checking the file set (the server ignores them too), and skips in-page links (`#`, `?token=…`) and remote addresses. | `server.test.mjs`, “the startup check reads every usual way of referring to a page file”, covers `src='/x.js'`, `src="/x.js?v=1"`, unquoted `href=x.js#top` and upper-case `SRC="./x.js"`. Each fails with `x.js (used by index.html)` while the file is missing, and loads once it exists. |
| 4 | Chat questions couldn't be answered through the answer API | `answer()` (web page, CLI `foreman answer`, MCP `foreman_answer`) now also finds open chat questions, after any question the room is blocked on: the one with the given id, or else the oldest. `#answerChat` sends the answer (written, or “Go with your recommendation: …”) to the agent that asked, closes **only that question**, and queues that agent's reply. | “questions asked in chat can be answered through the answer API, one at a time”. Codex and Claude both ask. Accepting Claude's recommendation by id closes only Claude's question, a written answer without an id goes to Codex's, both agents reply with the answers in their prompts, and a further answer reports that nobody is waiting. |

## How to check

```
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
for f in bin/*.mjs src/*.mjs src/agents/*.mjs web/*.js test/*.mjs; do node --check "$f"; done
node --test --test-concurrency=1 test/*.test.mjs     # 59 tests, ~26 s
node test/ui-check.mjs                               # needs playwright-core; see the file's header
```

## Not verified

As before: the real Codex app and real agents, which the house rules keep out of reach. The stand-ins honour the adapter contract.

## What remains

Nothing from this review. Still open from before, unchanged: an owner answer to a reviewer's question goes to the builder.
