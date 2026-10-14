// A session's timeline: when a room planned, built, reviewed and ran its checks, and how long each took, from its
// events. Shared by the page, which draws it at the top of the room, and the desk, which says it in words (the room's
// summary, `toryo show`, `toryo_room`). Kept event by event: an event that changes again replaces what it said, so
// nothing is ever rescanned. A room's sessions are split where the owner started a new one (a "session" event).

/** What kind of work a request is: building, reviewing (plan checks too), planning, the checks, or a reply. */
export function workKind(kind) {
  if (kind === "gates") return "checks";
  if (/^build/.test(kind ?? "")) return "build";
  if (/^review|^plan-check/.test(kind ?? "")) return "review";
  if (/^plan-/.test(kind ?? "")) return "plan";
  return "chat";
}

/** The lanes, in the order the strip draws them. "other": replies, discussions, second opinions. */
export const LANES = ["plan", "build", "review", "checks", "other"];

/** A stretch over this long with nothing running is drawn as a short break, marked with its length. */
export const BREAK_MS = 30 * 60_000;

const at = (iso) => (iso ? Date.parse(iso) : NaN);
const known = (n) => Number.isFinite(n);

export class Timeline {
  constructor() {
    // When the session began (its first event), and the latest time any event mentions.
    this.start = null;
    this.last = null;
    // Turns and checks runs, by event id: { lane, from, to (null while running), agent, kind, slice, round, … }.
    this.work = new Map();
    // Checks runs recorded, by the id they ran under: a run still listed as running isn't counted twice.
    this.runs = new Set();
    // When the room sent each turn and checks run, by event id (nothing is sent while a room is paused).
    this.sent = new Map();
    // Questions for you, by id: { from, to } (to: null while open, undefined if it closed at an unknown time).
    this.questions = new Map();
    // When you answered a question (your answer's time, for questions closed before they recorded it).
    this.answers = new Map();
    // Pauses, resumes, stops and desk holds, by event id: { at, what }.
    this.marks = new Map();
  }

  /** Take in an event, new or changed. */
  add(ev) {
    const t = at(ev.at);
    if (known(t)) {
      if (this.start == null || t < this.start) this.start = t;
      if (this.last == null || t > this.last) this.last = t;
    }
    switch (ev.type) {
      case "turn": {
        // Never sent (held while it was prepared), or a handoff brought in from elsewhere to be reviewed first (a build
        // started from finished work, also while paused): no work done here, and nothing sent.
        if (ev.state === "deferred" || ev.imported) return void (this.work.delete(ev.id), this.sent.delete(ev.id));
        // A turn following one the Codex app already had, after a restart, wasn't sent by the room.
        if (known(at(ev.startedAt)) && !ev.req?.attach) this.sent.set(ev.id, at(ev.startedAt));
        // A Codex app turn works from when the app took it up; until then it waits in the app's queue, which isn't
        // work. One the app never took up (or took up before Toryo recorded when) counts nothing.
        const from = at(ev.agent === "codexapp" ? ev.pickedUpAt : ev.startedAt);
        const to = ev.state === "running" ? null : at(ev.endedAt);
        if (!known(from) || (to !== null && !known(to))) return void this.work.delete(ev.id);
        const kind = workKind(ev.kind);
        this.work.set(ev.id, { lane: kind === "chat" ? "other" : kind, from, to, id: ev.id, agent: ev.agent, kind: ev.kind, slice: ev.slice ?? null, round: ev.round ?? null, state: ev.state, status: ev.status ?? null });
        if (to != null && (this.last == null || to > this.last)) this.last = to;
        return;
      }
      case "gate": {
        // When the run started; in rooms from before that was recorded, its end less its checks' times.
        const to = at(ev.at);
        const seconds = (ev.results ?? []).reduce((n, r) => n + (Number(r.seconds) || 0), 0);
        const from = known(at(ev.startedAt)) ? at(ev.startedAt) : to - seconds * 1000;
        if (ev.runId) this.runs.add(ev.runId);
        if (known(from)) this.sent.set(ev.id, from);
        if (known(from) && known(to)) this.work.set(ev.id, { lane: "checks", from, to, id: ev.id, agent: "toryo", kind: "gates", ok: (ev.results ?? []).every((r) => r.ok), estimated: !ev.startedAt });
        return;
      }
      case "question": {
        const from = at(ev.at);
        if (!known(from)) return;
        const closed = at(ev.closedAt);
        this.questions.set(ev.id, { from, to: ev.open ? null : known(closed) ? closed : undefined });
        return;
      }
      case "owner":
        for (const a of ev.answers ?? []) if (a?.id && known(t)) this.answers.set(a.id, t);
        return;
      case "mark":
        // A checks run cut short (the room stopped, or moved on): the time it ran, though it has no result.
        if (ev.what === "checks") {
          if (ev.runId) this.runs.add(ev.runId);
          const from = at(ev.startedAt);
          if (known(from)) this.sent.set(ev.id, from);
          if (known(from) && known(t)) this.work.set(ev.id, { lane: "checks", from, to: t, id: ev.id, agent: "toryo", kind: "gates", cut: ev.why ?? "stopped", inRoom: false });
          return;
        }
        if (known(t)) this.marks.set(ev.id, { at: t, what: ev.what });
        return;
      case "system": {
        // Rooms from before marks: their pause, stop and resume sentences (Resume, or a message to a stopped room).
        const text = ev.text ?? "";
        const what = /^(?:Paused\.|Pausing:)/.test(text) ? "paused" : /^Stopped\./.test(text) ? "stopped" : /^Resumed\b/.test(text) ? "resumed" : null;
        if (what && known(t)) this.marks.set(ev.id, { at: t, what });
        return;
      }
      default:
    }
  }

  /**
   * The timeline now: { start, end, length, segments, totals, waiting, paused, held, breaks, overlap }. `live`: work
   * running that has no event yet (a checks run: { id, kind, agent, startedAt }). `end`: when the session ended (a
   * finished room), else now. A phase's total is the time at least one of its turns ran, so turns side by side count
   * once; phases can overlap (a reply while building), so totals can add up to more than the session's length.
   */
  view({ now = Date.now(), live = [], end = null } = {}) {
    const stop = end ?? now;
    const segments = [...this.work.values()].map((w) => ({ ...w, to: w.to ?? stop, running: w.to == null }));
    for (const l of live) {
      if (this.work.has(l.id) || this.runs.has(l.id) || !known(at(l.startedAt))) continue;
      const kind = workKind(l.kind);
      segments.push({ lane: kind === "chat" ? "other" : kind, from: at(l.startedAt), to: stop, id: l.id, agent: l.agent, kind: l.kind, running: true, live: true, inRoom: false });
    }
    segments.sort((a, b) => a.from - b.from || a.to - b.to);
    const totals = {};
    for (const lane of LANES) totals[lane] = length(union(segments.filter((s) => s.lane === lane)));
    // Waiting for you: question to answer. A question closed at a time nobody recorded isn't counted.
    const waits = [];
    for (const [id, q] of this.questions) {
      const to = q.to === null ? stop : q.to ?? this.answers.get(id);
      if (known(to)) waits.push({ from: q.from, to });
    }
    const { paused, held } = this.#pauses(stop);
    const waiting = union(waits);
    totals.waiting = length(waiting);
    totals.paused = length(union([...paused, ...held]));
    const start = this.start ?? segments[0]?.from ?? stop;
    // Long stretches with nothing running: drawn short. Mostly waiting for you, or just idle.
    const busy = union(segments);
    const breaks = [];
    let cursor = start;
    const gapOf = (from, to) => ({ from, to, why: overlap(waiting, from, to) > (to - from) / 2 ? "waiting" : "idle" });
    for (const [a, b] of busy) {
      if (a - cursor > BREAK_MS) breaks.push(gapOf(cursor, a));
      cursor = Math.max(cursor, b);
    }
    if (stop - cursor > BREAK_MS) breaks.push(gapOf(cursor, stop));
    const worked = LANES.reduce((n, lane) => n + totals[lane], 0);
    return { start, end: stop, length: Math.max(0, stop - start), segments, totals, waiting, paused: union(paused), held: union(held), breaks, overlap: worked > length(busy) };
  }

  /** Whether the session is paused (or stopped) as it stands: a pause with no resume after it. */
  pausedNow() {
    return this.#pauses(Infinity).open;
  }

  /**
   * Paused (or stopped) from the pause to the resume; held from when desk-wide controls began holding its work to
   * when they let go. Nothing starts in a paused room, so work sent after a pause also ends it: rooms from before
   * marks had no sentence when a new build or plan, say, cleared a stop.
   */
  #pauses(stop) {
    const moments = [...this.marks.values()];
    for (const sent of this.sent.values()) moments.push({ at: sent, what: "sent" });
    moments.sort((a, b) => a.at - b.at);
    const paused = [];
    const held = [];
    let p = null;
    let h = null;
    for (const m of moments) {
      if ((m.what === "paused" || m.what === "stopped") && p == null) p = m.at;
      else if ((m.what === "resumed" || (m.what === "sent" && m.at > p)) && p != null) paused.push({ from: p, to: m.at }), (p = null);
      else if (m.what === "held" && h == null) h = m.at;
      else if (m.what === "free" && h != null) held.push({ from: h, to: m.at }), (h = null);
    }
    const open = p != null;
    if (p != null) paused.push({ from: p, to: stop });
    if (h != null) held.push({ from: h, to: stop });
    return { paused, held, open };
  }
}

/**
 * A room's sessions, a Timeline each: the first from the room's start, then one from each "session" event. An event
 * belongs to the session it arrived in, also when it changes later. Earlier sessions end where the next began, and
 * their views are kept until one of their events changes.
 */
export class Sessions {
  constructor() {
    this.list = [{ n: 1, id: null, at: null, timeline: new Timeline() }];
    this.where = new Map();
    this.views = new Map();
  }

  add(ev) {
    if (ev.type === "session" && !this.where.has(ev.id)) this.list.push({ n: ev.n ?? this.list.length + 1, id: ev.id, at: at(ev.at), timeline: new Timeline() });
    let i = this.where.get(ev.id);
    if (i == null) this.where.set(ev.id, (i = this.list.length - 1));
    this.list[i].timeline.add(ev);
    this.views.delete(i);
  }

  /** The session going on now. */
  get current() {
    return this.list.at(-1).timeline;
  }

  get n() {
    return this.list.at(-1).n;
  }

  /** Session `i` (0 for the first): the current one as `view` takes it, an earlier one up to where the next began. */
  view(i = this.list.length - 1, opts = {}) {
    if (i === this.list.length - 1) return this.list[i].timeline.view(opts);
    if (!this.views.has(i)) this.views.set(i, this.list[i].timeline.view({ end: this.list[i + 1].at }));
    return this.views.get(i);
  }

  /** Which session an event belongs to (0 for the first). */
  of(id) {
    return this.where.get(id) ?? this.list.length - 1;
  }
}

// ---------------------------------------------------------------- the strip's axis, ruler and zoom

/**
 * A session's place on the strip's x-axis: time to a fraction of the axis (0 to 1). Breaks (long stretches with
 * nothing running) are drawn as 3% of the time worked each, so the work stays readable however long the room waited;
 * the rest is to scale. `active`: the time that's to scale (the session less its breaks).
 */
export function sessionAxis(v) {
  const removed = v.breaks.reduce((n, b) => n + (b.to - b.from), 0);
  const active = Math.max(1, v.length - removed);
  const short = active * 0.03;
  const total = active + short * v.breaks.length;
  const pos = (t) => {
    let p = 0;
    let cur = v.start;
    for (const b of v.breaks) {
      if (t <= b.from) break;
      p += b.from - cur;
      if (t < b.to) return (p + (short * (t - b.from)) / (b.to - b.from)) / total;
      p += short;
      cur = b.to;
    }
    return Math.min(total, p + Math.max(0, t - cur)) / total;
  };
  return { pos, active, total };
}

/** The ruler's steps between ticks, finest first: seconds to days. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800].map((s) => s * 1000);

/**
 * The ruler under the strip, for the part of the session in view (`from` to `to`, fractions of the axis): ticks at
 * clock times, as many as fit (`maxTicks`), finer as you zoom in, a date where the day changes (and on the first tick
 * when the session spans days); and each break in view, shown as a break with its length, never as time to scale.
 * Positions are fractions of the view. Times are local, as the page shows them.
 *
 * Given the ruler's width in pixels (`px`) and a way to measure a label (`measure`, text to pixels), the labels are
 * also laid out so none touches another (see `placeLabels`): each tick's `shown` says whether its label is drawn,
 * `end` whether it sits left of its tick (near the right edge), and each break's `labelAt` where its length is drawn.
 */
export function ruler(v, { from = 0, to = 1, maxTicks = 8, px = null, measure = (text) => text.length * 6.2 } = {}) {
  const { pos } = sessionAxis(v);
  const width = Math.max(1e-9, to - from);
  const at = (t) => (pos(t) - from) / width;
  // The stretches drawn to scale, and how much of each is in view.
  const stretches = [];
  let cur = v.start;
  for (const b of v.breaks) {
    if (b.from > cur) stretches.push([cur, b.from]);
    cur = Math.max(cur, b.to);
  }
  if (v.end > cur) stretches.push([cur, v.end]);
  const inView = [];
  for (const [a, b] of stretches) {
    const pa = pos(a);
    const pb = pos(b);
    if (pb <= from || pa >= to || pb <= pa) continue;
    const ta = a + ((Math.max(pa, from) - pa) / (pb - pa)) * (b - a);
    const tb = a + ((Math.min(pb, to) - pa) / (pb - pa)) * (b - a);
    inView.push([ta, tb]);
  }
  const shown = inView.reduce((n, [a, b]) => n + (b - a), 0);
  const step = STEPS.find((s) => shown / s <= maxTicks) ?? STEPS.at(-1);
  const multiDay = dayOf(v.start) !== dayOf(v.end);
  const ticks = [];
  let lastDay = null;
  for (const [a, b] of inView) {
    // Aligned to the local day (whole minutes, hours, days), not to the epoch.
    const midnight = new Date(a);
    midnight.setHours(0, 0, 0, 0);
    const base = midnight.getTime();
    for (let t = base + Math.ceil((a - base) / step) * step; t <= b; t += step) {
      const d = new Date(t);
      const day = dayOf(t);
      const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}${step < 60_000 ? `:${pad(d.getSeconds())}` : ""}`;
      const newDay = lastDay != null ? day !== lastDay : multiDay;
      const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const isMidnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
      ticks.push({ at: t, pos: at(t), label: newDay ? (isMidnight && step >= 3_600_000 ? date : `${date} ${clock}`) : clock, date, clock, dated: newDay });
      lastDay = day;
    }
  }
  const breaks = v.breaks
    .filter((b) => pos(b.to) > from && pos(b.from) < to)
    .map((b) => ({ from: at(b.from), to: at(b.to), length: b.to - b.from, label: durationWords(b.to - b.from), why: b.why }));
  if (px) placeLabels(ticks, breaks, px, measure);
  return { step, ticks, breaks };
}

/**
 * The ruler's labels on its one line, none touching another. A break's length comes first, centred on the break
 * (a break is drawn narrow, often narrower than its label) and kept within the ruler. Then the ticks' clock times, left
 * to right, each after its tick (or before it, near the right edge), leaving out any that would touch one already
 * placed: its tick still shows, without a label. A date left out goes on the next label shown.
 */
function placeLabels(ticks, breaks, px, measure) {
  const GAP = 6;
  const PAD = 4;
  const placed = [];
  const free = (a, b) => a >= -0.5 && b <= px + 0.5 && placed.every(([x, y]) => b + GAP <= x || a >= y + GAP);
  for (const b of breaks) {
    const w = measure(b.label) + 2 * PAD;
    const mid = ((b.from + b.to) / 2) * px;
    const c = Math.min(Math.max(mid, w / 2), px - w / 2);
    b.labelAt = c / px;
    b.labelShown = mid >= 0 && mid <= px && free(c - w / 2, c + w / 2);
    if (b.labelShown) placed.push([c - w / 2, c + w / 2]);
  }
  let date = null;
  for (const t of ticks) {
    const label = date && !t.dated ? `${t.date} ${t.clock}` : t.label;
    const w = measure(label) + PAD;
    const x = t.pos * px;
    const end = x + w > px;
    const [a, b] = end ? [x - w, x] : [x, x + w];
    t.shown = free(a, b);
    t.end = end;
    if (t.shown) {
      placed.push([a, b]);
      t.label = label;
      date = null;
    } else if (t.dated) date = t.date;
  }
}

/** The narrowest view of a session: half a minute of the time drawn to scale, or half of a session shorter than a minute. */
export function minView(v) {
  const { total } = sessionAxis(v);
  return Math.min(0.5, 30_000 / total);
}

/**
 * Zooming the strip's view (`view`: { from, to }, fractions of the axis) by `factor` (under 1: closer) around a point
 * (`around`, a fraction of the axis), kept within the session and no narrower than `minView`. Panning is a zoom by 1
 * with `shift` (a fraction of the axis).
 */
export function zoomView(v, view, { factor = 1, around = (view.from + view.to) / 2, shift = 0 } = {}) {
  const span = Math.min(1, Math.max(minView(v), (view.to - view.from) * factor));
  const ratio = (around - view.from) / Math.max(1e-9, view.to - view.from);
  let from = around - ratio * span + shift;
  from = Math.min(Math.max(0, from), 1 - span);
  return { from, to: from + span };
}

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Intervals ([from, to] pairs, or { from, to }) merged where they touch. */
function union(items) {
  const xs = items
    .map((x) => (Array.isArray(x) ? x : [x.from, x.to]))
    .filter(([a, b]) => known(a) && known(b) && b > a)
    .sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of xs) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const length = (merged) => merged.reduce((n, [a, b]) => n + b - a, 0);

/** How much of [from, to] the merged intervals cover. */
function overlap(merged, from, to) {
  return merged.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
}

/** A length of time in words: "12 s", "22 min", "3 h 10", "2 d 4 h". */
export function durationWords(ms) {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const WORDS = { build: "building", review: "reviewing", checks: "checks", plan: "planning", other: "other work", waiting: "waiting for you", paused: "paused or held" };

/** The phases with a second or more, in the order they're said: building, reviewing, checks, planning, other, waiting, paused. */
export function phaseList(totals) {
  return ["build", "review", "checks", "plan", "other", "waiting", "paused"].filter((k) => totals?.[k] >= 500).map((k) => ({ key: k, words: WORDS[k], ms: totals[k] }));
}

/** The work in a session's totals, in words: "building 3 h 10, reviewing 1 h 05", "under a second of work", "nothing run". */
export function workWords(totals) {
  const list = phaseList(totals).filter((p) => LANES.includes(p.key));
  if (list.length) return list.map((p) => `${p.words} ${durationWords(p.ms)}`).join(", ");
  return LANES.some((lane) => totals?.[lane] > 0) ? "under a second of work" : "nothing run";
}

/** An earlier session in a sentence: "session 1, 13 Oct 09:00 to 14 Oct 18:30: building 3 h 10, reviewing 1 h 05." */
export function earlierWords(e) {
  const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `session ${e.n}, ${when(e.start)} to ${when(e.end)}: ${workWords(e.totals)}.`;
}

/** The session in a sentence: "This session, 5 h 20: building 3 h 10, reviewing 1 h 05, checks 22 min, waiting for you 1 h 30." */
export function sessionWords(v, label = "This session") {
  if (!v) return "";
  const list = phaseList(v.totals);
  const any = LANES.some((lane) => v.totals?.[lane] > 0);
  return `${label}, ${durationWords(v.length)}${list.length ? `: ${list.map((p) => `${p.words} ${durationWords(p.ms)}`).join(", ")}` : any ? ", under a second of work so far" : ", nothing run yet"}.`;
}
