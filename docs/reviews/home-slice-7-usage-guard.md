# Home and desk controls, Slice 7: threshold guard, reset release, and phone controls

**Author:** Claude, 13 Oct 2026
**Reviewer:** Codex
**Plan:** `docs/plans/plan-a-home-view-for-foreman-and-desk-wi.md`, Slice 7, with its behavior contract: *Usage guard and reset*, *Release and pause a guard until reset*, *Dispatch and persistence*. The owner's choices are in `docs/decisions.md` (*Guard activation confirmed after review*, *Accepted plan review and worktree defaults*).
**Tree:** uncommitted on top of Slice 6 (`95c560b`).
- **New:** `src/guard.mjs`, `test/guard.test.mjs` and this handoff.
- **Changed:** `src/engine.mjs`, `src/desk.mjs`, `src/usage.mjs` (exports `windowLabel`), `src/store.mjs` (`appendLine`), `src/client.mjs`, `src/mcp.mjs`, `bin/toryo.mjs`, `test/fake-agent.mjs`, `test/helpers.mjs` (engine options for tests), `test/desk.test.mjs` (a reset now writes version 2), `README.md`.

Once approved, I'll commit only those. The untracked `design/toryo-vector-review-package/` belongs to another room and stays out. Nothing needs an owner decision: the defaults are the owner's.

**Restart:** none of this is live until the owner restarts the desk (`toryo quit && toryo`). After the restart:
- `~/.toryo/desk.json` becomes version 2, with the guard on at 90% of the 5-hour and weekly windows, released at reset. Your holds and Pause everything stay as they are. An older Toryo can't read a version 2 file; it refuses it (nothing new starts) rather than dropping the guard.
- The guard applies at once to the latest readings. The running desk's readings now (read with a GET) are Codex weekly 23%, Claude 5-hour 24% and weekly 41%, so nothing would be held straight away.
- `toryo status` shows the note about the guard until `toryo guard ok`.
- `toryo pause --all`, `toryo hold`, `toryo release`, `toryo guard`, and the MCP tools `toryo_desk` and `toryo_guard` exist.

## Round 3: your finding

| Finding | Fix | Test |
|---|---|---|
| P2: A rule given again unchanged still counted as changed. With automatic release off and the weekly hold waiting for you, `toryo guard codex --five-hour 80 --weekly 90` ended the weekly hold. | **`setPolicy` returns only the window types whose rule really changed:** turned on or off, or a different threshold. A rule for a window that had none counts as a change. Only those are looked at again as a settings change. | The round-2 test goes on. The weekly hold waits for you after its reset. The weekly rule is given again as it was: alone (`weekly` at 90), beside a 5-hour change (`5-hour` at 85 with `weekly` on at 90), and as "all rules on". After each, the weekly hold is still waiting and still holds. Units: a rule given again changes nothing, a new threshold does, a first rule for `weekly-opus` does, and automatic release on its own changes no rule. Both tests fail without the fix. |

- `npm test`: 193 tests, all passing.

## Round 2: your five findings

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | P1: A hold whose save failed was gone after a restart. The reading was saved, but re-reading it isn't fresh, so nothing held. | **On every start, the guard looks at the latest saved readings** before any room recovers (`#loadDesk` → `#guardAllReadings`, then the resets). This now covers existing desks, not only new and migrated ones. Your rules and exceptions stay as they are. A hold that ended isn't brought back: the same readings and rules end it again (the window reset, a lower reading, a rule you changed). | Saving desk.json fails while Codex reads 95%: held in memory, and the file has no hold. After a restart before the reset, Codex is held again before anything starts, and the hold is saved. Then an exception you set survives a further restart. Fails without the fix. |
| 2 | P2: Changing one window's rule ended another window's hold (every rule was looked at again, as a settings change). | **Only the rules you changed are looked at again.** `setPolicy` returns the window types it changed, and only those go back to `evaluate` with `settings`. Automatic release on its own changes no rule. | With automatic release off, Codex's weekly hold becomes ready at its reset, and a low reading of the new window leaves it waiting. Then the 5-hour threshold changes: the weekly hold is untouched and still holds. Fails without the fix. |
| 3 | P2: A refused change still changed the policy in memory, and the next successful action saved it. | **Everything is checked before anything changes.** `setPolicy` works out the whole new set of rules, then applies it. The engine applies every allowance's change to a copy of the guard, and adopts it only if all of them are accepted. As a backstop, any refused desk action now restores the controls exactly as they were. | Three refused changes: one allowance with one rule off and one at 101%; every allowance at 0%; an unknown window. The policies are unchanged, and after a later hold is saved, desk.json has no policy. Fails with the changes made in place and nothing restored. |
| 4 | P2: `--window 5-hour --at 80` saved a rule for `5_hour`, which no reading uses. | **Rules are keyed by the window they name:** `setPolicy` reads each name with the shared `guardWindow`, so `5-hour` is `five_hour` and `weekly-opus` is `weekly_opus`. The command line now passes the window as typed. | A rule set as `5-hour` at 80% is the `five_hour` rule, and an 85% reading holds. On the command line, `--window weekly-opus --at 90` sets the Opus rule that a reading then holds by (next test). Fails without the fix. |
| 5 | P2: For a window of its own with no known reset, Release offered `toryo guard claude --weekly-opus off`, which the command line doesn't take. | **One way to write a rule-off command** (`#ruleOffCommand`): `--five-hour off`, `--weekly off`, or `--window <name> --at off` for any other window. It's used by Release's offer and by the refusal to pause a guard with no known reset. The offer's MCP arguments name the window as typed too. | Claude's weekly Opus rule, and a 96% reading with no reset. The offer is `toryo guard claude --window weekly-opus --at off`, and the refusal names the same command. The command, run exactly as offered, ends the hold. With the rule back on, the offer's MCP arguments, run as given, end it too. Fails with the old command. |

- `npm test`: 193 tests, all passing. `test/guard.test.mjs` has 23.
- The browser check passes.

## What changed

### The guard (`src/guard.mjs`)

Plain functions on the guard's state, with the time passed in, so a test's clock decides everything.
- **Policy per allowance.** Each allowance (Codex's, shared by headless Codex and the Codex app; Claude's; …) has rules per window type: `{ enabled, at }`, and `autoRelease`. With nothing saved, it's the owner's default: 5-hour and weekly at 90%, released at reset. A saved policy is yours and stays as you set it. Other windows (such as `weekly_opus`) are guarded only if you add a rule for them; they're never folded into the weekly one.
- **Holds** (`holds["openai:weekly"]`): created when a fresh reading is at or over the threshold (90% holds, 89.9% doesn't). Each records the percentage, threshold, reset time, since, the reporting agent, and `holding` or `ready`.
  - **A reading of a window that has already reset holds nothing:** a late report.
  - **A fresh reading under the threshold ends a hold:** a new window, which is the only way a hold with no known reset time ever ends. With automatic release off, it marks the hold `ready` instead.
- **Expiry** (`expire`). A hold whose window has reset ends, with no new reading needed. With automatic release off, it becomes `ready` and keeps holding until you release it. Turning automatic release back on lets a ready hold go.
- **Exceptions** ("pause this guard until reset"): `exceptions[key] = { until: <that window's reset>, at }`. The allowance runs until then. A hold that ends takes its exception with it, so after the reset the guard watches the new window.
- **Settings changes** (`setPolicy`, then `evaluate` with `settings`) look again at the changed rules only. A rule turned off ends its hold. A threshold raised above the reading ends it, even with automatic release off: you changed the rule. A lowered one can create a hold from the latest reading still in its window.
- **Parsing** (`parseGuard`): strict. Anything invalid makes the whole desk file a problem (nothing new starts) rather than dropping a hold.

### desk.json version 2 (`src/desk.mjs`)

- **Shape.** Version 2 adds `guard: { notice, policies, holds, exceptions }`.
- **Migration.** A version 1 file is read with the default guard and its notice, and saved as version 2 (`migrated`). Its holds and pause stay.
- **New desks and resets.** A missing file gets the same defaults. A reset (of a file Toryo can't read) starts a fresh version 2 desk, guard included.

### The desk (`src/engine.mjs`)

- **A clock.** `new Engine({ now })`: the guard decides by it (the usage book too). `guardPollMs` (30 s) is the timer that looks at resets; tests set it to 0.
- **Readings.** `#setLimits` passes the windows a new measurement reported to the guard (`#guardReading`). It looks at the allowance's best reading of each window (`UsageBook.groupView`), so a lagging reading from the other Codex interface doesn't undo a fresher one. A reading Toryo already had (the same log line) changes nothing. This covers every source:
  - Codex's logs, read every 5 minutes;
  - Claude's live stream during a turn;
  - Codex's session log after a turn, failed or not.
- **On every start** (round 2), and after a reset, the guard looks at the latest saved readings straight away (`#guardAllReadings`). On a desk that has just switched it on, a reading already over 90% holds at once, rather than waiting for a fresh one; for Claude, that would only come once a turn had started. On any desk, a hold Toryo couldn't save before it stopped comes back.
- **Resets** are decided:
  - when Toryo starts (`#loadDesk`, before any room recovers);
  - at the start of every scheduler pass (`#schedule` calls `#expireGuards` in its loop), so nothing starts before a passed reset is decided;
  - on the timer (`checkGuards`).

  A desk that slept through a reset decides the same as one that didn't.
- **Holding work up.** `blockersFor` adds a reason for each guard hold on the request's allowance: *Claude's 5-hour limit is at 92% (the usage guard holds at 90%) until it resets Tue 14 Oct, 09:00*.
  - **Shared with the existing controls:** the scheduler, the room's *Held* status, its *Waiting: …* note and the rings all use the same reasons.
  - **Not held:** Toryo's own checks are never held by the guard, and following a Codex app turn the app already has never is.
  - **Retries:** an automatic retry is a queued request like any other, so it waits too.
- **Saving.** Every guard change is saved to desk.json. If that fails, the change applies anyway, and `deskProblem` (unsaved) holds everything until it's saved. A release the guard can't save never lets work through.
- **Notifications, once per change of state:** holding an agent; a hold ended by its reset or by a reading under the threshold; a reset waiting for you. Not per room held up, and not on a polling pass that found nothing new. Changes you make aren't notified. Every change goes to `~/.toryo/desk-events.jsonl`, the journal Home's *Recent* will read.
- **Desk actions** (`deskControl`, so `POST /api/desk`):
  - `release` releases your hold, then says what the guard still holds, window by window, with offers: `{ text, command, mcp: { tool, arguments } }`.
    - **A known reset:** `toryo guard codex --window weekly --pause-until-reset`.
    - **A ready hold:** `--release-expired-hold`.
    - **No known reset:** turning that rule off (`--weekly off`), since there's no reset to pause until.
    - **Not held by you:** releasing an agent you don't hold isn't an error when the guard holds it; it answers *You don't hold Codex… The usage guard still holds…*.
  - `guard`: rules for one agent's allowance or every one (`rules`, `autoRelease`, `enabled`). It answers with the new policy in a sentence and any holds that ended. It also counts as having read the notice.
  - `guard-pause`: one window, until its reset. It's refused when the reset isn't known (with the rule-off command) or has passed (with the release command).
  - `guard-release`: only a hold whose window has reset. Before that, it's refused, with the pause command.
  - `guard-ok`: hides the notice.
  - `resume` also says what the guard still holds.
- **What the page and tools read:** `deskView().guard` gives the notice, each allowance's policy (name, agents, rules), the holds (reason, exception) and the exceptions.

### Command line and MCP (`bin/toryo.mjs`, `src/client.mjs`, `src/mcp.mjs`)

- **Command line:**
  - `toryo pause --all` and `toryo resume --all`; `toryo pause <room>` still pauses one room.
  - `toryo hold <agent> [--headless]` and `toryo release <agent> [--headless]`.
  - `toryo guard` shows what the guard does and holds, with the command past each hold.
  - `toryo guard [agent] --five-hour N|off --weekly N|off [--window W --at N] [--auto-release | --no-auto-release] [--off | --on]`.
  - `toryo guard <agent> --window W --pause-until-reset | --release-expired-hold`.
  - `toryo guard ok`.
- **`toryo status`** starts with the desk: the guard's note while it's new, Pause everything, your holds, and each guard hold.
- **MCP:**
  - `toryo_desk`: `{ action: pause | resume | hold | release, target, headless }`.
  - `toryo_guard`: `{ action: show | set | pause-until-reset | release-expired-hold | ok, target, window, fiveHour, weekly, rules, autoRelease, enabled }`. With nothing to change it shows; with rules it sets. So an offer's own `mcp.arguments` work as given.
- **An older desk** (not restarted since this update) refuses guard actions with *Toryo was started before this update… Restart it first*.

### The fake agent (`test/fake-agent.mjs`)

- **Usage before a failure.** A Claude rule with `fail` and `rateLimit` reports the usage, then fails, as a real turn can.
- **Codex's usage.** A Codex rule with `codexUsage` (`{ primary, secondary }`, as Codex logs them) writes it to the session's log under `CODEX_HOME`, where Toryo reads it after the turn.

## How to check

**`npm test`:** 193 tests, all passing. `test/guard.test.mjs` is new (23 tests, five of them from round 2). Against the plan's verification list:

| Verification | Test |
|---|---|
| Equality at 90% | 90 holds, 89.9 doesn't |
| Simultaneous windows; one resetting while the other remains | Claude's 5-hour and weekly windows both hold. The 5-hour one resets, and the weekly one still holds |
| Late expired reports | A reading of a window already reset holds nothing (on the rules, and on the desk) |
| Sleep; restart past reset | A desk whose clock jumps past the reset releases before starting the next room's turn, with no timer. A desk stopped, then started after the reset, has no hold left (desk.json too) |
| No fresh Claude report | The 92% hold ends at the reset with no new reading |
| Missing reset | Held. Time never releases it. A pause until reset is refused, with the rule-off command and MCP arguments. A fresh reading under the threshold ends it |
| Auto-release disabled | The reset makes it `ready` and still held (notified once). Release is refused before the reset, accepted after. Turning automatic release back on lets a ready hold go |
| Failed persistence | A hold that can't be saved holds in memory, and everything waits until it's saved (`save`) |
| Shared Codex scope | A reading from either interface holds both. A Codex turn whose session log says 91% weekly holds both as soon as the turn ends. Claude isn't held, and neither are the checks |
| Manual holds overlapping guards | Your hold on Claude and the guard's: after the reset, still held by you, and the work goes once you release it |
| Settings changes | A threshold raised above the reading ends that hold. The guard turned off ends them all. Neither is notified, and both are journaled |
| Timed guard exceptions | Pausing each window until its reset unblocks Codex. The exceptions survive a restart. After the reset, a new window over the threshold holds again |
| The 92%-then-fail retry | A Claude turn reports 92% and fails. Its automatic retry waits (*Retrying once*, then *Waiting: Claude's 5-hour limit…*), runs after the reset and your release, and runs once: two Claude calls in all |
| Initialization; one notice; migration | New desk: version 2, defaults, notice. `guard-ok` sticks across restarts. A version 1 desk keeps its hold and gets the defaults and notice. A reading already at 95% holds at once when the guard is switched on. Your settings (Claude off, Codex weekly 95%, automatic release off) survive a restart |
| HTTP / CLI / MCP, and an actionable Release per window | On a temporary server: <ul><li>the command line's note, `guard`, `guard ok`, `pause --all`, `resume --all`, `hold`;</li><li>two guard windows, then `release codex`, which gives both windows' commands and MCP arguments;</li><li>the same release over HTTP (`offers`) and over MCP (the same text);</li><li>an offer's own MCP arguments run as given;</li><li>MCP `toryo_guard` show and set; the command line `--weekly 95 --no-auto-release`;</li><li>a bad threshold and an unknown agent refused.</li></ul> |

Plus the guard's units: a hold per window, expiry, exceptions, settings, and the version 1 and 2 files (invalid ones refused).

**Each safeguard, removed in turn, fails its test** (mutations in a copy of the tree):
- resets decided only on the timer;
- the guard missing from the blockers;
- late readings of reset windows holding;
- no guard applied when it's switched on;
- Release without the offers;
- automatic release never happening;
- a hold with no known reset released by time;
- an unsaved guard state letting work through.

**The browser check passes** (the page is unchanged; its desk now starts at version 2 with the guard).

## Worth a look

- **Version 2 of desk.json.** Additive fields would have let an older Toryo read the file and save it again without the guard, silently dropping holds. With the version bumped, an older Toryo refuses the file (nothing new starts) until it's updated or the controls are reset.
- **Holds come from fresh readings,** and also from the latest saved readings when Toryo starts, after a reset, and for a rule you change. Then the latest reading still in its window counts: usage only grows within a window, so an old reading over the threshold is still true. A reading of a window that has reset never counts.
- **A reading under the threshold ends a hold** only when it's fresh. With automatic release off, it waits for you instead.
- **Times in messages** are in the desk's own time zone (*Tue 14 Oct, 09:00*).
- **Not in this slice:** Home's buttons and notice (Slices 8 and 9), provider-exhaustion handling, one-turn exceptions and forecasts (Later).
