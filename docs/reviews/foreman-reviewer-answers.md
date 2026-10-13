# Foreman: an answer to a reviewer's question goes back to the reviewer

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Why:** Codex's nonblocking note in the final review, which the owner accepted: “that sounds reasonable to me? Let's build it.” It is recorded as an owner decision at the end of `docs/decisions.md`, and the README's *When you're asked* paragraph says it in plain words.
**Tree:** still entirely uncommitted. This change is small and on top of the approved state.

## What changed

- **`src/engine.mjs`**
  - `#resolveWaiting`: a `review-owner` answer no longer starts a builder turn. It queues a `review-answer` turn for the reviewer who asked (`w.from`), read-only, carrying `final` from the review that asked. The question records `final` when it's raised in `#afterBuild`.
  - `review-answer` joins `REVIEW_KINDS`, so its verdict is handled like a review's: APPROVED completes the plan only if `final` is set, otherwise it approves the slice. CHANGES counts a round, and OWNER asks again. No status gets the usual status-only follow-up.
  - A pending swap doesn't move it: reviews keep their reviewer until the next building turn. Auto-routing already sent a typed answer to the asking agent.
- **`src/protocol.mjs`**: `prompts.reviewAnswer`. The owner answered, so the reviewer finishes its (final) review with findings, stays read-only, and gives a verdict from the usual review status lines.
- **`web/app.js`**: the turn label “Review, after your answer”.

## Tests (`engine.test.mjs`)

- **“an answer to the reviewer's question goes back to the reviewer, which finishes its review”**
  - A plain reply is routed to the reviewer.
  - The turns are `build:REVIEW`, `review:OWNER`, `review-answer:APPROVED`, `build-next`.
  - The answer is in the reviewer's prompt, the turn is read-only (`--disallowedTools`), and the slice is approved.
- **“an answer during the final review lets the reviewer complete the plan”**: accepting the reviewer's recommendation during the final review gives a `review-answer` with “Finish your final review”, and its approval completes the plan.

```
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
for f in bin/*.mjs src/*.mjs src/agents/*.mjs web/*.js test/*.mjs; do node --check "$f"; done
node --test --test-concurrency=1 test/*.test.mjs     # 62 tests, ~26 s
node test/ui-check.mjs                               # passes; needs playwright-core
```

## Round 2: Codex's finding (questions waiting from before the upgrade)

A `review-owner` question saved by the previous version has no `final`, so its answer was treated as a slice review: approval started `build-next` instead of completing the plan. The previous version kept final-review intent only in `room.build.final`. `#recover` now fills it in from there for everything saved before requests carried it:
- waiting `review-owner` and `gates` questions (and any `retryReq`);
- queued reviews, status follow-ups and checks;
- reviews interrupted by the restart;
- running checks (`activeGate`);
- the Codex app's kept turn.

Anything that already has `final` is left alone.

Test (`engine.test.mjs`): “after an upgrade, an answer to a question from the final review still completes the plan”.
- **Your reproduction:** `DONE`, final review asks, the question saved without `final`, restart, answer, the reviewer approves. The plan completes and no `build-next` runs.
- **A final review cut off by the restart:** its request was saved without `final`, and it comes back queued with `final: true`.

Both fail on the previous code. `node --test` now runs 62 tests, all passing; the browser check passes too.

## Unchanged on purpose

- Questions from the builder, round limits and nudges still go to the builder.
- A planner's question still re-runs that planner's step with the answer.
