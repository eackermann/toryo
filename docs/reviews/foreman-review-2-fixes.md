# Foreman: fixes for Codex's second review, and the owner's room-owned app thread

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Responds to:** Codex's review of `docs/reviews/foreman-review-1-fixes.md` (nine findings), and the owner's two messages in the same round: the Codex app thread belongs to the room, and status icons in the room list.
**Tree:** still entirely uncommitted. The first round's handoff, `foreman-review-1-fixes.md`, still describes everything this round doesn't change.

All nine findings are fixed, and the owner's thread request is implemented in full. `node --test` runs 47 tests (all pass, ~25 s). A new browser check, `test/ui-check.mjs`, passes too.

## A mistake I made and repaired this round

I overwrote `docs/decisions.md` without reading it first. A planning room in this desk had written it between 08:17 and 08:31, while I worked. I restored it from Foreman's own snapshot of that time, reading `~/.foreman/shadow/foreman.git` with `GIT_OPTIONAL_LOCKS=0`, so nothing there was written. No turn touched the file after that snapshot. The restored text is identical to the snapshot, and I appended the owner's thread decision in that file's own format. Please check that the "Home and desk-wide controls" section reads as its planning room left it.

## The owner's request: each room owns its Codex app thread

| Part | Where |
|---|---|
| Thread chosen at creation and stored in `room.sessions.codexapp`. Order: the one asked for, then the project's default (`project.agents.codexapp.thread`), then the global default. A room with the Codex app can't be created without one. | `engine.mjs:433` `#appThreadFor`, used by `createRoom`, by adding the app to the crew, and by asking it for a second opinion |
| The room's thread always wins: the adapter uses `sessionId ?? cfg.thread`, and the engine passes the room's thread as the session. Older rooms are pinned on load to the thread they were effectively using, so a later Settings change can't move them. | `codexapp.mjs:165`; `#recover` |
| Starting from the builder's finished round reads the room's thread. | `#handoffFor(…, thread)` from `createRoom` and `startBuild` |
| The thread changes only while the app is idle in the room (nothing running, queued or followed). | `case "app-thread"` (`engine.mjs:745`), `#appBusy` (`:447`) |
| Sharing. Giving a room a thread the app is working in for another room is refused. Sharing with an idle room is allowed, with a warning in the room. At run time only one room's app turn runs per thread (`#appThreadWorking`, `:964`); the others wait and start when it ends. | `#appThreadFor`, `#warnSharedThread` |
| Page. The New room form shows a thread picker whenever the Codex app is in the crew, preselecting the project's default, else the general one, and naming other rooms on that thread. Settings has "Default thread for new rooms" and a per-project default. The crew card shows the room's thread, links to it, and has *Change thread* (disabled while busy). Adding the app from the crew card asks for its thread. | `web/app.js` `appThreads`, `appThreadSheet` (`:860`), the New room and Settings forms |
| CLI `--thread`, MCP `appThread`. | `bin/foreman.mjs`, `src/mcp.mjs`, `src/client.mjs` |
| Detection: the app counts as installed once `codex.exe` is found. A default thread is no longer required, since rooms choose their own. | `codexapp.mjs` `detect` |
| Recorded as the owner's decision in `docs/decisions.md` and in the README's Codex app section. | |

Tests (`test/appthread.test.mjs`) use the real adapter with a stand-in `codex.exe` and per-thread logs:
- Two rooms on different threads; changing the default afterwards doesn't move the first room. The `--thread` log is `[A, B, A]`.
- The project default beats the general one; an explicit choice beats both.
- Review-first reads the room's thread.
- A thread the app is busy in for another room is refused, a busy room's thread can't be changed, and sharing with an idle room warns.

## Codex's findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | App threads were global | See above. | See above. |
| 2 | Swapping while paused caused self-review | The swap is immediate only when no round is open. A round is open when anything in the current run is running, a check or review is queued, or a question is waiting (`#roundOpen`, `engine.mjs:889`). Otherwise the swap is pending and applies in `#enqueueBuilder`, before the next building turn. `#swapRoles` re-addresses only a queued building turn, never a review. | `engine.test.mjs`: “a swap while a finished round waits for its review…” is your reproduction (build, pause, `REVIEW`, swap, resume). The queued review stays with Claude, and Claude builds the fix. |
| 3 | A stop during preparation could still submit an app turn | The engine skips `adapter.run` if the turn was stopped while its before-snapshot was taken (`:1080`). The adapter also re-checks both signals immediately before `codex queue` (`codexapp.mjs:189`). | “a stop while a Codex app turn is being prepared sends nothing to the app” slows the snapshot and stops during it; the adapter is never called. `codexapp.test.mjs` checks that an already-aborted signal queues nothing. |
| 4 | A restart could lose a stopped app turn | Accepted app work now has its own persisted list, `room.following`, separate from the run queue. A turn counts as accepted once the adapter reports `onSubmitted` after `codex queue` succeeds, recorded on the turn event as `submitted`. Recovery moves accepted app turns into `room.following`; one never handed to the app is offered again like any other turn. `#pump` follows them before checking pause and stop (`:939`), and `#newFlow` never drops them, so new app work waits until they end or are abandoned (second Stop). A crash after submission retries by following, not resending (`:1013`). | “a stopped Codex app turn is still followed after a restart, and holds back new work…” is your reproduction (send, Stop, restart, new build). The calls are `send, follow`, the new build's `send` comes only after the followed turn ends, and that turn's result drives nothing. |
| 5 | An app timeout released the protection | The adapter no longer returns on timeout. It notifies once (“has run past N min… press Stop twice to stop waiting”) and keeps following the same marker (`codexapp.mjs:221`). Only abandonment or shutdown ends following. | `codexapp.test.mjs`: “…a long one is only reported, never dropped” (a 200 ms limit, the reply arriving at 600 ms, one notification, the reply returned). |
| 6 | A gate fix could complete the plan without a final review | Completion is tied to the request: review requests carry `final`, and only approving a `final` review completes the plan (`:1341`). Final intent carries through the checks: the checks request, the gate-fix turn and the “checks still fail” question all carry `final`. A `REVIEW` from such a turn leads back to the final review (`:1319`). | “fixing the checks after DONE leads to the final review, even when the fix says REVIEW” (your sequence; the second review prompt is the final one). “only approving the final review completes the plan” (final review `CHANGES` → fix `REVIEW` → ordinary approval → not done; the builder continues). |
| 7 | Concurrent stale-lock recovery allowed two desks | On Linux the lock is now an abstract Unix socket named after the data folder (`src/store.mjs:55`). Only one process can listen on it, and the kernel frees it when that process ends, so nothing is ever stale and there's nothing to reclaim. Contenders ask the holder for its pid over the socket. `desk.lock` is now only an informational pid file. Off Linux the old file lock remains, marked best effort in its comment; Foreman runs on WSL. | `tools.test.mjs`: four processes start at once with a dead desk's pid file present. Exactly one wins, the others are told the winner's pid, and the lock is free once the winner exits. The two-desk end-to-end test still passes. |
| 8 | Timed-out checks could pass | `runShell` reports `timedOut`, and a check passes only if `code === 0 && !timedOut`. The failure report sent to the builder says “timed out”. | `tools.test.mjs`: your `trap 'exit 0' TERM` loop exits 0 but fails as timed out. |
| 9 | Settings dropped `timeoutMin` | Each check row keeps the whole check it came from (`data-gate`), and adds a visible *minutes* field. Saving merges the edited fields, so editing, deleting and reordering rows keep each check's own settings (`gateFromRow`, `app.js:1159`). The page now uses the saved config at once instead of waiting for the next push. | `test/ui-check.mjs` (below): an unchanged Settings save keeps `timeoutMin: 45` byte for byte in `config.json`. |

## The owner's sidebar suggestion

Implemented as Codex recommended, with the owner's icons:
- **Working rooms:** each working agent's initials chip plus a task icon (🔨 building, 👓 reviewing or checking the plan, 📝 proposal or writing the plan, 🔍 critique, 💬 chat, 🧪 checks).
- **Other rooms:** a distinct state icon: ✋ waiting for you (with “needs you”), ⏸ paused, ⏹ stopping or stopped, ✓ done, ⏳ starting, 💤 idle.
- **Text alternatives:** each room has a plain-text tooltip (“Codex is building · build room”) and a screen-reader text.

The data comes from a new `working` list in the room summary (`engine.mjs` `summary`); the rendering is `roomIndicator` (`app.js:323`). Reduced motion turns off the pulse.

## How to check

```
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
for f in bin/*.mjs src/*.mjs src/agents/*.mjs web/*.js test/*.mjs; do node --check "$f"; done
node --test --test-concurrency=1 test/*.test.mjs     # 47 tests, ~25 s
node test/ui-check.mjs                               # needs playwright-core; see the file's header
```

`test/ui-check.mjs` starts its own desk on a free port with a temporary data folder, the fake agents and a fake Codex app (a fake thread database built with `node:sqlite`, fake logs and a no-op `codex.exe`), so neither the real app nor the running desk is touched. It checks:
- The Settings save keeps the time limit, and the project's default thread is saved.
- The New room form preselects the project's thread.
- The crew card shows the room's thread and link, and disables *Change thread* while busy.
- The room list says “Codex app is building”, with no console errors and no request outside the desk.

It skips itself if Playwright isn't found.

## Not verified

- The real Codex app, for everything above; the house rules forbid touching it. The adapter's contract (send once, follow by marker, `onSubmitted` after `codex queue` succeeds) is tested with stand-ins.
- The abstract-socket lock on anything but this WSL2 kernel. Abstract sockets are standard Linux; the fallback elsewhere is the old file lock.
- Read-only mounts with real agents: unchanged from the last round.

## What remains

Nothing from this review. Unchanged and still worth a later look: an owner answer to a reviewer's question still goes to the builder.

The planning room's plan (`docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`) overlaps with this round in two places, both consistent with it:
- “one outstanding Foreman submission per actual app thread” (done here at run time);
- “Fix and verify Swap so queued work follows roles” (queued building turns follow the swap; queued reviews keep their reviewer, which is what stops self-review).
