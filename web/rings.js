// Activity rings (docs/design-system.md): what a room tile, or a working agent's monogram, wears for what's
// happening. The state is decided here from the room's summary; the rings themselves are CSS (styles.css), and the
// sparkler that runs round anything at work is drawn on a canvas, by one animation loop for the whole page.

/** What kind of work a running request is, as a ring: building, reviewing, planning, the checks, or a reply. */
export function workKind(kind) {
  if (kind === "gates") return "checks";
  if (/^build/.test(kind ?? "")) return "build";
  if (/^review|^plan-check/.test(kind ?? "")) return "review";
  if (/^plan-/.test(kind ?? "")) return "plan";
  return "chat";
}

/**
 * A room's ring, from its summary: { ring, needs }. `needs` adds the orange pulse outside a ring that says something
 * else (someone works, or the room is paused or held, while a question waits for you).
 *   done · error (a turn failed: it needs a retry) · build, review, plan, checks, chat (someone works; also while a
 *   paused room finishes its turn) · paused (or stopped) · held · needs (a question waits, and nothing else) · idle
 * Paused and held come from the summary's own flags, as a waiting question makes the status "waiting".
 */
export function ringFor(r) {
  const asks = r?.questions ?? (r?.waiting ? [r.waiting] : []);
  const work = r?.working?.[0];
  const kind = work ? workKind(work.kind) : null;
  const paused = r?.paused ?? (r?.status === "paused" || r?.status === "stopped");
  const held = r?.held ?? r?.status === "held";
  if (r?.status === "done") return { ring: "done", needs: false };
  if (asks.some((q) => q.kind === "error")) return { ring: "error", needs: false };
  if (kind) return { ring: kind, needs: asks.length > 0 };
  if (paused) return { ring: "paused", needs: asks.length > 0 };
  if (held) return { ring: "held", needs: asks.length > 0 };
  if (asks.length) return { ring: "needs", needs: false };
  return { ring: "idle", needs: false };
}

export const RUNNING = new Set(["build", "review", "plan", "chat"]);
export const RUN_MS = 2800;
const BREATHE_MS = 3200;
const BEACON_MS = 1700;
const MARCH_MS = 2400;

/**
 * Where each CSS animation is on the one clock every ring shares, as negative delays: a tile drawn again carries on
 * where it was, instead of starting over.
 */
export function phases(now = performance.now()) {
  const at = (ms) => `${-Math.round(now % ms)}ms`;
  return `--phb:${at(BREATHE_MS)};--phn:${at(BEACON_MS)};--phm:${at(MARCH_MS)}`;
}

/** The sparkler's canvas for a tile of `size` pixels, its path `out` pixels outside the tile (round for a circle). */
export function sparkCanvas(size, out = 6, round = false) {
  const m = out + 24;
  const css = size + 2 * m;
  return `<canvas class="sparkler" data-size="${size}" data-out="${out}" data-m="${m}" data-round="${round ? 1 : 0}" style="left:${-m}px;top:${-m}px;width:${css}px;height:${css}px" aria-hidden="true"></canvas>`;
}

/** The ring's attributes and what goes inside the tile with it (the sparkler, a badge). `badge(name)` draws an icon. */
export function ringParts({ ring, needs }, size, badge, now) {
  const attrs = `data-ring="${ring}"${needs && ring !== "needs" ? " data-needs" : ""}`;
  const style = `--size:${size}px;${phases(now)}`;
  const icon = ring === "done" ? "check" : ring === "held" ? "lock" : ring === "paused" ? "pause" : "";
  const inner = `${RUNNING.has(ring) ? sparkCanvas(size) : ""}${icon ? `<span class="badge">${badge(icon)}</span>` : ""}`;
  return { attrs, style, inner };
}

/** The live logo: each block breathes while that kind of work runs anywhere on the desk. */
export function markAnimation(kinds, now = performance.now()) {
  const delay = `${-Math.round(now % BREATHE_MS)}ms`;
  return [["build", "mk-build"], ["plan", "mk-plan"], ["review", "mk-review"]]
    .filter(([k]) => kinds.has(k))
    .map(([, name]) => `${name} var(--m-breathe) ease-in-out ${delay} infinite`)
    .join(", ");
}

// ------------------------------------------------------------------ the sparkler

/** A point a fraction u of the way round a rounded rectangle, clockwise from the top edge. */
function pointAt(u, x, y, w, h, r) {
  const sw = w - 2 * r;
  const sh = h - 2 * r;
  const arc = (Math.PI * r) / 2;
  let d = u * (2 * sw + 2 * sh + 4 * arc);
  const segs = [
    [sw, (t) => [x + r + t, y]],
    [arc, (t) => { const a = -Math.PI / 2 + t / r; return [x + w - r + r * Math.cos(a), y + r + r * Math.sin(a)]; }],
    [sh, (t) => [x + w, y + r + t]],
    [arc, (t) => { const a = t / r; return [x + w - r + r * Math.cos(a), y + h - r + r * Math.sin(a)]; }],
    [sw, (t) => [x + w - r - t, y + h]],
    [arc, (t) => { const a = Math.PI / 2 + t / r; return [x + r + r * Math.cos(a), y + h - r + r * Math.sin(a)]; }],
    [sh, (t) => [x, y + h - r - t]],
    [arc, (t) => { const a = Math.PI + t / r; return [x + r + r * Math.cos(a), y + r + r * Math.sin(a)]; }],
  ];
  for (let i = 0; i < segs.length; i++) {
    const [len, at] = segs[i];
    if (d <= len || i === segs.length - 1) {
      const [px, py] = at(Math.min(d, len));
      return { x: px, y: py };
    }
    d -= len;
  }
  return { x: x + r, y };
}

const SPARKS = 150;
const EMBERS = 170;
const STATE = new WeakMap();
let theme = 0;
const hexRgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
  if (!m) return [37, 131, 248];
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

function colorsFor(cv) {
  const c = hexRgb(getComputedStyle(cv.parentElement).getPropertyValue("--c"));
  const bg = hexRgb(getComputedStyle(document.documentElement).getPropertyValue("--surface"));
  const light = bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11 > 140;
  return light
    ? { c, tint: mix(c, [20, 35, 58], 0.12), gold: mix(c, [232, 150, 10], 0.55), glow: mix(c, [255, 255, 255], 0.35), light }
    : { c, tint: mix(c, [255, 255, 255], 0.6), gold: mix(c, [255, 214, 120], 0.55), glow: mix(c, [255, 255, 255], 0.6), light };
}

function spawn(st, x, y, sc, ang, speed, life) {
  const a = ang ?? Math.random() * Math.PI * 2;
  const sp = speed ?? (26 + Math.random() * 62) * sc;
  st.parts.push({ x: x + (Math.random() - 0.5) * 1.4, y: y + (Math.random() - 0.5) * 1.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: life ?? 0.12 + Math.random() * 0.3, tone: Math.random(), fork: ang === undefined && Math.random() < 0.28 });
}

/** One frame of one sparkler: a hot point with a turning glint, a trail that cools, sparks that fork, embers. */
function draw(cv, now, dt) {
  const box = cv.getBoundingClientRect();
  // Off the screen (or hidden): nothing to draw.
  if (!box.width || box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  let st = STATE.get(cv);
  if (!st) {
    const size = Number(cv.dataset.size);
    const out = Number(cv.dataset.out);
    const m = Number(cv.dataset.m);
    st = { size, out, m, round: cv.dataset.round === "1", css: size + 2 * m, parts: [], carry: 0, embers: 0, theme: -1, dpr: 0 };
    STATE.set(cv, st);
  }
  // The pixel ratio changed (zooming in or out, a window moved to another screen): the bitmap takes the new size. The
  // sparks are kept in CSS pixels, so they carry on where they were.
  if (st.dpr !== dpr) {
    cv.width = cv.height = Math.round(st.css * dpr);
    st.dpr = dpr;
  }
  if (st.theme !== theme) {
    st.col = colorsFor(cv);
    st.theme = theme;
  }
  const { c, tint, gold, glow, light } = st.col;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, st.css, st.css);
  const sc = Math.max(0.72, Math.min(1.2, st.size / 40));
  const x0 = st.m - st.out;
  const w = st.size + 2 * st.out;
  const rad = st.round ? w / 2 : st.size * 0.3 + st.out;
  const u = (now % RUN_MS) / RUN_MS;
  const at = (v) => pointAt(((v % 1) + 1) % 1, x0, x0, w, w, rad);
  const head = at(u);
  // The fading trail, like a long exposure: an even line that cools from white-hot to the activity's color.
  const N = 44;
  const span = 0.34;
  ctx.lineCap = "butt";
  ctx.globalCompositeOperation = light ? "source-over" : "lighter";
  for (const pass of [0, 1]) {
    let prev = at(u - span);
    for (let i = 1; i <= N; i++) {
      const p = at(u - span + (span * i) / N);
      const k = i / N;
      const a = Math.pow(k, 1.7);
      ctx.strokeStyle = pass === 0 ? rgba(c, (light ? 0.15 : 0.16) * a) : rgba(k > 0.9 ? glow : c, (light ? 1 : 0.92) * a);
      ctx.lineWidth = pass === 0 ? 5.5 * sc : (light ? 1.7 + 0.7 * k : 1.3 + 0.6 * k) * Math.max(0.85, sc);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      prev = p;
    }
  }
  ctx.lineCap = "round";
  // Embers drift off the trail and go out.
  st.embers += dt * 34 * sc;
  while (st.embers >= 1 && st.parts.length < EMBERS) {
    st.embers -= 1;
    const q = at(u - Math.random() * span * 0.75);
    st.parts.push({ x: q.x, y: q.y, vx: (Math.random() - 0.5) * 12 * sc, vy: (3 + Math.random() * 9) * sc, age: 0, life: 0.35 + Math.random() * 0.55, tone: Math.random(), ember: true });
  }
  if (st.embers >= 1) st.embers = 0;
  // Sparks: thrown in every direction, falling a little, fading fast; some fork once.
  st.carry += dt * 190 * sc;
  while (st.carry >= 1 && st.parts.length < SPARKS) {
    st.carry -= 1;
    spawn(st, head.x, head.y, sc);
  }
  if (st.carry >= 1) st.carry = 0;
  const forks = [];
  st.parts = st.parts.filter((q) => {
    q.age += dt;
    if (q.age >= q.life) return false;
    const fade = Math.pow(1 - q.age / q.life, 1.3);
    const tone = q.tone < 0.4 ? tint : q.tone < 0.75 ? gold : c;
    if (q.ember) {
      q.vy += 18 * sc * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      ctx.fillStyle = rgba(tone, fade * (0.55 + 0.45 * Math.random()));
      ctx.beginPath();
      ctx.arc(q.x, q.y, 0.8 * sc, 0, Math.PI * 2);
      ctx.fill();
      return true;
    }
    if (q.fork && q.age > q.life * 0.45) {
      q.fork = false;
      const a = Math.atan2(q.vy, q.vx);
      const sp = Math.hypot(q.vx, q.vy) * 0.75;
      const rest = (q.life - q.age) * 0.8;
      forks.push([q.x, q.y, a + 0.7, sp, rest], [q.x, q.y, a - 0.7, sp, rest]);
    }
    q.vy += 55 * sc * dt;
    q.vx *= 1 - 1.5 * dt;
    q.vy *= 1 - 1.5 * dt;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    ctx.strokeStyle = rgba(tone, (light ? 0.95 : 1) * fade);
    ctx.lineWidth = (q.tone < 0.4 ? 1.3 : 1.05) * sc;
    ctx.beginPath();
    ctx.moveTo(q.x, q.y);
    ctx.lineTo(q.x - q.vx * 0.045, q.y - q.vy * 0.045);
    ctx.stroke();
    return true;
  });
  for (const [x, y, a, sp, life] of forks) if (st.parts.length < SPARKS + EMBERS) spawn(st, x, y, sc, a, sp, life);
  // The hot point: a white core in a flickering glow, with a turning glint.
  const fl = 0.8 + Math.random() * 0.45;
  const R = 7 * sc * fl;
  const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, R);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.22, rgba(glow, 0.95));
  g.addColorStop(0.5, rgba(c, light ? 0.55 : 0.45));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(head.x, head.y, R, 0, Math.PI * 2);
  ctx.fill();
  const L = (4.5 + Math.random() * 4) * sc;
  const rot = now / 260;
  ctx.strokeStyle = light ? rgba(c, 0.9) : "rgba(255,255,255,0.85)";
  ctx.lineWidth = 0.9 * Math.max(0.8, sc);
  for (const a of [rot, rot + Math.PI / 2]) {
    ctx.beginPath();
    ctx.moveTo(head.x - Math.cos(a) * L, head.y - Math.sin(a) * L);
    ctx.lineTo(head.x + Math.cos(a) * L, head.y + Math.sin(a) * L);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

/**
 * The one loop that draws every sparkler on the page, on one clock (performance.now() mod 2.8 s). It stops when
 * there's nothing to draw and starts again when a sparkler appears (see wakeSparklers); with reduced motion it
 * draws nothing.
 */
let running = false;
let last = 0;
const reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
// Reduced motion turned off: the sparklers on the page start again (turned on, the loop stops by itself).
reduced.addEventListener?.("change", () => wakeSparklers());
function frame(now) {
  const canvases = reduced.matches ? [] : document.querySelectorAll("canvas.sparkler");
  if (!canvases.length) {
    running = false;
    return;
  }
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const cv of canvases) draw(cv, now, dt);
  requestAnimationFrame(frame);
}
export function wakeSparklers() {
  if (running || reduced.matches || !document.querySelector("canvas.sparkler")) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}
/** The theme changed: every sparkler takes its colors again. */
export function rethemeSparklers() {
  theme++;
}
