import { test } from "node:test";
import assert from "node:assert/strict";
import { minView, ruler, sessionAxis, zoomView } from "../web/phases.js";

// Clock times as the page shows them are local: these tests read them in UTC.
process.env.TZ = "UTC";

const H = 3_600_000;
const M = 60_000;
const session = (start, hours, breaks = []) => ({ start: Date.parse(start), end: Date.parse(start) + hours * H, length: hours * H, breaks });

test("the ruler's ticks get finer as the view narrows, and stay evenly spaced on time drawn to scale", () => {
  const v = session("2026-10-14T08:00:00Z", 6);
  const whole = ruler(v, { maxTicks: 8 });
  assert.equal(whole.step, H);
  assert.deepEqual(whole.ticks.map((t) => t.label), ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00"]);
  const gaps = whole.ticks.slice(1).map((t, i) => t.pos - whole.ticks[i].pos);
  assert.ok(gaps.every((g) => Math.abs(g - gaps[0]) < 1e-9), "evenly spaced");
  // A tenth of it (36 min): every 5 minutes.
  const tenth = ruler(v, { from: 0.5, to: 0.6, maxTicks: 8 });
  assert.equal(tenth.step, 5 * M);
  assert.equal(tenth.ticks[0].label, "11:00");
  assert.ok(tenth.ticks.every((t) => t.pos >= 0 && t.pos <= 1));
  // As close as it goes (half a minute): seconds.
  const close = ruler(v, { from: 0.5, to: 0.5 + minView(v), maxTicks: 8 });
  assert.equal(close.step, 5_000);
  assert.match(close.ticks[0].label, /^11:00:\d\d$/);
});

test("across midnight the ruler says the date where the day changes, and on its first tick", () => {
  const v = session("2026-10-13T22:00:00Z", 4);
  // Hours: midnight is the date alone.
  assert.deepEqual(ruler(v, { maxTicks: 4 }).ticks.map((t) => t.label), ["13 Oct 22:00", "23:00", "14 Oct", "01:00", "02:00"]);
  // Finer than hours: the date with the time.
  assert.deepEqual(ruler(v, { maxTicks: 8 }).ticks.map((t) => t.label), ["13 Oct 22:00", "22:30", "23:00", "23:30", "14 Oct 00:00", "00:30", "01:00", "01:30", "02:00"]);
  // Zoomed into the second day: its first tick has its date.
  const late = ruler(v, { from: 0.6, to: 0.75, maxTicks: 8 });
  assert.equal(late.ticks[0].label, "14 Oct 00:25");
  assert.equal(late.ticks[1].label, "00:30");
  // A session within one day never shows a date.
  assert.ok(ruler(session("2026-10-14T09:00:00Z", 2), { maxTicks: 8 }).ticks.every((t) => /^\d\d:\d\d$/.test(t.label)));
});

test("a break shows on the ruler as a break with its length, and the ticks never pretend it's to scale", () => {
  const start = Date.parse("2026-10-14T08:00:00Z");
  const v = session("2026-10-14T08:00:00Z", 12, [{ from: start + 2 * H, to: start + 11 * H, why: "waiting" }]);
  const r = ruler(v, { maxTicks: 8 });
  assert.deepEqual(r.breaks.map((b) => [b.label, b.why]), [["9 h 00", "waiting"]]);
  const [b] = r.breaks;
  // No tick inside the break.
  assert.ok(r.ticks.every((t) => t.pos <= b.from + 1e-9 || t.pos >= b.to - 1e-9));
  // The break is narrow (3% of the time drawn to scale), though it's 9 hours: 3 hours of work fill the rest.
  assert.ok(b.to - b.from < 0.05);
  const before = r.ticks.filter((t) => t.pos <= b.from + 1e-9).at(-1);
  const after = r.ticks.find((t) => t.pos >= b.to - 1e-9);
  assert.equal(after.at - before.at, 9 * H, "the ticks on either side are 9 hours apart");
  assert.ok(after.pos - before.pos < 0.05, "though they're drawn close together");
  // Its place on the axis agrees with the strip's.
  const { pos } = sessionAxis(v);
  assert.ok(Math.abs(b.from - pos(start + 2 * H)) < 1e-9);
});

test("zooming keeps the point under the pointer where it is, within the session and no closer than half a minute; panning stays within it", () => {
  const v = session("2026-10-14T08:00:00Z", 6);
  const z = zoomView(v, { from: 0, to: 1 }, { factor: 0.25, around: 0.8 });
  assert.ok(Math.abs(z.to - z.from - 0.25) < 1e-9);
  // The point under the pointer (0.8) stays at the same place in the view (80% across).
  assert.ok(Math.abs((0.8 - z.from) / (z.to - z.from) - 0.8) < 1e-9);
  // Never closer than half a minute, never past either end.
  let close = { from: 0, to: 1 };
  for (let i = 0; i < 40; i++) close = zoomView(v, close, { factor: 0.5, around: 0.999 });
  assert.ok(Math.abs(close.to - close.from - minView(v)) < 1e-12);
  assert.ok(close.to <= 1);
  assert.deepEqual(zoomView(v, close, { factor: 1e6 }), { from: 0, to: 1 });
  // A session shorter than a minute still zooms, to half of it.
  const brief = session("2026-10-14T08:00:00Z", 10 / 3600);
  assert.equal(minView(brief), 0.5);
  const half = zoomView(brief, { from: 0, to: 1 }, { factor: 0.1 });
  assert.ok(Math.abs(half.to - half.from - 0.5) < 1e-9);
  // Panning by a shift, held at the ends.
  const panned = zoomView(v, { from: 0.4, to: 0.5 }, { shift: 0.05 });
  assert.ok(Math.abs(panned.from - 0.45) < 1e-9 && Math.abs(panned.to - 0.55) < 1e-9);
  const start = zoomView(v, { from: 0.4, to: 0.5 }, { shift: -1 });
  assert.ok(start.from === 0 && Math.abs(start.to - 0.1) < 1e-9);
});

/** The boxes the labels drawn take on the ruler, in pixels, as `ruler` lays them out (default measure). */
function boxes(r, px) {
  const width = (text) => text.length * 6.2;
  const out = [];
  for (const t of r.ticks.filter((t) => t.shown)) {
    const x = t.pos * px;
    const w = width(t.label) + 4;
    out.push({ text: t.label, a: t.end ? x - w : x, b: t.end ? x : x + w });
  }
  for (const b of r.breaks.filter((b) => b.labelShown)) {
    const w = width(b.label) + 8;
    out.push({ text: b.label, a: b.labelAt * px - w / 2, b: b.labelAt * px + w / 2 });
  }
  return out.sort((x, y) => x.a - y.a);
}

test("the ruler's labels never touch: a break's length is drawn whole, centred on it, and ticks too close lose their labels, not their place", () => {
  const start = Date.parse("2026-10-14T08:00:00Z");
  const v = session("2026-10-14T08:00:00Z", 12, [{ from: start + 2 * H, to: start + 11 * H, why: "idle" }]);
  for (const px of [672, 420, 300, 180]) {
    const r = ruler(v, { maxTicks: Math.max(2, Math.floor(px / 84)), px });
    const drawn = boxes(r, px);
    for (let i = 1; i < drawn.length; i++) assert.ok(drawn[i].a >= drawn[i - 1].b, `${px} px: “${drawn[i - 1].text}” and “${drawn[i].text}” touch`);
    assert.ok(drawn.every((d) => d.a >= -0.5 && d.b <= px + 0.5), `${px} px: a label runs off the ruler`);
    // The break's length is drawn, centred on the break.
    const [b] = r.breaks;
    assert.equal(b.labelShown, true, `${px} px: the break's length is drawn`);
    assert.ok(Math.abs(b.labelAt - (b.from + b.to) / 2) < 1e-9);
    // Every tick keeps its place: only labels are left out.
    assert.deepEqual(r.ticks.map((t) => t.pos), ruler(v, { maxTicks: Math.max(2, Math.floor(px / 84)) }).ticks.map((t) => t.pos));
  }
  // The case the review found: at 672 px, 10:00 and 19:00 sit either side of the break, 20 px apart.
  const r = ruler(v, { maxTicks: 8, px: 672 });
  const shown = r.ticks.filter((t) => t.shown).map((t) => t.label);
  assert.ok(!(shown.includes("10:00") && shown.includes("19:00")), shown.join(", "));
});

test("a date left out with its label goes on the next label drawn", () => {
  const v = session("2026-10-13T22:00:00Z", 4);
  const r = ruler(v, { maxTicks: 8, px: 300 });
  const shown = r.ticks.filter((t) => t.shown);
  assert.ok(r.ticks.some((t) => !t.shown && /14 Oct/.test(t.label)), "the midnight label is left out at this width");
  const firstOfDay = shown.find((t) => t.at >= Date.parse("2026-10-14T00:00:00Z"));
  assert.match(firstOfDay.label, /^14 Oct \d\d:\d\d$/);
  assert.match(shown[0].label, /^13 Oct 22:00$/);
});
