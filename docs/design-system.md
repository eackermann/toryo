# Toryo's design system

The look the owner approved on 13 Oct 2026. The clickable prototype is in [`design/prototype/toryo-desk.html`](../design/prototype/toryo-desk.html): open it in a browser. It has Home, rooms, and a *Design system* tab with every token, ring, component and motion timing. Its sample data is made up. Its dashed *Prototype* bar (*Play the relay*, *Reset*) is a demo control, not part of the design.

The page takes its values from [`web/tokens.css`](../web/tokens.css); the rest is in `web/styles.css`.

## Principles

- **Color is activity.** Blue builds, mint reviews, purple plans, orange needs you. Agents are told apart by name and monogram, never by these colors.
- **Calm until it needs you.** Orange is kept for the moment a question waits for you. Nothing else uses it.
- **Moving means working.** Work in progress moves; a question pulses in place, because nothing moves until you answer; anything still is paused, held or done.
- **Every state is also in words.** A ring or a color is never the only way to tell: the rooms, the header and the cards say it in a sentence too.
- **Local and quiet.** The fonts ship with the page, which loads nothing from the internet.

## Color

The activity colors come from the logo's three blocks:

| Block | Faces | Means |
|---|---|---|
| The tall block | `#B598FA` `#9F84F1` `#7E66DA` | Planning |
| The base block | `#3A9CFD` `#2583F8` `#116EE3` | Building |
| The long block | `#7CEACD` `#54CFB6` `#38C0A6` | Reviewing |

Each activity has three tokens: the ring itself (`--plan`, `--build`, `--review`), an ink tone for text (`--plan-ink`, …), and a soft tone for fills (`--plan-soft`, …).

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--you` | `#ff7a1f` | `#ff8f3d` | Only for "needs you": questions, their buttons, the count in the top bar |
| `--warn` | `#d99413` | `#f2b544` | Only for usage limits getting close |
| `--bad` | `#dd4349` | `#ff6b70` | Failed turns, and limits that hold an agent |
| `--check` | `#6c7b95` | `#93a1ba` | The checks, the machine at work |
| `--ink` | `#14233a` | `#e8eef8` | Text, and the wordmark's navy |
| `--ink-2` | `#46546d` | `#b5c1d7` | Secondary text, and the tagline's slate |
| `--muted` | `#5f6b83` | `#8392ac` | Times, hints, labels |
| `--paper`, `--surface`, `--sunk` | `#f5f6fb`, `#ffffff`, `#eef1f7` | `#0b1220`, `#121b2c`, `#0e1626` | The page, cards, and recessed areas |
| `--agent`, `--agent-ink` | `#3a4963`, white | `#31436a`, `#e8eef8` | Every agent's monogram, in the same neutral tone |
| `--note`, `--note-ink` | `#14233a`, `#f5f6fb` | `#e8eef8`, `#0b1220` | Your notes: dark bubbles (light ones in the dark theme) |
| `--note-sunk`, `--note-line` | `#253652`, `#56678a` | `#cfd8e8`, `#7d8ba6` | Code, quotes, tables and links inside your notes |

The theme follows the system, unless you choose light or dark with the theme button in the top bar.

**Contrast.** Every text color passes WCAG AA (4.5:1) on the backgrounds it's used on, in both themes, including what's inside your notes. `test/tokens.test.mjs` checks the tokens, and `test/ui-shots.mjs` checks every text on the screen as it's drawn. That includes muted text on paper, cards and sunk areas, each activity's ink on its soft tone, and dark text on the orange button. Three tones were darkened from the prototype for this: `--muted` (from `#74819a`), `--review-ink` (from `#0b8a6f`) and `--you-ink` (from `#c2520a`). The mint and orange rings keep the logo's colors, below 3:1 on white. That's allowed because a ring is never the only way a state is shown.

## Type

| Role | Font | Size and weight |
|---|---|---|
| Display: names, headings, numbers that matter | Lexend | 32/600 for big headings, 21/600 a room's name, 15.5/600 titles, 16/500 a question |
| Body: reading | Figtree | 14.5/400 |
| Labels | Lexend | 11.5/600, capitals, spaced |
| What the machine said: commands, paths, times | JetBrains Mono | 12.5/400 |

Numbers are tabular wherever they change. The three families are bundled as woff2 in `web/fonts/` (Latin and Latin Extended), with their SIL Open Font License files beside them. Without them, the page falls back to the system's sans-serif and monospace.

## Components

- **Buttons.** One primary (dark) per area. Orange buttons only answer a question: *Use the recommendation*, *Retry*, *Write the plan*. Quiet buttons for everything secondary.
- **Segmented controls.** The mode (Chat, Plan, Build), the recipients, Ask or Tell, and the side panel's tabs.
- **Room tiles.** A room's monogram, its first letters, on a tile with corners at 30% of its size, so it reads the same from 22 to 48 pixels.
- **Agent monograms.** *Cx* Codex, *Cl* Claude, *Cu* Cursor, *Gk* Grok, all in the same neutral tone. The Codex app's *Cx* wears a small window corner.
- **Status chips.** A turn's status takes the color of what happens next: *Ready for review* is mint (review is next), *Changes requested* blue (building is next), *Approved* solid mint, *Question for you* orange, a proposal or critique purple.
- **Role chips.** Builder blue, reviewer mint, planner purple, advisor neutral.
- **Turn cards, question cards, your notes.** A turn is a card with its agent, role, kind, time and status. A question is a card with an orange edge, its recommendation in an orange box and *Use the recommendation*. Your notes are dark bubbles on the right.
- **The checks row.** One line per run: passed or failed, then each check with its time. A failed check's output folds out.
- **Slice markers and folded rounds.** In a build, each slice starts with a marker (its number, its name, and how it's going). The rounds before a slice's last one fold into one line, unless something in them is still open.
- **Plan progress.** One segment per slice: approved mint, the slice in progress blue, the rest empty. Then each slice, with the time an approved one took.
- **Usage meters.** Neutral until 70%, amber from 70%, red from 90%.
- **Sheets and toasts.** Sheets rise in the middle of the screen; toasts appear at the top right (at the bottom on a phone).

## Activity rings

Every room tile wears a ring for what's happening, in the rooms list and in the room's header (and on Home, when it comes). An agent's monogram wears one while it works: on its live turn, and on its card in *Crew*. The state comes from the room's summary (`ringFor` in [`web/rings.js`](../web/rings.js)); the rings are CSS, and the sparkler is drawn on a canvas.

| State | Ring |
|---|---|
| Building, reviewing, planning | A faint track with a sparkler running round it: a hot point with a turning glint, sparks thrown in every direction that sometimes fork, a fading trail that cools from white to the activity's color, and embers drifting off it. A halo breathes underneath |
| Replying in chat | The same, in slate: a reply isn't one of the three kinds of work, so it takes no activity color |
| Checks | Four grey dashes marching round |
| Needs you | An orange ring pulsing in place |
| Working while a question waits | The sparkler inside, the orange pulse outside |
| Paused (or stopped) | Dashed, with a pause badge; the orange pulse outside if a question waits |
| Held | Dotted, with a lock; the orange pulse outside if a question waits |
| Done | Solid mint, with a check |
| Failed, needs a retry | Solid red |
| Idle | No ring |

What needs you is never hidden: a failed turn shows red, and in every other state a waiting question adds the orange pulse. The pause and the hold still show under it: the room's summary says whether it's paused or held, apart from its status (which is "waiting" while a question waits).

**One clock, one loop.**
- All the sparklers are drawn by one animation loop, on one clock (`performance.now()` modulo 2.8 s). The loop runs only while there's a sparkler on the page, and wakes when one appears.
- Canvases off the screen are skipped. Sparks are capped (150 sparks and 170 embers a sparkler), and the pixel ratio is capped at 2. When the pixel ratio changes (zooming, a window moved to another screen), each canvas takes the new size and its sparks carry on.
- Turning reduced motion off starts the sparklers again straight away; turning it on stops them.
- CSS animations take a negative delay from the same clock (`--phb`, `--phn`, `--phm`), so drawing a tile again never restarts its ring. A tile that still shows the same thing isn't drawn again at all, so its sparks carry on.
- With twelve rooms, eight of them with sparklers, the page draws 60 frames a second (`test/ui-shots.mjs` times them).

**The live logo.** In the top bar, each block of the logo breathes while that kind of work runs anywhere on the desk: blue while something builds, purple while a round plans, mint while something is reviewed.

**The plan's progress.** The slice being built takes the color of what's happening to it: blue while it's built, mint while it's reviewed, grey during the checks. Its segment in the bar pulses.

**The legend.** *What the rings mean*, under the rooms: building, reviewing, planning, needs you.

## Motion

| Token | Value | Used for |
|---|---|---|
| `--m-run` | 2.8 s a lap, linear | The sparkler round anything at work |
| `--m-breathe` | 3.2 s, in and out | The halo under a working ring, and the live logo |
| `--m-beacon` | 1.7 s, out | Needs you: a ring pulsing in place |
| `--m-march` | 2.4 s, linear | The checks' marching dashes |
| `--m-settle` | 320 ms | Cards arriving, sheets rising |
| `--m-quick` | 160 ms | Hover, press, toggles |

With reduced motion, nothing moves: rings are solid, no canvas is drawn, nothing pulses, and the page jumps instead of scrolling smoothly.

## Layout

| Width | Layout |
|---|---|
| Over 1180 px | The rooms, the room's timeline, and its plan, crew and ledger beside it |
| 760 to 1180 px | The rooms and the room. Plan, crew and ledger become tabs in the room, next to the relay |
| Under 760 px | One column with a tab bar for the rooms and the room. The room's header gets compact. A question's buttons fill the card's width, at least 44 px tall, so they're easy to tap |

Nothing scrolls sideways at 320 and 390 pixels. Keyboard focus is always visible: a two-pixel blue outline.

## Checking it

- `node test/ui-check.mjs` checks the page's behavior in a real browser.
- `node test/ui-shots.mjs [folder]` takes screenshots at 1440, 1024 and 390 pixels, in light and dark, with reduced motion too, and of the sheets. It fails if anything scrolls sideways at 320 or 390 pixels.
- Both need `PLAYWRIGHT_CORE` set to a playwright-core folder.
