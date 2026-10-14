import { esc, renderMarkdown } from "./md.js";
import { noteIntent } from "./intent.js";
import { limitMeters } from "./meters.js";
import { stripStatus } from "./status.js";
import { markAnimation, phases, rethemeSparklers, ringFor, ringParts, wakeSparklers, workKind } from "./rings.js";
import { LANES, Sessions, durationWords, phaseList, sessionWords, workWords } from "./phases.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const NAMES = { codex: "Codex", claude: "Claude", cursor: "Cursor", grok: "Grok", codexapp: "Codex app", toryo: "Toryo" };
// Agents are told apart by name and monogram, never by color: every monogram wears the same neutral tone.
const MONOGRAM = { codex: "Cx", claude: "Cl", cursor: "Cu", grok: "Gk", codexapp: "Cx" };
/** Found but waiting for a choice (the Codex app needs a thread) reads differently from absent. */
const missing = (a) => (a.needsSetup ? "not set up" : "not installed");
const KIND = {
  build: "Build", "build-fix": "Fixes", "build-next": "Next slice", "build-nudge": "Continuing", "build-answer": "After your answer",
  "build-gate": "Fixing checks", "build-note": "Your note", review: "Review", "review-status": "Review status", "review-answer": "Review, after your answer",
  "plan-proposal": "Proposal", "plan-critique": "Critique", "plan-synthesis": "Writing the plan", "plan-check": "Plan check",
  "plan-revise": "Plan revision", chat: "Reply", discuss: "Discussion", opinion: "Second opinion", "note-reply": "Answer to your note",
  "build-notes": "Building: your notes", "note-answer": "Answering your question",
};
const STATUS = {
  REVIEW: "Ready for review", CHANGES: "Changes requested", APPROVED: "Approved", OWNER: "Question for you", DONE: "Says it's done",
  PROPOSAL: "Proposal", CRITIQUE: "Critique", AGREE: "Agrees", DISAGREE: "Disagrees", REPLY: "Replied",
};
const name = (a) => NAMES[a] ?? a;

// Icons, drawn on a 24-pixel grid with the text's color.
const ICONS = {
  home: '<path d="M4 11.2 12 4.5l8 6.7V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  plan: '<path d="M12 3.5 19.5 8v8L12 20.5 4.5 16V8z"/><path d="M12 12.2 19.5 8M12 12.2V20.5M12 12.2 4.5 8"/>',
  build: '<path d="M12 4 20 8.2 12 12.4 4 8.2z"/><path d="M4 12.2l8 4.2 8-4.2"/><path d="M4 16l8 4.2 8-4.2"/>',
  review: '<path d="M12 20.5v-8"/><path d="M12 12.5c0-4.2-2.8-6.7-7-6.7 0 4.2 2.8 6.7 7 6.7z"/><path d="M12 10.5c0-3.7 2.6-6 6.6-6 0 3.7-2.6 6-6.6 6z"/>',
  chat: '<path d="M4.5 5.5h15v10.5H10l-5.5 4z"/>',
  checks: '<path d="M9.5 3.5h5M10.5 3.5v5.8L5.6 17.6A2 2 0 0 0 7.4 20.5h9.2a2 2 0 0 0 1.8-2.9l-4.9-8.3V3.5"/><path d="M7.6 14.5h8.8"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  check: '<path d="M5.5 12.5 10 17l8.5-9.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.8V12l2.8 1.8"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z"/>',
  system: '<rect x="3.5" y="5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  sliders: '<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2"/><circle cx="9" cy="16.5" r="2"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  file: '<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5"/>',
  chev: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  dots: '<circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18" cy="12" r="1.1"/>',
  rooms: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5z"/><path d="M10 20.5h4"/>',
  hand: '<path d="M8.5 12.5V6.8a1.5 1.5 0 0 1 3 0V11M11.5 11V5.3a1.5 1.5 0 0 1 3 0V11M14.5 11V6.8a1.5 1.5 0 0 1 3 0v6.7a7 7 0 0 1-7 7 6 6 0 0 1-5-2.7l-2.3-3.6a1.5 1.5 0 0 1 2.4-1.8l1.4 1.7"/>',
  sparkle: '<path d="M12 4.5l1.7 4.8 4.8 1.7-4.8 1.7L12 17.5l-1.7-4.8L5.5 11l4.8-1.7z"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
};
const ic = (n, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] ?? ""}</svg>`;
const markSvg = () => `<svg viewBox="0 0 512 512" aria-hidden="true"><use href="#mark"/></svg>`;
/**
 * An agent's monogram: the same neutral tile for every agent; the Codex app's has a window corner. While the agent
 * works, it wears that work's ring (`work`: a request's kind).
 */
function avatar(agent, size = 30, cls = "", work = "") {
  if (agent === "toryo" || !agent) return `<span class="avatar ${cls}" data-agent="toryo" style="--size:${size}px" title="Toryo">${markSvg()}</span>`;
  const ring = work ? ringParts({ ring: workKind(work), needs: false }, size, ic) : null;
  return `<span class="avatar ${cls}" data-agent="${esc(agent)}" ${ring?.attrs ?? ""} style="${ring?.style ?? `--size:${size}px`}" title="${esc(name(agent))}" aria-hidden="true">${esc(MONOGRAM[agent] ?? String(agent).slice(0, 2))}${agent === "codexapp" ? '<span class="app"></span>' : ""}${ring?.inner ?? ""}</span>`;
}
/** A room's tile: its initials, and the ring for what it's doing (rings.js). */
function roomTile(sum, size) {
  const ring = ringFor(sum);
  const parts = ringParts(ring, size, ic);
  return `<span class="tile" ${parts.attrs} data-ring-key="${ring.ring}:${ring.needs}:${esc(roomMono(sum.title))}" style="${parts.style}" aria-hidden="true">${esc(roomMono(sum.title))}${parts.inner}</span>`;
}
/** The room header's tile, drawn again only when what it shows changes (so its sparkler carries on). */
function paintHeadTile(sum) {
  const old = $("#roomTile");
  const next = el(roomTile(sum, 44));
  next.id = "roomTile";
  if (old.dataset.ringKey !== next.dataset.ringKey) old.replaceWith(next);
}
/** A room's monogram: the first letters of its first two words. */
const roomMono = (title) => String(title ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase() || "·";
/** What kind of work a turn is: building, reviewing, planning, or anything else. */
const activityOf = (kind) =>
  /^build|^gates/.test(kind ?? "") ? "build" : /^review|^plan-check/.test(kind ?? "") ? "review" : /^plan-/.test(kind ?? "") ? "plan" : "chat";

const S = {
  state: null,
  roomId: null,
  view: null,
  live: new Map(),
  plan: null,
  route: "auto",
  // What the note you're writing answers, fixed when you begin it or press "Write my own answer" (see bindAnswer):
  // { roomId, asker, byAgent: { agent: question id or null }, chosen, route }. Kept with the room's draft, and its
  // recipient, across room switches and reloads.
  answering: null,
  // Rooms with a note on its way; a room sends one at a time.
  sending: new Set(),
  // Each room's draft revision: it changes with the text, the recipient and a question you choose, so a reply to a
  // send acts only on the draft as it was sent.
  revisions: new Map(),
  // The saved revision of the draft this tab last loaded or wrote, per room (see revise).
  loaded: new Map(),
  // Ask or Tell for the next note, once you've chosen; until then the text decides (see intent.js).
  intent: null,
  rendered: new Map(),
  expanded: new Set(),
  // Folded rounds you've opened, so drawing the timeline again keeps them open.
  openFolds: new Set(),
  // Queued notes you're changing: what you've typed, the box you're typing in, and whether it has the focus (see
  // openEditor). What you type is also kept in the browser (see noteChanges).
  editing: new Map(),
  // Notes whose change is being saved right now, and the revision of the change sent.
  saving: new Map(),
  // The side panel's tab (wide screens), and the room's tab (narrower screens: the relay or one of the panels).
  sideTab: "plan",
  roomTab: "relay",
  // On a phone: Home, the rooms list or the room.
  pane: "home",
  // What the main view shows: Home or the room (null until the address has been read).
  page: null,
  // Home's overview (GET /api/home), and how many Recent items it shows.
  home: null,
  recent: 40,
  // Home's questions as last shown (a card whose question closes meanwhile still has its data), what went wrong
  // answering each, the ones being sent, and what the desk said about the last control you used.
  homeCards: new Map(),
  homeErrors: new Map(),
  homePending: new Set(),
  // Questions a send from Home found already answered elsewhere: their cards say so until dismissed.
  homeStale: new Set(),
  // Ready plans whose build was refused because another room is building in the folder: that room, to wait for.
  homeFolder: new Map(),
  deskResult: null,
  // The open room's session timeline (phases.js), kept event by event, and what it last showed.
  timeline: null,
  session: null,
  seen: readSeen(),
  connected: false,
};

// ------------------------------------------------------------------ utils

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-toryo": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error ?? data ?? res.statusText), { status: res.status, code: data?.code, room: data?.room });
  return data;
}

function readSeen() {
  try {
    return JSON.parse(localStorage.getItem("toryo.seen") ?? "{}");
  } catch {
    return {};
  }
}
function writeSeen() {
  try {
    localStorage.setItem("toryo.seen", JSON.stringify(S.seen));
  } catch {
    /* private mode */
  }
}
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "");
function since(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
function duration(a, b) {
  if (!a || !b) return "";
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function toast(title, body, ms = 6000) {
  const t = el(`<div class="toast"><p><b>${esc(title)}</b></p>${body ? `<small>${esc(body)}</small>` : ""}</div>`);
  const box = $("#toasts");
  box.appendChild(t);
  const max = matchMedia("(max-width: 920px)").matches ? 1 : 3;
  while (box.children.length > max) box.firstElementChild.remove();
  setTimeout(() => t.remove(), ms);
}
function fail(error) {
  toast("That didn't work", error?.message ?? String(error), 9000);
}
const room = () => S.view?.room;
const project = () => S.state?.config.projects.find((p) => p.id === room()?.projectId);
const isMember = (a) => room()?.crew.members.includes(a);

// ------------------------------------------------------------------ live connection

/**
 * Two notices. If the desk restarted with a different page, reloading picks it up. If the page files
 * changed on disk under a running desk, it keeps serving the page it started with, so only restarting
 * Toryo helps.
 */
const RESTART = "toryo quit && toryo";
function checkPageVersion(st) {
  if (!st?.webVersion) return;
  S.pageVersion ??= st.webVersion;
  const want = st.webVersion !== S.pageVersion ? "reload" : st.webOnDisk && st.webOnDisk !== st.webVersion ? "restart" : null;
  const current = $(".reloadbar");
  if ((current?.dataset.kind ?? null) === want) return;
  if (want === "restart" && S.barDismissed === st.webOnDisk) return;
  current?.remove();
  if (!want) return;
  const bar = el(
    want === "reload"
      ? `<div class="reloadbar" role="status" data-kind="reload"><span>Toryo restarted with an updated page.</span><button type="button" class="btn small primary" data-reload>Reload</button></div>`
      : `<div class="reloadbar" role="status" data-kind="restart"><span>Toryo has been updated. Restart Toryo to use it: <code>${esc(RESTART)}</code></span><button type="button" class="btn small primary" data-copy-restart>Copy</button><button type="button" class="btn small" data-dismiss-bar aria-label="Dismiss">✕</button></div>`,
  );
  bar.querySelector("[data-reload]")?.addEventListener("click", () => location.reload());
  bar.querySelector("[data-copy-restart]")?.addEventListener("click", () =>
    navigator.clipboard.writeText(RESTART).then(
      () => toast("Copied", RESTART),
      () => fail(new Error("The browser refused clipboard access.")),
    ),
  );
  bar.querySelector("[data-dismiss-bar]")?.addEventListener("click", () => {
    S.barDismissed = st.webOnDisk;
    bar.remove();
  });
  document.body.appendChild(bar);
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("open", () => {
    S.connected = true;
    renderDesk();
    // The room on the screen, fetched afresh; on Home, the room behind it waits until you go back to it.
    if (S.roomId && S.page === "room") loadRoom(S.roomId, { keepScroll: true });
    // Back after being cut off: a fresh overview, since anything may have changed meanwhile.
    if (S.page === "home") loadHome();
  });
  es.addEventListener("error", () => {
    S.connected = false;
    renderTop();
    if (S.page === "home") renderHome();
  });
  es.addEventListener("state", (e) => {
    S.state = JSON.parse(e.data);
    checkPageVersion(S.state);
    onState();
  });
  es.addEventListener("room", (e) => {
    const sum = JSON.parse(e.data);
    if (S.state) {
      const i = S.state.rooms.findIndex((r) => r.id === sum.id);
      if (i >= 0) S.state.rooms[i] = sum;
      else S.state.rooms.unshift(sum);
      renderRooms();
      renderDesk();
    }
    // The room you're in, fetched again; not while Home is showing (going back to it fetches it fresh).
    if (sum.id === S.roomId && S.page === "room") refreshRoomSoon();
    homeSoon();
  });
  es.addEventListener("event", (e) => {
    const { roomId, event } = JSON.parse(e.data);
    keepLiveCopy(roomId, event);
    // The room on the screen takes it in; on Home, going back to the room fetches it afresh.
    if (roomId === S.roomId && S.view && S.page === "room") upsertEvent(event);
    homeSoon();
  });
  es.addEventListener("activity", (e) => {
    const d = JSON.parse(e.data);
    if (d.roomId === S.roomId && S.page === "room") onActivity(d);
    if (S.page === "home") homeActivity(d);
  });
  es.addEventListener("notify", (e) => {
    const d = JSON.parse(e.data);
    toast(d.title, d.body, 9000);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(d.title, { body: d.body, icon: "/favicon.svg", tag: "toryo" });
      } catch {
        /* unsupported */
      }
    }
  });
}

/**
 * A room fetched whole is a picture of it when the desk answered, and updates that arrive live meanwhile can be newer
 * (a question answered from a terminal, a Ready card closed). While a fetch is on its way, the live updates are kept
 * and laid over what it brings back, with any events it missed, so an older copy never replaces a newer one. Each
 * update also arrives live, so whatever is laid over is at worst a moment old, and the next update corrects it.
 */
const liveCopies = { fetching: 0, events: new Map() };
function keepLiveCopy(roomId, event) {
  if (liveCopies.fetching) liveCopies.events.set(event.id, { roomId, event });
}
async function fetchView(id) {
  liveCopies.fetching++;
  try {
    const v = await api("GET", `/api/rooms/${id}`);
    const known = new Set(v.events.map((e) => e.id));
    v.events = v.events.map((e) => liveCopies.events.get(e.id)?.event ?? e);
    for (const { roomId, event } of liveCopies.events.values()) if (roomId === id && !known.has(event.id)) v.events.push(event);
    return v;
  } finally {
    if (--liveCopies.fetching === 0) liveCopies.events.clear();
  }
}

let refreshTimer = null;
let refreshes = 0;
function refreshRoomSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!S.roomId || S.page !== "room") return;
    const n = ++refreshes;
    // What was running before the fetch: what the desk no longer lists has ended. (Anything that started while the
    // fetch was on its way is kept: its own news brought it.)
    const had = new Set(S.live.keys());
    try {
      const v = await fetchView(S.roomId);
      // A later refresh started meanwhile: its picture is newer.
      if (n !== refreshes || v.room.id !== S.roomId) return;
      S.view.room = v.room;
      // The desk's word on what runs: when each started and what it is (a checks run's first news is its output,
      // which says neither), keeping the output the page has already shown.
      const listed = new Set(v.live.map((l) => l.turnId));
      for (const id of had) if (!listed.has(id)) S.live.delete(id);
      for (const l of v.live) {
        const mine = S.live.get(l.turnId);
        S.live.set(l.turnId, { ...l, activity: mine?.activity.length > l.activity.length ? mine.activity : l.activity });
      }
      // Only what changed is taken in, and the strip is drawn once, below, however many events the room has.
      for (const ev of v.events) if (S.rendered.get(ev.id) !== JSON.stringify(ev)) upsertEvent(ev, { quiet: true });
      renderTop();
      renderContext();
      renderCrew();
      renderComposer();
      loadPlan();
    } catch {
      /* next update will retry */
    }
  }, 120);
}

function onState() {
  renderRooms();
  if (!S.state.config.projects.length) {
    showPage("room");
    S.welcome = true;
    return renderWelcome();
  }
  // The first time, or once you've added your first project: the page the address names, a room or Home.
  if (!S.page || S.welcome) {
    S.welcome = false;
    route();
  } else homeSoon();
  renderTop();
  if (S.view) renderCrew();
}

/** The page the address names: a room (#/r/<id>), or Home (#/, or nothing). Back and forward follow it. */
function route() {
  const id = location.hash.match(/^#\/r\/([\w-]+)/)?.[1];
  if (id && S.state?.rooms.some((r) => r.id === id)) {
    if (id !== S.roomId || S.page !== "room") loadRoom(id, { open: true });
  } else showHome();
}

/** Show Home or the room in the main view (and, on a phone, its tab). */
function showPage(page) {
  S.page = page;
  $("#app").dataset.page = page;
  $("#home").hidden = page !== "home";
  $("#main").hidden = page !== "room";
  setPane(page);
}

function showHome() {
  const was = S.page;
  showPage("home");
  // An address that named nothing Home can show (an old room's): Home's own, without a new step back.
  if (!/^#\/?$/.test(location.hash) && location.hash !== "") history.replaceState(null, "", "#/");
  document.title = "Toryo";
  renderRooms();
  renderHome();
  loadHome();
  if (was === "room") $("#home").scrollTop = 0;
}

async function loadRoom(id, { keepScroll = false, open = false } = {}) {
  // Opening a room (a link, the address, a new room) shows it at once; fetching one again (a reconnect, a saved
  // setting) doesn't take you away from Home.
  if (open) showPage("room");
  try {
    const v = await fetchView(id);
    const switching = S.roomId !== id;
    S.roomId = id;
    S.view = v;
    if (switching) restoreDraft(v.room);
    S.live = new Map(v.live.map((l) => [l.turnId, l]));
    S.timeline = new Sessions();
    for (const ev of v.events) S.timeline.add(ev);
    if (switching) S.shownSession = null;
    if (S.page === "room" && location.hash !== `#/r/${id}`) history.replaceState(null, "", `#/r/${id}`);
    renderTop();
    renderRooms();
    renderTimeline(switching || !keepScroll);
    renderContext();
    renderCrew();
    renderComposer();
    loadPlan();
    if (switching) setRoomTab("relay");
  } catch (error) {
    if (/Unknown room/.test(error.message)) {
      // Forget it locally too, or onState would pick the same room again before the server's update arrives.
      if (S.state) S.state.rooms = S.state.rooms.filter((r) => r.id !== id);
      S.roomId = null;
      S.view = null;
      history.replaceState(null, "", "#/");
      showHome();
    } else fail(error);
  }
}

async function loadPlan() {
  const r = room();
  if (!r || (r.mode !== "build" && r.mode !== "plan")) {
    S.plan = null;
    return;
  }
  try {
    const before = currentSlice(r);
    S.plan = await api("GET", `/api/rooms/${r.id}/plan`);
    renderContext();
    // The slice in progress may take its name from the plan: the header and the slice's marker say it.
    if (currentSlice(r) !== before && room()?.id === r.id) {
      renderTop();
      const log = $("#log");
      const top = log.scrollTop;
      const stick = S.toEnd || log.scrollHeight - log.scrollTop - log.clientHeight < 120;
      renderTimeline(stick);
      if (!stick) scrollLog(top);
    }
  } catch {
    S.plan = null;
  }
}

// ------------------------------------------------------------------ header

function renderTop() {
  renderDesk();
  const r = room();
  const p = project();
  $("#roomhead").hidden = !r;
  $("#roomtabs").hidden = !r;
  if (!r) {
    document.title = "Toryo";
    return;
  }
  paintHeadTile(S.state?.rooms.find((x) => x.id === r.id) ?? { ...r, title: r.title });
  renderSession();
  wakeSparklers();
  $("#roomTitle").textContent = r.title;
  $("#roomWhere").innerHTML = p ? whereHtml(r, p) : "";
  // A room's own worktree stays said on a narrow screen (shortly: the label and Copy path).
  $("#roomWhere").classList.toggle("own", S.state?.rooms.find((x) => x.id === r.id)?.workspace?.kind === "worktree");
  for (const b of $$("#modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === r.mode));
  $("#rhState").innerHTML = stateSentence(r);
  const resumable = ["paused", "stopped", "pausing", "stopping"].includes(r.status);
  if (!$("#stopBtn").dataset.armed) $("#stopBtn").innerHTML = `${ic("stop")}<span class="lbl">Stop</span>`;
  $("#pauseBtn").innerHTML = `${ic(resumable ? "play" : "pause")}<span class="lbl">${resumable ? "Resume" : "Pause"}</span>`;
  $("#pauseBtn").setAttribute("aria-label", resumable ? "Resume" : "Pause");
  $("#pauseBtn").disabled = r.status === "done" || (r.status === "idle" && !r.queue?.length);
  if (resumable) $("#pauseBtn").disabled = false;
  $("#stopBtn").disabled = ["stopped", "done", "idle"].includes(r.status);
  $("#tabbar [data-view=room]").innerHTML = `${ic(r.mode === "plan" ? "plan" : r.mode === "build" ? "build" : "chat")}<span>${esc(r.title)}</span>`;
  document.title = `${r.status === "waiting" ? "● " : ""}${r.title} · Toryo`;
}

/**
 * Where a room works, for its header: the project's folder, shared (with the other rooms that use it), or its own
 * worktree, with its branch, its state while it's made, the main folder its changes are for, and a Copy button.
 */
function whereHtml(r, p) {
  const ws = S.state?.rooms.find((x) => x.id === r.id)?.workspace;
  if (ws?.kind !== "worktree") return `${esc(p.name)} · <span title="This room works in the project's own folder">${esc(p.path)}</span>${ws?.others?.length ? ` · ${sharedText(ws.others)}` : ""}`;
  const state = ws.state === "ready" ? "" : ws.state === "failed" ? " · <b>couldn't be made</b>" : " · being made…";
  return `${esc(p.name)} · <span class="wsk">${ic("build")}Own worktree</span> <span class="mono wsp">${esc(ws.path)}</span> ${copyPathBtn(ws.path)}<span class="wsp"> · branch <span class="mono">${esc(ws.branch)}</span></span>${state}`;
}

/** A small Copy button for a folder's path (narrow screens can't select a long one easily). */
const copyPathBtn = (path) => `<button type="button" class="linkbtn" data-copy-path="${esc(path)}" title="Copy this folder's path">Copy path</button>`;

/** Where a build will work, chosen before it starts: its own worktree, or the project's folder (shared), each with its exact folder. */
function folderChoice(prefix, preview, { appCrew = false } = {}) {
  const own = preview?.own && !appCrew;
  const pick = own && preview.defaultFolder === "own" ? "own" : "shared";
  const why = appCrew ? "The Codex app works in the project's own folder only." : preview?.why ?? "";
  return `<div class="field" id="${prefix}Where"><span class="lbl">Where it works</span>
    <label class="opt"><input type="radio" name="${prefix}Folder" value="own" ${pick === "own" ? "checked" : ""} ${own ? "" : "disabled"}> <span><b>Its own worktree</b>${own ? `: <span class="mono">${esc(preview.own.path)}</span> (branch <span class="mono">${esc(preview.own.branch)}</span>). A separate copy of the project's folder as it is now, uncommitted changes included, so this build doesn't share files with anyone. Bringing its changes back to the main folder comes in a later update.` : why ? `: ${esc(why)}` : ""}</span></label>
    <label class="opt"><input type="radio" name="${prefix}Folder" value="shared" ${pick === "shared" ? "checked" : ""}> <span><b>This folder (shared)</b>: <span class="mono">${esc(preview?.shared?.path ?? "")}</span>. One build at a time works here.</span></label></div>`;
}

/**
 * The slice the build is on. Its name comes with the builder's handoff, so right after an approval it's still
 * the approved one's: until then, the plan's next unfinished slice is the one being built.
 */
function currentSlice(r) {
  const b = r?.build;
  if (!b) return "";
  if (b.slice && !b.approved.includes(b.slice)) return b.slice;
  const next = (S.plan?.slices ?? []).find((x) => !x.approved);
  return next ? `${next.kind ?? "Slice"} ${next.number}: ${next.name}` : b.slice ? "the next slice" : "";
}

/** The top bar's counts: rooms working, and questions waiting for you, across the desk. */
function renderDesk() {
  if (!S.state) return;
  const kinds = new Set(S.state.rooms.filter((r) => r.status !== "paused").flatMap((r) => (r.working ?? []).map((w) => workKind(w.kind))));
  const key = [...kinds].sort().join();
  if ($("#liveMark").dataset.kinds !== key) {
    $("#liveMark").dataset.kinds = key;
    $("#liveMark").style.animation = markAnimation(kinds);
  }
  const working = S.state.rooms.filter((r) => r.running?.length).length;
  const asks = S.state.rooms.reduce((n, r) => n + (r.questions?.length ?? (r.waiting ? 1 : 0)), 0);
  $("#deskchips").innerHTML = [
    S.connected ? "" : `<span class="chip" data-k="offline"><span class="dot"></span>Reconnecting…</span>`,
    working ? `<span class="chip" data-k="work" title="Rooms where an agent or the checks are working"><span class="dot"></span>${working} working</span>` : "",
    asks ? `<button type="button" class="chip" data-k="you" data-next-ask title="Go to the oldest question waiting for you"><span class="dot"></span>${asks} need${asks === 1 ? "s" : ""} you</button>` : "",
  ].join("");
}

/** What the room is doing, in a sentence: who is working on what and for how long, and whether it needs you. */
function stateSentence(r) {
  if (!S.connected) return `${ic("alert")}<span>Reconnecting to the desk…</span>`;
  const sum = S.state?.rooms.find((x) => x.id === r.id);
  const asks = sum?.questions?.length ?? (r.waiting ? 1 : 0);
  const parts = [];
  if (r.status === "done") return `<span class="act-k" data-k="review">${ic("check")}Done</span><span>${r.mode === "build" ? `The build is finished: ${r.build?.approved?.length ?? 0} slice${r.build?.approved?.length === 1 ? "" : "s"} approved, then the final review.` : "Finished."}</span>`;
  if (r.status === "paused" || r.status === "stopped") parts.push(`<span class="act-k">${ic("pause")}${r.status === "paused" ? "Paused" : "Stopped"}</span><span>${r.status === "paused" ? "Paused by you. Nothing new starts until you resume." : "Stopped. Write to the crew, or resume, to carry on."}</span>`);
  if (r.status === "pausing") parts.push(`<span class="act-k">${ic("pause")}Pausing</span><span>The turn running now finishes; nothing new starts.</span>`);
  if (r.status === "stopping") parts.push(`<span class="act-k">${ic("stop")}Stopping</span>`);
  const live = [...S.live.values()];
  if (live.length) {
    const kind = activityOf(live[0].kind);
    const verb = { build: "building", review: "reviewing", plan: "planning", chat: "replying" }[kind];
    const who = live.map((l) => name(l.agent)).join(" and ");
    const what = r.mode === "build" && currentSlice(r) ? ` · ${esc(currentSlice(r))}${r.build.round > 1 ? `, round ${r.build.round}` : ""}` : "";
    parts.push(`<span class="act-k" data-k="${kind === "chat" ? "" : kind}">${ic(kind === "chat" ? "chat" : kind)}${verb[0].toUpperCase() + verb.slice(1)}</span><span>${esc(who)} ${live.length > 1 ? "are" : "is"} ${verb}${what} · <span class="timer" data-since="${esc(live[0].startedAt)}">${since(live[0].startedAt)}</span></span>`);
  } else if (r.activeGate || r.status === "checking") parts.push(`<span class="act-k">${ic("checks")}Checks</span><span>The project's checks are running.</span>`);
  if (asks) parts.push(`<span class="act-k" data-k="you">${ic("hand")}Needs you</span><span>${asks === 1 ? `${r.waiting?.from ? `${esc(name(r.waiting.from))} asks you something` : "A question is waiting"}` : `${asks} questions are waiting`}</span>`);
  if (r.status === "held") parts.push(`<span class="act-k">${ic("lock")}Held</span><span>Waiting: ${esc([...new Set((sum?.blocked ?? []).flatMap((b) => b.reasons))].join("; ") || "held")}</span>`);
  // One builder per folder: the rooms whose build waits for this one.
  if (sum?.folder?.waiting?.length) parts.push(`<span class="act-k">${ic("lock")}Folder</span><span>${esc(waitingWords(sum.folder.waiting))}</span>`);
  if (r.status === "queued" && !live.length) parts.push(`<span>Starting…</span>`);
  if (!parts.length) parts.push(`<span>Idle. Write to the crew to start.</span>`);
  return parts.join("");
}

// ------------------------------------------------------------------ rail: rooms by project

function renderRooms() {
  const box = $("#rooms");
  if (!S.state) return;
  const byProject = new Map();
  for (const r of S.state.rooms) {
    if (!byProject.has(r.projectId)) byProject.set(r.projectId, []);
    byProject.get(r.projectId).push(r);
  }
  const before = new Map($$(".roomlink[data-room]", box).map((b) => [b.dataset.room, b.querySelector(".tile")]));
  const asks = S.state.rooms.reduce((n, r) => n + (r.questions?.length ?? (r.waiting ? 1 : 0)), 0);
  const home = `<a class="roomlink railhome" href="#/" aria-current="${S.page === "home" ? "page" : "false"}"><span class="homeico" aria-hidden="true">${ic("home")}</span><span class="ri-text"><span class="ri-name">Home</span><span class="ri-state">Every room at a glance</span></span>${asks ? `<span class="count" title="Questions waiting for you">${asks}</span>` : ""}</a>`;
  box.innerHTML = home + S.state.config.projects
    .map((p) => {
      const rooms = byProject.get(p.id) ?? [];
      return `<div class="railgroup"><p class="eyebrow">${esc(p.name)}</p>${rooms.length ? "" : `<div class="hint none">No rooms yet.</div>`}${rooms
        .map((r) => {
          const st = railState(r);
          return `<button type="button" class="roomlink" data-room="${r.id}" data-state="${r.status}" aria-current="${S.page === "room" && r.id === S.roomId}" title="${esc(`${r.title}: ${st.says}`)}">
            ${roomTile(r, 32)}<span class="ri-text"><span class="ri-name">${esc(r.title)}</span><span class="ri-state" ${st.k ? `data-k="${st.k}"` : ""}>${esc(st.text)}</span></span></button>`;
        })
        .join("")}</div>`;
    })
    .join("");
  for (const link of $$(".roomlink[data-room]", box)) {
    const old = before.get(link.dataset.room);
    const tile = link.querySelector(".tile");
    if (old && old.dataset.ringKey === tile.dataset.ringKey) tile.replaceWith(old);
  }
  wakeSparklers();
}

// What a room is doing, in one line. What needs you comes first; then who is working on what; otherwise its state.
const TASK = (kind) =>
  /^build/.test(kind ?? "") ? "building"
  : /^review/.test(kind ?? "") ? "reviewing"
  : kind === "plan-check" ? "checking the plan"
  : kind === "plan-proposal" ? "writing a proposal"
  : kind === "plan-critique" ? "critiquing the proposals"
  : kind === "plan-synthesis" || kind === "plan-revise" ? "writing the plan"
  : kind === "gates" ? "running the checks"
  : kind === "note-reply" || kind === "note-answer" ? "answering your question"
  : kind === "discuss" ? "discussing"
  : kind === "opinion" ? "giving a second opinion"
  : "replying";
const ROOM_STATE = { paused: "Paused", pausing: "Pausing after this turn", stopping: "Stopping", stopped: "Stopped", done: "Done", queued: "Starting", held: "Held", idle: "Idle" };
function railState(r) {
  const working = r.working ?? [];
  const asks = r.questions?.length ?? (r.waiting ? 1 : 0);
  const doing = working.slice(0, 2).map((w) => `${name(w.agent)} ${TASK(w.kind)}`);
  const says = [];
  if (asks) says.push(r.waiting?.from ? `${name(r.waiting.from)} is waiting for your answer` : "Waiting for you");
  says.push(...doing.map((d) => d.replace(/ (building|reviewing|replying|discussing)/, " is $1")));
  const held = r.status === "held" ? `Held: ${[...new Set((r.blocked ?? []).flatMap((b) => b.reasons))].join("; ")}` : "";
  if (held) says.push(held);
  if (!asks && !working.length && !held && ROOM_STATE[r.status]) says.push(ROOM_STATE[r.status]);
  says.push(`${r.mode} room`);
  let text;
  let k = "";
  if (asks && doing.length) [text, k] = [`${doing[0]} · needs you`, "you"];
  else if (asks) [text, k] = [asks > 1 ? `Needs you · ${asks} questions` : r.waiting?.from ? `Needs you · ${name(r.waiting.from)} asks` : "Needs you", "you"];
  else if (doing.length) [text, k] = [doing.join(", "), "work"];
  else if (held) text = held;
  else text = ROOM_STATE[r.status] ?? r.status;
  if (r.status === "stopped" && !doing.length && !asks) k = "";
  return { text, k, says: says.join(" · ") };
}

function renderContext() {
  const box = $("#context");
  const r = room();
  renderLedger();
  if (!r) {
    box.innerHTML = "";
    return;
  }
  let html = "";
  if (r.mode === "build" && r.build) {
    const plan = S.plan;
    const slices = plan?.slices ?? [];
    const done = slices.filter((x) => x.approved).length;
    // The slice being built: the one named in the last handoff, or (right after an approval) the next unfinished one.
    const now = r.status === "done" ? -1 : slices.findIndex((x) => x.current && !x.approved) >= 0 ? slices.findIndex((x) => x.current && !x.approved) : slices.findIndex((x) => !x.approved);
    // And what's happening to it: building, a review, the checks, or nothing right now.
    const work = S.state?.rooms.find((x) => x.id === r.id)?.working?.[0];
    const k = work && ["build", "review", "checks"].includes(workKind(work.kind)) ? workKind(work.kind) : "idle";
    box.setAttribute("style", phases());
    const worked = (plan?.times ?? []).reduce((t, x) => t + (x.active ?? 0), 0);
    html += `<div class="progress"><div class="ph"><strong>${r.build.planPath ? `<a href="#" class="file" data-file="${esc(r.build.planPath)}">${esc(r.build.planPath.split("/").pop())}</a>` : "No plan file"}</strong>${slices.length ? `<span class="muted num">${done} of ${slices.length}</span>` : ""}</div>
      ${slices.length ? `<div class="segbar" aria-hidden="true">${slices.map((x, i) => `<i data-s="${x.approved ? "done" : i === now ? "now" : "todo"}" ${i === now ? `data-k="${k}"` : ""} title="${esc(`${x.kind ?? "Slice"} ${x.number}: ${x.name}`)}"></i>`).join("")}</div>` : ""}
      ${worked ? `<span class="hint">${shortDuration(worked)} of approved work so far</span>` : ""}</div>`;
    if (slices.length) {
      html += `<ol class="slices">${slices
        .map((x, i) => {
          const st = x.approved ? "done" : i === now ? "current" : "todo";
          const took = x.approved && x.took ? `<span class="took" title="${esc(`${shortDuration(x.took.active)} of agent and check time over ${x.took.rounds} review round${x.took.rounds === 1 ? "" : "s"}; ${shortDuration(x.took.wall)} from start to approval, including pauses and waiting`)}">(${shortDuration(x.took.active)})</span>` : x.checks ? `<span class="n">${x.checked}/${x.checks}</span>` : "";
          return `<li class="slice" data-state="${st}" ${st === "current" ? `data-k="${k}"` : ""}><span class="mark">${x.approved ? ic("check") : esc(x.number)}</span><span class="name">${esc(x.name)}${st === "current" ? `<br><span class="hint">${r.build.round && x.current ? `Round ${r.build.round} of at most ${r.settings.maxRounds}` : [...S.live.values()].length ? "Being built" : "Up next"}</span>` : ""}</span>${took}</li>`;
        })
        .join("")}</ol>`;
    } else if (plan?.missing) html += `<p class="sideintro">The plan file doesn't exist yet.</p>`;
    else if (!r.build.planPath) html += `<p class="sideintro">No plan file: the builder agrees slices as it goes.</p>`;
    html += `<div class="facts">
      ${currentSlice(r) ? `<div>Current: <b>${esc(currentSlice(r))}</b></div>` : ""}
      <div>Review rounds on this slice: <b>${r.build.round}</b> of ${r.settings.maxRounds}</div>
      <div>Approved: <b>${r.build.approved.length}</b>${r.build.approved.length ? ` (${r.build.approved.map((a) => { const t = [...(plan?.times ?? [])].reverse().find((x) => x.label === a); return esc(a) + (t ? ` · ${shortDuration(t.active)}` : ""); }).join(", ")})` : ""}</div>
      <div>After approval: <b>${r.settings.autoContinue ? "continue automatically" : "wait for you"}</b></div>
      <div>Reviewer: <b>${r.settings.freshReviewer !== false ? "fresh for each new slice" : "one session throughout"}</b></div></div>`;
  } else if (r.mode === "plan" && r.plan) {
    const order = ["proposals", "critiques", "checkpoint", "synthesis", "check", "ready"];
    const labels = ["Independent proposals", "Critiques", "Your call", "Plan written", "Plan check", "Ready to build"];
    const phase = r.plan.phase === "revision" ? "check" : r.plan.phase;
    const at = order.indexOf(phase);
    html += `<div class="progress"><div class="ph"><strong>${esc(r.plan.topic)}</strong></div></div><ol class="phases">${labels
      .map((l, i) => `<li data-state="${i < at ? "done" : i === at ? "now" : "todo"}">${l}</li>`)
      .join("")}</ol>
      <div class="facts"><div>Plan file: <a href="#" class="file mono" data-file="${esc(r.plan.planPath)}">${esc(r.plan.planPath)}</a></div>
      <div>Planners: <b>${r.plan.participants.map(name).join(", ")}</b></div>
      <div>After your changes: <b>${r.plan.participants.length < 2 ? "no other planner to check them" : r.settings.recheckAfterChanges !== false ? "the other planners check them once" : "no check (Re-check after changes is off)"}</b></div></div>`;
  } else {
    html += `<p class="sideintro">A conversation with <b>${r.crew.members.map(name).join(", ")}</b>. Use Plan for a structured planning round, Build for the build-and-review relay.</p>
      ${r.discuss ? `<div class="facts"><div>Discussion: round <b>${r.discuss.round}</b> of ${r.discuss.rounds}</div></div>` : ""}`;
  }

  const events = S.view.events;
  const open = events.filter((e) => e.type === "question" && e.open);
  const closed = events.filter((e) => e.type === "question" && !e.open).slice(-4).reverse();
  if (open.length || closed.length) {
    html += `<div class="ctx"><p class="eyebrow">Questions for you</p><div class="qlist">${open
      .map((q) => `<button type="button" class="qitem" data-jump="${q.id}"><b>${q.from ? `${esc(name(q.from))} asks` : "Your call"}</b>${esc(q.question)}</button>`)
      .join("")}${closed
      .map((q) => `<div class="qitem closed"><b>Answered</b>${esc(q.question)}<span class="hint">→ ${esc(q.answer ?? "")}</span></div>`)
      .join("")}</div></div>`;
  }

  const docs = new Map();
  for (const t of events)
    if (t.type === "turn")
      for (const f of t.files ?? [])
        if (/\.(md|mdx)$/i.test(f.path) || /(^|\/)(docs|decisions|adr|plans)\//i.test(f.path)) docs.set(f.path, { ...f, agent: t.agent, at: t.endedAt });
  if (docs.size) {
    html += `<div class="ctx"><p class="eyebrow">Shared docs touched here</p><div class="facts">${[...docs.values()]
      .reverse()
      .slice(0, 12)
      .map((d) => `<div><a href="#" class="file mono" data-file="${esc(d.path)}">${esc(d.path)}</a> <span class="hint">· ${esc(name(d.agent))}</span></div>`)
      .join("")}</div></div>`;
  }
  box.innerHTML = html;
}

/** The ledger a fresh reviewer reads first: findings still open from earlier slices, and your decisions. */
function renderLedger() {
  const box = $("#ledger");
  const r = room();
  if (!r) {
    box.innerHTML = "";
    return;
  }
  const ledger = r.ledger ?? [];
  const open = ledger.filter((e) => e.kind !== "decision" && e.state === "open");
  const decisions = ledger.filter((e) => e.kind === "decision");
  const resolved = ledger.length - open.length - decisions.length;
  if (!open.length && !decisions.length) {
    box.innerHTML = `<p class="sideintro">No open findings or decisions in this room yet. The ledger fills from reviews and your answers, and a reviewer starting fresh reads it first.</p>${resolved ? `<p class="hint">${resolved} finding${resolved === 1 ? "" : "s"} resolved.</p>` : ""}`;
    return;
  }
  box.innerHTML = `<p class="sideintro">What a reviewer starting fresh reads first: findings still open from earlier slices, and your answers.</p>
    <ul class="ledger">${open
      .map((f) => `<li title="${esc(f.text)}"><b>${esc(f.id)} · open</b><span>${esc(f.text.split("\n")[0].slice(0, 200))}</span><small>${esc(f.slice || "No slice")}</small></li>`)
      .join("")}${decisions
      .slice(-8)
      .map((d) => `<li title="${esc(d.question)}"><b>${esc(d.id)} · you decided</b><span>${esc(String(d.answer).slice(0, 200))}</span><small>${esc(d.slice || "")}${d.question ? ` · ${esc(String(d.question).slice(0, 120))}` : ""}</small></li>`)
      .join("")}</ul>${resolved ? `<p class="hint">${resolved} finding${resolved === 1 ? "" : "s"} resolved.</p>` : ""}`;
}

// ------------------------------------------------------------------ timeline

/**
 * Put the timeline at `top`, or at its end. At once: the timeline scrolls smoothly for your own jumps, and a smooth
 * scroll cut short by drawing the timeline again would stop wherever it had got to.
 */
function scrollLog(top) {
  const log = $("#log");
  log.scrollTo({ top: top ?? log.scrollHeight, behavior: "instant" });
}

const BUILDER_KINDS = new Set(["build", "build-fix", "build-next", "build-nudge", "build-answer", "build-gate", "build-note", "build-notes"]);

/**
 * A build's timeline in slices and review rounds. A round runs from a building turn to the reviewer's verdict
 * (anything after the verdict, until the next building turn, stays with it); a slice runs from its first round to
 * its approval. Events before the first building turn stand on their own.
 */
function sliceStructure(events) {
  const slices = [];
  const where = new Map();
  let slice = null;
  let round = null;
  for (const e of events) {
    const building = e.type === "turn" && BUILDER_KINDS.has(e.kind);
    if (building && (!slice || slice.approved)) {
      slice = { label: "", rounds: [], approved: false };
      slices.push(slice);
      round = null;
    }
    if (!slice) continue;
    if (building && (!round || round.verdict)) {
      round = { events: [], verdict: null };
      slice.rounds.push(round);
    }
    round.events.push(e);
    where.set(e.id, { slice, round });
    if (building && e.status === "REVIEW" && e.detail) slice.label = e.detail.split("|")[0].trim();
    if (e.type === "turn" && /^review/.test(e.kind) && e.state === "done" && (e.status === "CHANGES" || e.status === "APPROVED")) {
      round.verdict = e.status;
      if (e.status === "APPROVED") slice.approved = true;
    }
  }
  return { slices, where };
}

/** The earlier rounds of a slice, folded into one line: those before the last, while nothing in them is open. */
function foldedRounds(slice) {
  const fold = [];
  for (const rd of slice.rounds.slice(0, -1)) {
    if (rd.events.some((e) => (e.type === "question" && e.open) || (e.type === "turn" && e.state === "running"))) break;
    fold.push(rd);
  }
  return fold;
}

function sliceMarker(slice, current) {
  const label = slice.label || current || "";
  const no = label.match(/\b(?:slice|step|task|phase|stage|milestone)\s*#?([0-9]+[a-z]?)\b/i)?.[1] ?? "·";
  const rounds = slice.rounds.length;
  const first = slice.rounds[0]?.events[0];
  const note = slice.approved ? `Approved after ${rounds} round${rounds === 1 ? "" : "s"}` : `Round ${rounds}${first ? ` · started at ${clock(first.startedAt ?? first.at)}` : ""}`;
  return el(`<div class="slicemark"><span class="no" aria-hidden="true">${esc(no)}</span><strong>${esc(label || "A new slice")}</strong><span class="muted">${esc(note)}</span></div>`);
}

function foldEl(rounds, key) {
  const evs = rounds.flatMap((rd) => rd.events);
  const changes = rounds.filter((rd) => rd.verdict === "CHANGES").length;
  const answers = evs.filter((e) => e.type === "owner" && e.kind === "answer").length;
  const from = evs[0];
  const to = [...evs].reverse().find((e) => e.endedAt || e.at);
  const took = from && to ? duration(from.startedAt ?? from.at, to.endedAt ?? to.at) : "";
  const label = rounds.length === 1 ? "Round 1" : `Rounds 1 to ${rounds.length}`;
  const box = el(`<details class="rounds" data-fold="${esc(key)}" ${S.openFolds.has(key) ? "open" : ""}><summary>${ic("dots")}<b>${label}</b><span class="muted">${[took, `${changes} review${changes === 1 ? "" : "s"} asked for changes`, answers ? `you answered ${answers} question${answers === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}</span>${ic("chev", "i chev")}</summary><div class="inner"></div></details>`);
  return box;
}

/** An earlier session, folded into one line: its number, dates and phase totals; it opens to show it. */
function sessionFoldEl(k, part) {
  const v = S.timeline.view(k);
  const iso = (ms) => new Date(ms).toISOString();
  const turns = part.filter((e) => e.type === "turn" && !e.imported).length;
  const key = `session:${k}`;
  return el(`<details class="rounds sessionfold" data-fold="${key}" data-session="${k}" ${S.openFolds.has(key) ? "open" : ""}><summary>${ic("dots")}<b>Session ${S.timeline.list[k].n}</b><span class="muted">${[`${whenText(iso(v.start))} to ${whenText(iso(v.end))}`, workWords(v.totals), `${turns} turn${turns === 1 ? "" : "s"}`].map(esc).join(" · ")}</span>${ic("chev", "i chev")}</summary><div class="inner"></div></details>`);
}

/** Where a new session began: who starts fresh, who keeps their memory, and what ended with the one before. */
function sessionMarkEl(ev) {
  const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] ?? "");
  const fresh = (ev.fresh ?? []).map(name);
  const kept = (ev.kept ?? []).filter((a) => a !== "codexapp").map(name);
  const bits = [
    fresh.length ? `${and(fresh)} start${fresh.length === 1 ? "s" : ""} fresh` : "",
    kept.length ? `${and(kept)} keep${kept.length === 1 ? "s its" : " their"} memory` : "",
    ev.kept?.includes("codexapp") ? "the Codex app keeps its thread" : "",
    ev.closed?.length ? `${ev.closed.length} question${ev.closed.length === 1 ? "" : "s"} closed` : "",
    ev.notSent?.length ? `${ev.notSent.length} note${ev.notSent.length === 1 ? "" : "s"} not sent` : "",
  ].filter(Boolean);
  return el(`<div class="slicemark sessionmark" data-id="${esc(ev.id)}"><span class="no" aria-hidden="true">${esc(ev.n)}</span><strong>Session ${esc(ev.n)} started</strong><span class="muted">${esc([whenText(ev.at), ...bits].join(" · "))}</span></div>`);
}

/** Opens every fold a message is in (a folded round, an earlier session), so it can be seen. */
function openFoldsAround(node) {
  for (let d = node?.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
}

function renderTimeline(scroll = true) {
  const log = $("#log");
  rememberEditors();
  log.innerHTML = "";
  S.rendered = new Map();
  const r = room();
  if (!r) return;
  const events = S.view.events;
  const lastSeen = S.seen[r.id];
  const idx = lastSeen ? events.findIndex((e) => e.id === lastSeen) : events.length - 1;
  const fresh = idx >= 0 ? events.slice(idx + 1) : [];
  const freshTurns = fresh.filter((e) => e.type === "turn" && e.state === "done");
  if (freshTurns.length >= 2) {
    const approved = fresh.filter((e) => e.type === "turn" && e.status === "APPROVED").length;
    const asks = events.filter((e) => e.type === "question" && e.open).length;
    const firstId = fresh[0]?.id;
    log.appendChild(
      el(`<div class="away">${ic("sparkle")}<span><b>While you were away:</b> ${freshTurns.length} turns${approved ? `, ${approved} approval${approved > 1 ? "s" : ""}` : ""}${asks ? `, ${asks} question${asks > 1 ? "s" : ""} waiting for you` : ""}.</span>
        <button type="button" class="btn small" data-jump="${firstId}">Jump to the first new message</button><button type="button" class="iconbtn" data-dismiss title="Dismiss" aria-label="Dismiss">${ic("x")}</button></div>`),
    );
  }
  // Earlier sessions fold, one line each, which opens to show it; the current session is drawn as usual.
  const starts = events.flatMap((e, i) => (e.type === "session" ? [i] : []));
  starts.forEach((to, k) => {
    const part = events.slice(k ? starts[k - 1] : 0, to);
    const fold = sessionFoldEl(k, part);
    for (const ev of part) {
      const node = renderEvent(ev);
      if (node) $(".inner", fold).appendChild(node);
      S.rendered.set(ev.id, JSON.stringify(ev));
    }
    log.appendChild(fold);
  });
  const current = starts.length ? events.slice(starts.at(-1)) : events;
  // In a build, each slice gets a marker, and its earlier rounds fold into one line.
  const { slices, where } = r.mode === "build" ? sliceStructure(current) : { slices: [], where: new Map() };
  const foldOf = new Map();
  slices.forEach((sl, n) => {
    const rounds = foldedRounds(sl);
    const fold = { rounds, key: `${n}:${rounds.length}`, box: null };
    for (const rd of rounds) for (const e of rd.events) foldOf.set(e.id, fold);
  });
  const marked = new Set();
  for (const ev of current) {
    const at = where.get(ev.id);
    if (at && !marked.has(at.slice)) {
      marked.add(at.slice);
      log.appendChild(sliceMarker(at.slice, at.slice === slices.at(-1) ? currentSlice(r) : ""));
    }
    const fold = foldOf.get(ev.id);
    if (fold && !fold.box) log.appendChild((fold.box = foldEl(fold.rounds, fold.key)));
    const node = renderEvent(ev);
    if (node) (fold ? $(".inner", fold.box) : log).appendChild(node);
    S.rendered.set(ev.id, JSON.stringify(ev));
  }
  if (scroll && S.focusOn) {
    // Opened to show one message (the oldest question waiting for you): that one, not the end.
    const id = S.focusOn;
    requestAnimationFrame(() => {
      const card = $(`#log [data-id="${CSS.escape(id)}"]`);
      openFoldsAround(card);
      const at = card?.getBoundingClientRect();
      const box = log.getBoundingClientRect();
      if (card) scrollLog(Math.max(0, log.scrollTop + at.top - box.top - (log.clientHeight - at.height) / 2));
      else scrollLog();
      if (S.focusOn === id) S.focusOn = null;
    });
  } else if (scroll) {
    // Until the scroll happens, a timeline drawn again in the meantime goes to the end too.
    S.toEnd = true;
    requestAnimationFrame(() => {
      scrollLog();
      S.toEnd = false;
    });
  }
  markSeenSoon();
}

function upsertEvent(ev, { quiet = false } = {}) {
  const events = S.view.events;
  // The session's timeline takes it in (only what it says changes: no rescan); a refresh draws the strip once.
  if (S.timeline && ["turn", "gate", "question", "owner", "mark", "system", "session"].includes(ev.type)) {
    S.timeline.add(ev);
    if (!quiet) renderSession();
  }
  // A checks run that ended, with its result or cut short: no longer running.
  if (ev.runId) S.live.delete(ev.runId);
  const i = events.findIndex((e) => e.id === ev.id);
  const before = i >= 0 ? events[i] : null;
  if (i >= 0) events[i] = ev;
  else events.push(ev);
  if (ev.type === "turn") {
    if (ev.state === "running" && !S.live.has(ev.id))
      S.live.set(ev.id, { turnId: ev.id, agent: ev.agent, kind: ev.kind, startedAt: ev.startedAt, activity: [] });
    if (ev.state !== "running") S.live.delete(ev.id);
  }
  const json = JSON.stringify(ev);
  if (S.rendered.get(ev.id) === json) return;
  S.rendered.set(ev.id, json);
  const log = $("#log");
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  // In a build, a turn starting or ending can open a slice or a round, or fold the one before: draw it all again.
  // While a plan is ready, a turn ending or the Ready card opening or closing moves the button that forwards a discussion.
  const turnMoved = ev.type === "turn" && (!before || before.state !== ev.state);
  const readyMoved = ev.type === "question" && ev.kind === "plan-ready" && before?.open !== ev.open;
  const planReady = events.some((e) => e.type === "question" && e.kind === "plan-ready" && e.open);
  // A new session (from here, another window, the terminal) folds the one before it, in any room.
  const sessionStarted = ev.type === "session" && !before;
  if (sessionStarted || (room()?.mode === "build" && turnMoved) || readyMoved || (turnMoved && planReady)) {
    const top = log.scrollTop;
    renderTimeline(false);
    requestAnimationFrame(() => scrollLog(stick ? undefined : top));
    if (!quiet) {
      renderContext();
      renderCrew();
      renderTop();
      if (ev.state !== "running") loadPlan();
    }
    return;
  }
  rememberEditors();
  const node = renderEvent(ev);
  const old = log.querySelector(`[data-id="${CSS.escape(ev.id)}"]`);
  if (old) {
    if (node) old.replaceWith(node);
    else old.remove();
  } else if (node) log.appendChild(node);
  if (stick) requestAnimationFrame(() => scrollLog());
  if (!quiet) {
    renderContext();
    renderCrew();
    renderTop();
    if (ev.type === "turn" && ev.state !== "running") loadPlan();
  }
  markSeenSoon();
}

function renderEvent(ev) {
  switch (ev.type) {
    case "system":
      // A note of files changed between a build's turns: the full list, folded, when the line names only some.
      return el(`<div class="sys ${ev.level === "warn" ? "warn" : ""}" data-id="${ev.id}"><time>${clock(ev.at)}</time><span>${esc(ev.text)}${ev.writesFrom && ev.files?.length > 20 ? `<details><summary>All ${ev.files.length} files</summary><ul class="mono">${ev.files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>` : ""}</span></div>`);
    case "owner":
      return ownerEl(ev);
    case "turn":
      return turnEl(ev);
    case "question":
      return questionEl(ev);
    case "gate":
      return gateEl(ev);
    case "session":
      return sessionMarkEl(ev);
    default:
      return null;
  }
}

function ownerEl(ev) {
  const to = (ev.to ?? []).map(name);
  const label = { topic: "Planning topic", decisions: "Your decisions", answer: "Your answer", "change-request": "Change request" }[ev.kind] ?? "";
  // A note no agent has yet can still be changed or withdrawn, unless it answered a question (it stays as sent).
  const queued = !ev.kind && !ev.answers?.length && !ev.cancelled && !ev.notSent?.length && !ev.deliveredTo?.length && !Object.keys(ev.readBy ?? {}).length;
  const node = el(`<div class="owner" data-id="${ev.id}" data-cancelled="${Boolean(ev.cancelled)}">
    <div class="to">${label ? `${label} · ` : ""}${!ev.kind && ev.intent ? `<span class="intent" data-intent="${esc(ev.intent)}">${ev.intent === "ask" ? "Ask" : "Tell"}</span> · ` : ""}You → <b>${esc(to.join(", "))}</b> · ${clock(ev.at)}${ev.delivery === "now" ? " · sent now" : ""}${ev.editedAt ? " · edited" : ""}${(ev.answers ?? []).map((a) => ` · answers “${esc(a.question.length > 80 ? `${a.question.slice(0, 80)}…` : a.question)}”`).join("")}</div>
    <div class="md">${renderMarkdown(ev.text)}</div>
    <div class="notestate">${ev.cancelled ? "<span>withdrawn</span>" : noteStates(ev)}${queued ? ` · <button type="button" class="linkbtn" data-note-edit>Edit</button> · <button type="button" class="linkbtn" data-note-cancel>Cancel note</button>` : ""}</div></div>`);
  // A change you're making to it (kept in this browser as you type, under its room): while the note is still
  // queued, the editor comes back as you left it, also after a reload. If the note has gone to the crew meanwhile,
  // the change can't be saved, but it isn't lost: it stays under the note until you send it as a new note or
  // dismiss it. Not while a save of it is on its way: the note's own update shows what was saved.
  const kept = noteChanges(S.roomId)[ev.id];
  const change = kept && S.saving.get(ev.id) === kept.rev ? null : kept;
  if (change && !S.editing.has(ev.id) && change.text.trim() === ev.text.trim()) setNoteChange(S.roomId, ev.id, null);
  else if (change && queued) {
    const draft = S.editing.get(ev.id) ?? { roomId: S.roomId, text: change.text, focused: false };
    // Changed meanwhile in another tab (each tab keeps what you type in the browser): the latest wins.
    if (draft.text !== change.text) {
      draft.text = change.text;
      if (draft.area) draft.area.value = change.text;
    }
    S.editing.set(ev.id, draft);
    openEditor(node, ev, draft);
  } else if (change) {
    S.editing.delete(ev.id);
    node.appendChild(unsavedEl(ev, change.text));
  }
  return node;
}

/**
 * Changes to notes not saved yet, per room, kept in this browser: what you've typed in a note's editor, or a change
 * that couldn't be saved because the note went to the crew first. Each is dropped when it's saved, or when you
 * keep the note as it was, send the change as a new note, or dismiss it. Always written under the room the note is
 * in, whichever room is on screen.
 */
function noteChanges(roomId) {
  try {
    return JSON.parse(localStorage.getItem(`toryo.notechanges.${roomId}`) ?? "{}");
  } catch {
    return {};
  }
}
/** Keep (or drop) a change. Each one kept gets a revision of its own, which a save checks before dropping it. */
function setNoteChange(roomId, noteId, change) {
  const all = noteChanges(roomId);
  const rev = change ? `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}` : null;
  if (change) all[noteId] = { ...change, rev };
  else delete all[noteId];
  try {
    if (Object.keys(all).length) localStorage.setItem(`toryo.notechanges.${roomId}`, JSON.stringify(all));
    else localStorage.removeItem(`toryo.notechanges.${roomId}`);
  } catch {
    /* ignore */
  }
  return rev;
}

function unsavedEl(ev, text) {
  const to = (ev.to ?? []).map(name).join(" and ");
  return el(`<div class="unsaved" data-unsaved="${ev.id}"><b>Your change wasn't saved: the note went to ${esc(to)} first.</b>
    <textarea class="noteedit" readonly rows="3" aria-label="Your unsaved version">${esc(text)}</textarea>
    <div class="actions"><button type="button" class="btn small" data-unsaved-reuse>Send it as a new note</button><button type="button" class="btn small quiet" data-unsaved-dismiss>Dismiss</button></div></div>`);
}

/** Ask or Tell, as chosen, or as the text suggests until you choose. */
function renderIntent() {
  const intent = S.intent ?? noteIntent($("#msg").value);
  for (const b of $$("#intent [data-intent]")) b.setAttribute("aria-pressed", String(b.dataset.intent === intent));
}

/** Edit a queued note in place. */
function editNote(box) {
  const ev = S.view?.events.find((e) => e.id === box.dataset.id);
  if (!ev) return;
  const draft = { roomId: S.roomId, text: ev.text, focused: true };
  S.editing.set(ev.id, draft);
  setNoteChange(draft.roomId, ev.id, { text: draft.text, to: ev.to ?? [] });
  openEditor(box, ev, draft);
}

/**
 * The editor for a queued note. Drawing the timeline again (a turn starting or ending, an update to the note) doesn't
 * make a new one: the box you're typing in moves into the note as it's drawn, with its text, cursor and selection,
 * and gets the focus back if it had it.
 */
function openEditor(box, ev, draft) {
  const md = box.querySelector(".md");
  md.innerHTML = `<div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="btn small primary" data-note-save>Save</button><button type="button" class="btn small" data-note-keep>Keep as it was</button></div>`;
  let area = draft.area;
  if (!area) {
    area = document.createElement("textarea");
    area.rows = 3;
    area.className = "noteedit";
    area.setAttribute("aria-label", "Your note");
    area.value = draft.text;
    area.addEventListener("input", () => {
      draft.text = area.value;
      setNoteChange(draft.roomId, ev.id, { text: draft.text, to: ev.to ?? [] });
    });
    draft.area = area;
  }
  md.prepend(area);
  // Once the note is on the page (it's drawn first, then put in place).
  if (draft.focused) queueMicrotask(() => area.isConnected && area.focus({ preventScroll: true }));
  md.querySelector("[data-note-keep]").addEventListener("click", () => {
    S.editing.delete(ev.id);
    setNoteChange(draft.roomId, ev.id, null);
    box.replaceWith(ownerEl(ev));
  });
  md.querySelector("[data-note-save]").addEventListener("click", async () => {
    // While the save is on its way, the note's update (which can arrive before the reply) shows the note, not the
    // editor. The change stays kept, under the note's room, until the desk has it: you may have moved on to
    // another room, or reloaded, by then. Refused because the note went first: it shows as the change that
    // couldn't be saved. Failed for another reason: the editor comes back.
    // You can go on typing (here, or in another tab) while it's on its way: that makes a newer change, which the
    // save's reply never drops.
    const roomId = draft.roomId;
    draft.text = area.value;
    const rev = setNoteChange(roomId, ev.id, { text: draft.text, to: ev.to ?? [] });
    S.saving.set(ev.id, rev);
    try {
      await api("PATCH", `/api/rooms/${roomId}/notes/${ev.id}`, { text: draft.text });
      if (noteChanges(roomId)[ev.id]?.rev === rev) {
        setNoteChange(roomId, ev.id, null);
        S.editing.delete(ev.id);
      }
      if (S.roomId === roomId) refreshRoomSoon();
    } catch (error) {
      if (error.status === 409) S.editing.delete(ev.id);
      fail(error);
    } finally {
      if (S.saving.get(ev.id) === rev) S.saving.delete(ev.id);
      const shown = S.roomId === roomId && $(`#log .owner[data-id="${CSS.escape(ev.id)}"]`);
      if (shown) shown.replaceWith(ownerEl(S.view.events.find((e) => e.id === ev.id) ?? ev));
    }
  });
}

/** Before the timeline is drawn again: what each open editor holds, and whether it has the focus. */
function rememberEditors() {
  for (const area of $$("#log textarea.noteedit:not([readonly])")) {
    const draft = S.editing.get(area.closest(".owner")?.dataset.id);
    if (!draft) continue;
    draft.text = area.value;
    // Focus that went nowhere (the box was just moved, and gets it back in a moment) isn't focus moved away.
    const active = document.activeElement;
    if (active && active !== document.body) draft.focused = active === area;
  }
}

/** Where a note is for each agent it went to: waiting, being read, or answered (with a link to the answer). */
function noteStates(ev) {
  const working = new Set([...S.live.values()].map((l) => l.agent));
  return (ev.to ?? [])
    .map((a) => {
      // What the agent did with it, in its own words: done, scheduled, declined, or answered.
      const out = ev.outcomes?.[a];
      if (out) return `<a href="#" class="outcome" data-outcome="${esc(out.status)}" data-jump="${esc(out.turnId)}" title="${esc(out.detail ?? "")}">${esc(name(a))}: ${esc(out.status)}${out.detail ? ` — ${esc(out.detail.slice(0, 80))}` : ""}</a>`;
      const replied = ev.repliedBy?.[a];
      if (replied) return `<a href="#" data-jump="${esc(replied)}">${esc(name(a))} replied</a>`;
      if (ev.readBy?.[a]) return `<span>${esc(name(a))} is reading it</span>`;
      if (ev.deliveredTo?.includes(a)) return `<span>delivered to ${esc(name(a))}</span>`;
      if (ev.notSent?.includes(a)) return `<span>not sent to ${esc(name(a))}: a new session started</span>`;
      return `<span>waiting for ${esc(name(a))}'s ${working.has(a) ? "turn to end" : "next turn"}</span>`;
    })
    .join(" · ");
}

function turnEl(ev) {
  const live = ev.state === "running";
  const kind = activityOf(ev.kind);
  const role = ev.role ? `<span class="role" data-role="${esc(ev.role)}">${esc(ev.role[0].toUpperCase() + ev.role.slice(1))}</span>` : "";
  const meta = [
    ev.round && ev.kind && /^(build|review)/.test(ev.kind) ? `round ${ev.round}` : "",
    live ? `<span class="timer" data-since="${ev.startedAt}">${since(ev.startedAt)}</span>` : duration(ev.startedAt, ev.endedAt),
    clock(ev.endedAt ?? ev.startedAt),
  ]
    .filter(Boolean)
    .join(" · ");
  let chip = "";
  if (live) chip = `<span class="status" data-s="working" data-k="${kind}"><span class="pulse"></span>${{ build: "Building", review: "Reviewing", plan: "Planning", chat: "Working" }[kind]}</span>`;
  else if (ev.state === "failed") chip = `<span class="status" data-s="failed">${ic("x")}Failed</span>`;
  else if (ev.state === "interrupted") chip = `<span class="status">Interrupted</span>`;
  // Held while it was being prepared: it went back to the queue, unsent (the reason is below).
  else if (ev.state === "deferred") chip = `<span class="status">Not sent yet</span>`;
  else if (ev.status && STATUS[ev.status]) chip = `<span class="status" data-s="${ev.status}" title="${esc(`TORYO: ${ev.status} ${ev.detail ?? ""}`)}">${ev.status === "APPROVED" || ev.status === "DONE" ? ic("check") : ""}${STATUS[ev.status]}</span>`;
  const head = `<header><span class="who">${avatar(ev.agent, 30, "", live ? ev.kind : "")}${esc(name(ev.agent))}</span>${role}<span class="kind">${esc(KIND[ev.kind] ?? ev.kind ?? "")}</span><span class="meta">${meta}</span>${chip}</header>`;
  if (live) {
    const activity = S.live.get(ev.id)?.activity ?? [];
    return el(`<article class="turn live" data-k="${kind}" data-id="${ev.id}">${head}
      <ul class="feed" data-feed="${ev.id}">${feedItems(activity, 6)}</ul>
      <footer><span>Working for <span class="timer" data-since="${ev.startedAt}">${since(ev.startedAt)}</span></span><span class="sep"></span><button type="button" class="btn small quiet" data-note-now="${ev.agent}">${ev.agent === "codexapp" ? "Add a note for its next turn" : "Interrupt with a note"}</button><button type="button" class="btn small quiet" data-prompt="${ev.id}">What was it asked?</button></footer></article>`);
  }
  const text = stripStatus(ev.text ?? "");
  const long = text.length > 2200 || text.split("\n").length > 34;
  const expanded = S.expanded.has(ev.id);
  const handoff = ev.status === "REVIEW" && ev.detail?.includes("|") ? ev.detail.split("|").pop().trim() : ev.status === "REVIEW" && /\.\w+$/.test(ev.detail ?? "") ? ev.detail : "";
  const others = Object.entries(S.state?.agents ?? {})
    .filter(([id, a]) => id !== ev.agent && a.installed)
    .map(([id]) => `<option value="${id}">${name(id)}</option>`)
    .join("");
  const usage = ev.usage ? `${tokens((ev.usage.input ?? 0) + (ev.usage.cached ?? 0))} in · ${tokens(ev.usage.output)} out${ev.cost ? ` · $${ev.cost.toFixed(2)} at API rates` : ""}` : "";
  const fwd = forwardFrom(ev);
  return el(`<article class="turn ${ev.state === "failed" ? "failed" : ""}" data-k="${kind}" data-id="${ev.id}">${head}
    ${text.trim() ? `<div class="body md ${long && !expanded ? "clamped" : ""}">${renderMarkdown(text)}</div>` : ev.state === "deferred" ? "" : `<div class="hint">(no message)</div>`}
    ${long ? `<div><button type="button" class="btn small quiet" data-expand="${ev.id}">${expanded ? "Show less" : "Show the whole message"}</button></div>` : ""}
    ${ev.error ? `<div class="error">${esc(ev.error)}</div>` : ""}
    ${fwd ? `<div class="actions forward"><button type="button" class="btn small" data-forward="${fwd.questionId}" data-agent="${esc(ev.agent)}" title="Your messages with ${esc(name(ev.agent))} since the plan was ready, and its replies, go to ${esc(name(fwd.author))}, who revises the plan">${ic("plan")}Send this discussion to ${esc(name(fwd.author))} as a change request</button></div>` : ""}
    <footer>
      ${ev.files?.length ? `<button type="button" class="linkbtn" data-diff="${ev.id}">${ev.files.length} file${ev.files.length > 1 ? "s" : ""} changed</button>` : ev.snapAfter ? `<span>No file changes</span>` : ""}
      ${handoff ? `<span class="handoff">${ic("file")}<a href="#" class="file mono" data-file="${esc(handoff)}">${esc(handoff)}</a></span>` : ""}
      ${usage ? `<span title="Tokens for this turn">${usage}</span>` : ""}
      <span class="sep"></span>
      <button type="button" class="btn small quiet" data-copy-turn="${ev.id}" title="Copy the whole message, for example to paste into the Codex app">Copy</button>
      ${ev.imported ? `<span title="Written before this room started; the room began by reviewing it">handed over</span>` : `<button type="button" class="btn small quiet" data-prompt="${ev.id}">Prompt</button>`}
      ${others ? `<select data-opinion="${ev.id}" aria-label="Ask another agent for a second opinion"><option value="">Second opinion…</option>${others}</select>` : ""}
    </footer></article>`);
}

function feedItems(activity, n) {
  const items = activity.slice(-n);
  if (!items.length) return `<li>starting…</li>`;
  return items.map((a) => `<li data-kind="${esc(a.kind)}" title="${esc(a.text)}">${a.kind === "command" ? "$ " : a.kind === "edit" ? "✎ " : a.kind === "say" ? "› " : ""}${esc(a.text)}</li>`).join("");
}

/**
 * While a plan waits on its Ready card, your exchange since then with a planner other than its author can go to the
 * author as a change request: the button is on that planner's latest reply. Who wrote the plan and who else plans
 * come from the card (`from`, `checkers`), which arrives with the timeline, never from a room that may be older.
 */
function forwardFrom(ev) {
  if (ev.state !== "done" || !ev.text?.trim()) return null;
  const events = S.view.events;
  const at = events.findIndex((e) => e.type === "question" && e.kind === "plan-ready" && e.open);
  const card = events[at];
  const mine = events.findIndex((e) => e.id === ev.id);
  if (!card || mine < at || !card.from || !(card.checkers ?? []).includes(ev.agent)) return null;
  if (events.slice(mine + 1).some((e) => e.type === "turn" && e.agent === ev.agent && e.state === "done")) return null;
  return { questionId: card.id, author: card.from };
}

function questionEl(ev) {
  const asker = ev.from ? `${esc(name(ev.from))} asks` : "Your call";
  const who = `<div class="who">${avatar(ev.from || "toryo", 26)}<span>${asker}${ev.open ? " · the room waits for your answer" : ""}</span></div>`;
  if (!ev.open)
    return el(`<div class="decision closed" data-id="${ev.id}"><p class="q">${esc(ev.question)}</p><p class="answer">${ic("check")}<span>You answered: ${esc(ev.answer ?? "")}</span></p></div>`);
  const rec = (text) => (text ? `<div class="rec"><span class="eyebrow">Recommended</span><span>${esc(text)}</span></div>` : "");
  if (ev.kind === "plan-checkpoint") {
    const r = room();
    const participants = r?.plan?.participants ?? r?.crew.members ?? [];
    const qs = ev.questions ?? [];
    return el(`<form class="decision" data-id="${ev.id}" data-checkpoint>
      ${who}<p class="q">Settle the open questions, then choose who writes the plan.</p>
      <div class="qform">
        ${qs.length ? qs.map((q, i) => `<div class="qrow"><label for="cq${i}">${esc(q.question)} <span class="from">(${esc(name(q.from))})</span></label><input type="text" id="cq${i}" data-q="${esc(q.question)}" value="${esc(q.recommendation)}" placeholder="Your answer"></div>`).join("") : `<div class="hint">No explicit questions were raised. Add anything you've decided below.</div>`}
        <div class="qrow"><label for="cqExtra">Anything else you've decided</label><textarea id="cqExtra" rows="2" placeholder="Constraints, scope cuts, priorities…"></textarea></div>
        <div class="pair"><div class="qrow"><label for="cqWho">Who writes the plan</label><select id="cqWho">${participants.map((p) => `<option value="${p}" ${p === r?.crew.builder ? "selected" : ""}>${name(p)}</option>`).join("")}</select></div>
        <div class="qrow"><label for="cqPath">Plan file</label><input type="text" id="cqPath" value="${esc(r?.plan?.planPath ?? "")}"></div></div>
      </div>
      <div class="actions"><button class="btn you" type="submit">${ic("check")}Write the plan</button>${qs.length && qs.every((q) => q.recommendation?.trim()) ? `<button class="btn" type="button" data-accept-checkpoint title="Every question answered with its recommendation, as shown">Accept all recommendations</button>` : ""}<button class="btn quiet" type="button" data-focus-everyone>Discuss more first</button></div></form>`);
  }
  if (ev.kind === "plan-ready") {
    // The other planners can check it without a build starting (cards from before this had no checkers: no button).
    const checkers = (ev.checkers ?? []).map(name).join(" and ");
    return el(`<div class="decision" data-id="${ev.id}">${who}<p class="q">${esc(ev.question)}</p>
      <div class="actions"><button class="btn you" type="button" data-start-build="${esc(ev.planPath ?? "")}">${ic("build")}Start building with this plan</button>
      <button class="btn" type="button" data-file="${esc(ev.planPath ?? "")}">Read the plan</button>
      ${checkers ? `<button class="btn" type="button" data-plan-check>${ic("review")}Ask ${esc(checkers)} to check it</button>` : ""}
      <button class="btn quiet" type="button" data-answer-focus="${esc(ev.from ?? "")}">Ask for changes</button></div></div>`);
  }
  if (ev.kind === "app-lost")
    return el(`<div class="decision" data-id="${ev.id}">${who}<p class="q">${esc(ev.question)}</p>
      <div class="actions"><button class="btn you" type="button" data-accept>Follow it again</button><button class="btn" type="button" data-app-release>Stop waiting for it</button></div></div>`);
  if (ev.kind === "error")
    return el(`<div class="decision" data-id="${ev.id}">${who}<p class="q">${esc(ev.question)}</p>
      <div class="actions"><button class="btn you" type="button" data-accept>Retry</button><button class="btn" type="button" data-answer-focus="${esc(ev.from ?? "")}">Retry with a note</button></div></div>`);
  const chat = ev.kind === "chat-owner";
  return el(`<div class="decision" data-id="${ev.id}">${who}<p class="q">${esc(ev.question)}</p>${rec(ev.recommendation)}
    <div class="actions">${ev.recommendation ? `<button class="btn you" type="button" ${chat ? "data-chat-accept" : "data-accept"}>${ic("check")}Use the recommendation</button>` : ""}
    <button class="btn" type="button" data-answer-focus="${esc(ev.from ?? "")}">Write my own answer</button></div></div>`);
}

function gateEl(ev) {
  const ok = ev.results.every((x) => x.ok);
  return el(`<div class="gate" data-id="${ev.id}"><div class="rowline"><span class="ttl"><span class="tile" aria-hidden="true">${ic("checks")}</span>${ok ? "Checks passed" : "Checks failed"}</span>${ev.results
    .map((x) => `<span class="chk" data-ok="${x.ok}">${ic(x.ok ? "check" : "x")}${esc(x.name)} <span class="muted">${x.seconds}s</span></span>`)
    .join("")}</div>${ev.results
    .filter((x) => !x.ok)
    .map((x) => `<details><summary class="hint">${esc(x.name)}: what it printed</summary><pre>${esc(x.output)}</pre></details>`)
    .join("")}</div>`);
}

function onActivity({ turnId, agent, item }) {
  let live = S.live.get(turnId);
  if (!live) {
    // Its first news, before anything else about it (a checks run has no event until it ends): Toryo's own work is
    // the checks; the desk says when it started, and what anything else is, on the refresh this asks for.
    live = { turnId, agent, kind: agent === "toryo" ? "gates" : undefined, activity: [], startedAt: item.at ?? new Date().toISOString() };
    S.live.set(turnId, live);
    refreshRoomSoon();
  }
  live.activity.push(item);
  if (live.activity.length > 80) live.activity.shift();
  for (const ul of $$(`[data-feed="${CSS.escape(turnId)}"]`)) ul.innerHTML = feedItems(live.activity, Number(ul.dataset.n ?? 6));
}

let seenTimer = null;
function markSeenSoon() {
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => {
    const r = room();
    // Read means on the screen: the page in view, showing this room (not Home, with the room behind it).
    if (!r || document.hidden || S.page !== "room") return;
    const log = $("#log");
    if (log.scrollHeight - log.scrollTop - log.clientHeight > 200) return;
    const last = S.view.events.at(-1);
    if (last) {
      S.seen[r.id] = last.id;
      writeSeen();
    }
  }, 1500);
}

// ------------------------------------------------------------------ crew

function renderCrew() {
  if (room()?.crew.members.includes("codexapp") && !S.appThreads) appThreads().then(() => renderCrew());
  const pane = $("#crewPane");
  const r = room();
  if (!r || !S.state) {
    pane.innerHTML = agentsOverview();
    return;
  }
  const cfg = S.state.config;
  const proj = project();
  const liveBy = new Map([...S.live.values()].map((l) => [l.agent, l]));
  let html = "";
  for (const a of r.crew.members) {
    const role = r.mode === "build" ? (a === r.crew.builder ? "builder" : a === r.crew.reviewer ? "reviewer" : "advisor") : r.mode === "plan" ? (r.plan?.synthesizer === a ? "plan author" : "planner") : "";
    const live = liveBy.get(a);
    const waiting = asking(r)?.from === a;
    const queued = r.queue?.some((q) => q.agent === a);
    const state = live
      ? `Working · <span class="timer" data-since="${live.startedAt}">${since(live.startedAt)}</span>`
      : waiting
        ? "Waiting for you"
        : queued
          ? r.paused ? "Paused · goes next" : "Up next"
          : "Idle";
    const ac = { ...(cfg.agents[a] ?? {}), ...(proj?.agents?.[a] ?? {}) };
    const det = S.state.agents?.[a];
    const st = r.stats?.agents?.[a];
    const session = r.sessions?.[a];
    const resume = session ? (a === "codex" ? `codex resume ${session}` : a === "claude" ? `claude --resume ${session}` : a === "cursor" ? `agent --resume ${session}` : a === "codexapp" ? "" : `grok -r ${session}`) : "";
    html += `<section class="agent" data-active="${Boolean(live)}">
      <div class="agent-head">${avatar(a, 34, "", live?.kind ?? "")}<span class="name">${name(a)}</span>${role ? `<span class="role" data-role="${role}">${role[0].toUpperCase() + role.slice(1)}</span>` : ""}<span class="state">${state}</span></div>
      ${a === "codexapp" ? `<div class="model"><span>Thread <span data-thread-name="${esc(session ?? "")}">${esc(threadLabel(S.appThreadList ?? [], session))}</span> · the app's own model and permissions · experimental</span></div>` : ""}
      <div class="model" ${a === "codexapp" ? "hidden" : ""}><span>${esc(ac.model || "default model")}${ac.effort ? ` · ${esc(ac.effort)} effort` : ""}</span>${a === "codex" ? `<span>${esc(ac.permissions ?? "sandboxed")}</span>` : a === "claude" ? `<span>${esc(ac.permissionMode ?? "auto")} permissions</span>` : ""}${det && !det.installed ? `<span style="color:var(--bad)">${missing(det)}</span>` : det?.tested === false ? `<span>adapter untested</span>` : ""}</div>
      ${live ? `<ul class="feed" data-feed="${live.turnId}" data-n="8">${feedItems(live.activity, 8)}</ul>` : ""}
      ${limitMeters(S.state.limits?.[a], a)}
      ${st ? `<div class="stats">${st.turns} turn${st.turns === 1 ? "" : "s"} · ${tokens(st.input + st.cached)} in · ${tokens(st.output)} out${st.cost ? ` · $${st.cost.toFixed(2)} at API rates` : ""}</div>` : ""}
      ${a === "codexapp" ? appThreadActions(r, session, Boolean(live) || queued || Boolean(r.following?.length)) : ""}
      ${resume ? `<div class="stats" style="display:flex;gap:6px;align-items:center"><span class="mono" title="${esc(resume)}">${esc(resume.slice(0, 34))}${resume.length > 34 ? "…" : ""}</span><button type="button" class="btn small quiet" data-copy="${esc(resume)}">Copy</button></div>` : ""}
      ${crewControls(r, a, role, Boolean(live))}
      ${a !== "codexapp" && (session || r.fresh?.[a]) ? `<div class="stats">${r.fresh?.[a] ? `<span>Starts fresh ${live ? "after this turn" : "on its next turn"}</span>` : `<button type="button" class="btn small quiet" data-fresh="${a}" title="Forget ${esc(name(a))}'s session in this room. Its next turn starts a new one with the briefing, the plan and the latest handoff.">Start ${esc(name(a))} fresh in this room</button>`}</div>` : ""}
    </section>`;
  }
  if (r.mode === "build" && r.crew.members.length > 1)
    html += `<div><button type="button" class="btn" data-action="swap">${r.swapPending ? "Cancel the swap after this round" : "Swap builder and reviewer"}</button></div>`;

  const addable = Object.entries(S.state.agents ?? {}).filter(([id]) => !r.crew.members.includes(id));
  // The Codex app works in the project's own folder only: it can't join a room with its own worktree.
  const ownWorktree = r.workspace?.kind === "worktree";
  const canAdd = (id, a) => a.installed && !(id === "codexapp" && ownWorktree);
  if (addable.length)
    html += `<div class="card addagent"><p class="eyebrow">More agents</p>${addable
      .map(([id, a]) => `<div class="row"><span>${name(id)}${a.installed ? (a.tested === false ? ' <span class="hint">(adapter untested)</span>' : "") : ` <span class="hint">· ${esc(a.hint ?? "not installed")}</span>`}${a.installed && !canAdd(id, a) ? ' <span class="hint">· works in the project\'s own folder only, not in this room\'s worktree</span>' : ""}</span>${canAdd(id, a) ? `<button type="button" class="btn small" data-add-agent="${id}">Add</button>` : ""}</div>`)
      .join("")}</div>`;

  const s = r.settings;
  html += `<div class="card"><p class="eyebrow">This room</p>
    <div class="hint">${r.mode === "plan" ? (s.recheckAfterChanges !== false ? "The other planners check your changes" : "No check after your changes") : `${s.autoContinue ? "Continues after approval" : "Asks after each approval"} · ${s.maxRounds} rounds per slice · ${s.gates !== false ? "checks before review" : "no checks"}`}</div>
    <div><button type="button" class="btn small" data-room-settings>Room settings, rename or delete</button></div></div>`;

  html += `<div class="card"><p class="eyebrow">Safeguards</p>
    <div class="check"><span class="ok">✓</span><span>Only the builder, and the plan's author while writing the plan, change files. Reviews, proposals, critiques, plan checks and chat replies are read-only${r.crew.members.includes("codexapp") ? ", except the Codex app, which follows its own permissions" : ""}.</span></div>
    ${readOnlyCheck()}
    <div class="check"><span class="${s.snapshots !== false ? "ok" : "no"}">${s.snapshots !== false ? "✓" : "–"}</span><span>Every turn's changes are snapshotted outside your repository</span></div>
    <div class="check"><span class="ok">✓</span><span>You see exactly what each agent was asked: “Prompt” on any message</span></div></div>`;
  pane.innerHTML = html;
}

/** How read-only turns are enforced on this machine. */
function readOnlyCheck() {
  const ro = S.state?.readOnly;
  const off = ["claude", "cursor", "grok"].filter((a) => S.state?.config.agents[a]?.readOnlyMount === false).map(name);
  if (ro?.ok)
    return `<div class="check"><span class="ok">✓</span><span>In those turns the project folder is mounted read-only for Claude, Cursor and Grok, and for every command they run; Codex uses its read-only sandbox.${off.length ? ` You've turned the mount off for ${off.join(" and ")}, which then only ${off.length > 1 ? "have their" : "has its"} own rules.` : ""}</span></div>`;
  return `<div class="check"><span class="no">!</span><span>This machine can't mount the project read-only${ro?.why ? ` (${esc(ro.why)})` : ""}. Codex still uses its read-only sandbox, but Claude only has its own rules, which don't stop shell commands from writing. Toryo warns you if files change in a read-only turn.</span></div>`;
}

/** The crew card's thread actions: open it in the app, or change it while the app is idle in this room. */
function appThreadActions(r, thread, busy) {
  return `<div class="stats" style="display:flex;gap:6px;flex-wrap:wrap">${thread ? `<a class="btn small quiet" href="codex://threads/${esc(thread)}">Open in the Codex app</a>` : ""}
    <button type="button" class="btn small quiet" data-change-thread ${busy ? `disabled title="The Codex app is working in this room; change its thread once it has finished."` : ""}>Change thread</button></div>`;
}

function agentsOverview() {
  if (!S.state) return "";
  return `<p class="eyebrow">Agents on this machine</p>${Object.entries(S.state.agents ?? {})
    .map(([id, a]) => `<section class="agent"><div class="agent-head">${avatar(id, 34)}<span class="name">${name(id)}</span><span class="state">${a.installed ? esc(a.version ?? "installed") : missing(a)}</span></div>${a.installed ? limitMeters(S.state.limits?.[id], id) || (id === "claude" ? `<div class="hint">Claude's usage shows once it has worked in a room.</div>` : "") : `<div class="hint">${esc(a.hint ?? "")}</div>`}</section>`)
    .join("")}`;
}

// ------------------------------------------------------------------ composer

function renderComposer() {
  const r = room();
  const form = $("#composer");
  form.hidden = !r;
  if (!r) return;
  const options = ["auto", ...r.crew.members, ...(r.crew.members.length > 1 ? ["everyone"] : [])];
  if (!options.includes(S.route)) S.route = "auto";
  $("#recipients").innerHTML = options
    .map((o) => `<button type="button" data-route="${o}" aria-pressed="${S.route === o}">${o === "auto" ? "Auto" : o === "everyone" ? "Everyone" : name(o)}</button>`)
    .join("");
  const waiting = asking(r);
  $("#msg").placeholder = waiting?.from
    ? `Answer ${name(waiting.from)}: ${waiting.question.slice(0, 80)}`
    : r.mode === "chat"
      ? "Write to the crew. @codex or @claude to address one; Enter to send, Shift+Enter for a new line."
      : "Add a note for the crew. It rides along with their next turn; Enter to send, Shift+Enter for a new line.";
  renderRouteInfo();
  renderIntent();
}

/**
 * The open questions a note can answer, in the room's order: the ones it waits on, then chat questions (the planning
 * form and a lost app turn have their own buttons). Read from the questions themselves, which arrive before the
 * room's own lists are refreshed, so a question that has just appeared counts.
 */
function openAsks() {
  const open = (S.view?.events ?? []).filter((e) => e.type === "question" && e.open && e.kind !== "plan-checkpoint" && e.kind !== "app-lost");
  return [...open.filter((q) => q.kind !== "chat-owner"), ...open.filter((q) => q.kind === "chat-owner")];
}

/**
 * Fix what your note answers, as the room shows it now, so a question answered elsewhere meanwhile can't be swapped
 * for a newer one under your text. For each agent: the question the composer offers (the room's first, if that agent
 * asked it), else its only open question, else nothing. `chosen`: the card whose "Write my own answer" you pressed.
 */
function bindAnswer(r, chosen) {
  const asks = openAsks();
  const byAgent = {};
  for (const a of r.crew.members) {
    const mine = asks.filter((q) => q.from === a);
    byAgent[a] = asks[0]?.from === a ? asks[0].id : mine.length === 1 ? mine[0].id : null;
  }
  if (chosen) {
    byAgent[chosen.from] = chosen.id;
    revise(r.id);
  }
  keepAnswer(r.id, { roomId: r.id, asker: chosen?.from ?? asks[0]?.from ?? null, byAgent, chosen: Boolean(chosen), route: S.route });
}

/**
 * A room's draft changed (its text, its recipient or the question it answers). The revision is kept in this tab and
 * with the saved draft, which every tab of the page shares, so a late reply in one tab can't undo another tab's newer
 * draft either.
 */
function revise(roomId) {
  S.revisions.set(roomId, (S.revisions.get(roomId) ?? 0) + 1);
  const token = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  S.loaded.set(roomId, token);
  try {
    localStorage.setItem(`toryo.revision.${roomId}`, token);
  } catch {
    /* ignore */
  }
}
function savedRevision(roomId) {
  try {
    return localStorage.getItem(`toryo.revision.${roomId}`);
  } catch {
    return null;
  }
}

/** Choose who gets the note; a draft keeps its recipient with it. */
function setRoute(route) {
  S.route = route;
  const r = room();
  if (r) revise(r.id);
  if (r && bound(r)) keepAnswer(r.id, { ...bound(r), route });
}

/** A room's own draft: its text, what it answers and who it's to. Never another room's text. */
function restoreDraft(r) {
  let text = "";
  try {
    text = localStorage.getItem(`toryo.draft.${r.id}`) ?? "";
  } catch {
    /* ignore */
  }
  $("#msg").value = text;
  // Another tab changed this room's draft since this tab last had it: the draft shown now is a different one.
  const token = savedRevision(r.id);
  if (S.loaded.has(r.id) && S.loaded.get(r.id) !== token) S.revisions.set(r.id, (S.revisions.get(r.id) ?? 0) + 1);
  S.loaded.set(r.id, token);
  $("#sendBtn").disabled = S.sending.has(r.id);
  S.intent = null;
  S.answering = keptAnswer(r.id);
  S.route = S.answering?.route ?? "auto";
  // A draft saved before drafts were tied to questions: what it was written for isn't known, so it answers nothing
  // and goes as a note. To answer a question with it, press that question's "Write my own answer".
  if (text.trim() && !S.answering) keepAnswer(r.id, { roomId: r.id, asker: null, byAgent: {}, chosen: false, route: S.route });
}
function forgetDraft(roomId) {
  try {
    localStorage.removeItem(`toryo.draft.${roomId}`);
  } catch {
    /* ignore */
  }
}
/** Keep what a room's draft answers. Only the open room's is also the composer's. */
function keepAnswer(roomId, binding) {
  if (roomId === S.roomId) S.answering = binding;
  try {
    if (binding) localStorage.setItem(`toryo.answering.${roomId}`, JSON.stringify(binding));
    else localStorage.removeItem(`toryo.answering.${roomId}`);
  } catch {
    /* ignore */
  }
}
function keptAnswer(roomId) {
  try {
    const b = JSON.parse(localStorage.getItem(`toryo.answering.${roomId}`) ?? "null");
    return b?.roomId === roomId ? b : null;
  } catch {
    return null;
  }
}
const bound = (r) => (S.answering?.roomId === r.id ? S.answering : null);

/** What a note to these agents answers, as fixed when you began it: a question's id, chat questions' ids, or false. */
function answerFor(r, agents) {
  const by = bound(r)?.byAgent ?? {};
  if (agents.length === 1) return by[agents[0]] ?? false;
  const ids = agents.map((a) => by[a]).filter((id) => id && S.view?.events.find((e) => e.id === id)?.kind === "chat-owner");
  return ids.length ? ids : false;
}

/** What the room asks you first, as the desk routes it: the question it waits on, else the oldest unanswered chat question. */
function asking(r) {
  if (r.waiting) return r.waiting;
  const id = r.openChat?.[0];
  return id ? S.view?.events.find((e) => e.id === id) ?? null : null;
}

function previewRoute(text) {
  const r = room();
  const route = baseRoute(r, text);
  if (!bound(r)) return route;
  // Once you've begun writing: what it answers, as fixed then.
  const answers = answerFor(r, route.agents);
  const ask = (id) => S.view.events.find((e) => e.id === id);
  if (typeof answers === "string") {
    const q = ask(answers);
    if (!q?.open) return { ...route, why: "your answer to a question that has been answered meanwhile, so it won't be sent" };
    return { ...route, why: `your answer to “${q.question.length > 60 ? `${q.question.slice(0, 60)}…` : q.question}”` };
  }
  if (answers && answers.some((id) => !ask(id)?.open)) return { ...route, why: `${route.why} · a question it answers has been answered meanwhile, so it won't be sent` };
  if (!answers && openAsks().some((q) => route.agents.includes(q.from))) return { ...route, why: `${route.why} · a note, not an answer to the question waiting now` };
  return route;
}

function baseRoute(r, text) {
  const members = r.crew.members;
  if (S.route === "everyone") return { agents: [...members], why: "to everyone" };
  if (S.route !== "auto") return { agents: [S.route], why: "you chose" };
  if (/@(all|everyone)\b/i.test(text)) return { agents: [...members], why: "you mentioned everyone" };
  const m = members.filter((a) => new RegExp(`@(${a}|${name(a)})\\b`, "i").test(text));
  if (m.length) return { agents: m, why: "you mentioned them" };
  // The agent whose question you began answering, else (as the desk routes it) the one asking now.
  const asker = bound(r)?.asker ?? asking(r)?.from;
  if (asker) return { agents: [asker], why: "it is waiting for your answer" };
  if (r.mode === "build") {
    if (/\b(review|check|verify|confirm|audit|test|tests)\b/i.test(text)) return { agents: [r.crew.reviewer], why: "it mentions checking" };
    if (/\b(fix|build|implement|add|change|rename|refactor|update|write|remove|make)\b/i.test(text)) return { agents: [r.crew.builder], why: "it mentions building or fixing" };
    const busy = [...S.live.values()][0]?.agent ?? r.queue?.[0]?.agent;
    return { agents: [busy ?? r.crew.builder], why: busy ? "it is working now" : "it acts next" };
  }
  if (r.mode === "plan" && r.plan) return { agents: [...r.plan.participants], why: "the planners" };
  const last = [...S.view.events].reverse().find((e) => e.type === "turn");
  if (last) return { agents: [last.agent], why: `continuing with ${name(last.agent)}` };
  return { agents: [...members], why: "to everyone" };
}

function renderRouteInfo() {
  const r = room();
  if (!r) return;
  const text = $("#msg").value;
  const route = previewRoute(text);
  const now = $("#delivery").value === "now";
  const busy = new Set([...S.live.values()].map((l) => l.agent));
  const when = now
    ? route.agents.some((a) => busy.has(a)) ? "now, interrupting its turn" : "now"
    : r.mode === "chat"
      ? "right away"
      : route.agents.some((a) => busy.has(a))
        ? "when its current turn ends"
        : "with its next turn";
  const roleOf = (a) => (r.mode === "build" ? (a === r.crew.builder ? " (builder)" : a === r.crew.reviewer ? " (reviewer)" : "") : "");
  $("#routeInfo").innerHTML = `To <b>${route.agents.map((a) => esc(name(a)) + roleOf(a)).join(", ")}</b> · ${esc(route.why)} · ${when}`;
  const several = route.agents.length > 1;
  $("#discussOpt").hidden = !(r.mode === "chat" && several);
  $("#writeOpt").hidden = r.mode !== "chat";
  $("#composeHint").textContent = r.mode === "chat" && !$("#allowWrite").checked ? "Read-only unless you allow changes." : "";
}

async function send(e) {
  e?.preventDefault();
  const r = room();
  const text = $("#msg").value.trim();
  if (!r || !text || S.sending.has(r.id)) return;
  if (!bound(r)) bindAnswer(r);
  const answering = answerFor(r, previewRoute(text).agents);
  // The reply may come after you've switched rooms or changed the draft (its text, its recipient or the question it
  // answers), here or in another tab: it acts only on the draft as it was sent, in its own room, and leaves any other
  // (and what it answers) alone.
  const roomId = r.id;
  const route = S.route;
  // The draft as sent: this tab's revision of it, and the saved revision of the draft this tab loaded or wrote (not
  // whatever another tab has saved since).
  const revision = S.revisions.get(roomId) ?? 0;
  const saved = S.loaded.get(roomId) ?? null;
  const here = () => S.roomId === roomId;
  // This tab still has the draft it sent; the saved drafts every tab shares still hold it too.
  const mine = () => (S.revisions.get(roomId) ?? 0) === revision;
  const shared = () => savedRevision(roomId) === saved;
  S.sending.add(roomId);
  $("#sendBtn").disabled = true;
  try {
    await api("POST", `/api/rooms/${roomId}/messages`, {
      text,
      to: route,
      delivery: $("#delivery").value,
      discuss: !$("#discussOpt").hidden && $("#discuss").checked ? Number($("#discussRounds").value) : 0,
      allowWrite: !$("#writeOpt").hidden && $("#allowWrite").checked,
      intent: S.intent ?? noteIntent(text),
      answering,
    });
    if (mine() && shared()) {
      keepAnswer(roomId, null);
      forgetDraft(roomId);
    }
    if (!mine() || !here()) return;
    S.answering = null;
    $("#msg").value = "";
    $("#delivery").value = "next";
    S.intent = null;
    renderIntent();
    renderRouteInfo();
  } catch (error) {
    // Answered meanwhile (elsewhere): your text stays. Sent again, it's a note that answers nothing.
    if (error.status === 409 && answering) {
      const nothing = { roomId, asker: null, byAgent: {}, chosen: false, route };
      if (mine() && shared()) keepAnswer(roomId, nothing);
      else if (mine() && here()) S.answering = nothing;
      if (here()) renderRouteInfo();
      const where = here() ? "" : `In “${S.state?.rooms.find((x) => x.id === roomId)?.title ?? "another room"}”: `;
      return toast("Not sent", `${where}${error.message} Your text is still there. Sent again, it goes as a note, not as an answer to the question waiting now.`, 12000);
    }
    fail(error);
  } finally {
    S.sending.delete(roomId);
    $("#sendBtn").disabled = S.sending.has(S.roomId);
  }
}

// ------------------------------------------------------------------ sheets

function openSheet(html, { wide = false } = {}) {
  const body = $("#sheetBody");
  body.className = `sheet${wide ? " wide" : ""}`;
  body.innerHTML = html;
  $("#sheet").hidden = false;
  body.querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, button")?.focus();
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheetBody").innerHTML = "";
}
const sheetHead = (eyebrow, title) =>
  `<div class="head"><div><p class="eyebrow">${esc(eyebrow)}</p><h2>${esc(title)}</h2></div><button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div>`;

function crewChecks(members, idPrefix) {
  return Object.entries(S.state.agents ?? {})
    .map(([id, a]) => `<label class="opt"><input type="checkbox" name="${idPrefix}" value="${id}" ${members.includes(id) && a.installed ? "checked" : ""} ${a.installed ? "" : "disabled"}> ${name(id)}${a.installed ? (a.tested === false ? ' <span class="hint">(adapter untested)</span>' : "") : ` <span class="hint">${missing(a)}: ${esc(a.hint ?? "")}</span>`}</label>`)
    .join("");
}
const agentOptions = (members, selected) => members.map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${name(m)}</option>`).join("");

// ------------------------------------------------------------------ Codex app threads

/** The Codex desktop app's threads, read once per page (names for the crew card and the pickers). */
function appThreads() {
  S.appThreads ??= api("GET", "/api/codexapp/threads")
    .catch(() => [])
    .then((list) => (S.appThreadList = list));
  return S.appThreads;
}
const threadLabel = (threads, id) => {
  const t = threads.find((x) => x.id === id);
  return t ? t.name || t.preview || id : id ? `thread ${id.slice(0, 8)}…` : "";
};
/** The thread a new room in this project starts with: the project's default, else the general one. */
const defaultThread = (projectId) =>
  S.state.config.projects.find((p) => p.id === projectId)?.agents?.codexapp?.thread || S.state.config.agents.codexapp?.thread || "";
const threadOptions = (threads, selected, empty = "") =>
  `${empty ? `<option value="">${esc(empty)}</option>` : ""}${threads
    .map((t) => `<option value="${esc(t.id)}" ${t.id === selected ? "selected" : ""}>${esc(t.name || t.preview || t.id)} · ${new Date(t.updated).toLocaleString([], { dateStyle: "short", timeStyle: "short", hourCycle: "h23" })}</option>`)
    .join("")}${selected && !threads.some((t) => t.id === selected) ? `<option value="${esc(selected)}" selected>thread ${esc(selected.slice(0, 8))}…</option>` : ""}`;
/** Rooms (other than `roomId`) whose Codex app uses `thread`. */
const roomsOnThread = (thread, roomId) => (thread ? S.state.rooms.filter((r) => r.appThread === thread && r.id !== roomId) : []);
const sharedThreadNote = (thread, roomId) => {
  const others = roomsOnThread(thread, roomId);
  return others.length ? `Also used by ${others.map((r) => `“${esc(r.title)}”`).join(", ")}. Only one room's turn runs in a thread at a time.` : "";
};

/** Choose the Codex app's thread for this room: when adding the app, or changing its thread while it's idle. */
async function appThreadSheet(adding) {
  const r = room();
  const threads = await appThreads();
  const current = adding ? defaultThread(r.projectId) : r.sessions?.codexapp ?? "";
  openSheet(`${sheetHead("Codex app", adding ? "Add the Codex app" : "Change the app thread")}
  <form id="threadForm" style="display:grid;gap:14px">
    <p class="hint" style="margin:0">The Codex app works in one of your app's threads. Each room has its own; changing a thread here doesn't affect other rooms.</p>
    <div class="field"><label for="tThread">Thread for this room</label><select id="tThread">${threadOptions(threads, current, threads.length ? "" : "No app threads found")}</select>
      <span class="hint" id="tShared">${sharedThreadNote(current, r.id)}</span></div>
    <div style="display:flex;gap:8px"><button class="btn primary" type="submit">${adding ? "Add" : "Use this thread"}</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
  $("#tThread").addEventListener("change", (e) => ($("#tShared").innerHTML = sharedThreadNote(e.target.value, r.id)));
  $("#threadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const thread = $("#tThread").value;
    try {
      if (adding) await api("POST", `/api/rooms/${r.id}/control`, { action: "members", members: [...r.crew.members, "codexapp"], appThread: thread });
      else await api("POST", `/api/rooms/${r.id}/control`, { action: "app-thread", thread });
      closeSheet();
    } catch (error) {
      fail(error);
    }
  });
}

/** "The builder already finished a round": the room starts by reviewing it. */
const handoffFields = (p) => `<label class="opt"><input type="checkbox" id="${p}ReviewFirst"> The builder already finished a round: start with the review</label>
      <div class="field" id="${p}HandoffBox" hidden><label for="${p}Handoff">The builder's handoff message</label>
        <textarea id="${p}Handoff" rows="5" placeholder="Paste the builder's final message. If the builder is the Codex app, leave this empty to use the thread's last reply."></textarea>
        <label for="${p}Slice">Slice name (optional)</label><input type="text" id="${p}Slice" placeholder="Named from the message if left empty"></div>`;
const wireHandoff = (p) => $(`#${p}ReviewFirst`).addEventListener("change", (e) => ($(`#${p}HandoffBox`).hidden = !e.target.checked));
const handoffBody = (p) =>
  $(`#${p}ReviewFirst`).checked ? { reviewFirst: true, handoff: $(`#${p}Handoff`).value, slice: $(`#${p}Slice`).value } : {};

/** The rooms waiting for a build's folder, in words: "“Docs” waits for this folder to start building." */
const waitingWords = (rooms) => `${rooms.map((w) => `“${w.title}”`).join(" and ")} ${rooms.length > 1 ? "wait" : "waits"} for this folder to start building.`;

/**
 * A build refused because another room is building in its folder: the desk's words in `box`, and the choice to wait
 * for that room (the build then starts when it's done or stopped). `go(true)` sends the request again, waiting.
 */
function offerWait(box, error, go) {
  box.hidden = false;
  box.innerHTML = `<span>${esc(error.message)}</span> <button class="btn small you" type="button" data-wait>Wait for “${esc(error.room?.title ?? "it")}”, then build</button>`;
  const btn = $("[data-wait]", box);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await go(true);
    } catch (e) {
      btn.disabled = false;
      fail(e);
    }
  });
  btn.focus();
}

function newRoomSheet(mode = "chat") {
  const projects = S.state.config.projects;
  const current = project()?.id ?? projects[0]?.id;
  const installed = Object.entries(S.state.agents ?? {}).filter(([, a]) => a.installed).map(([id]) => id);
  const members = ["codex", "claude"].filter((a) => installed.includes(a));
  openSheet(`${sheetHead("New room", "Start something")}
  <form id="newRoomForm" style="display:grid;gap:16px">
    <div class="field"><label for="nrProject">Project</label><select id="nrProject">${projects.map((p) => `<option value="${p.id}" ${p.id === current ? "selected" : ""}>${esc(p.name)} · ${esc(p.path)}</option>`).join("")}<option value="__add">Add a project…</option></select></div>
    <div class="field" id="nrAdd" hidden><label for="nrPath">Project folder (absolute path)</label><input type="text" id="nrPath" placeholder="/home/you/project"></div>
    <div class="field"><span class="lbl">What kind of room</span><div class="modecards">
      <button type="button" class="modecard" data-mode="chat" aria-pressed="${mode === "chat"}">${ic("chat")}<b>Chat</b><span>Ask one agent or several. Let them discuss.</span></button>
      <button type="button" class="modecard" data-mode="plan" aria-pressed="${mode === "plan"}">${ic("plan")}<b>Plan</b><span>Independent proposals, critiques, your call, a written plan.</span></button>
      <button type="button" class="modecard" data-mode="build" aria-pressed="${mode === "build"}">${ic("build")}<b>Build</b><span>One builds, the other reviews, slice by slice.</span></button>
    </div></div>
    <div class="field"><span class="lbl">Crew</span>${crewChecks(members, "nrCrew")}</div>
    <div class="field" id="nrAppBox" hidden><label for="nrThread">Codex app thread for this room</label><select id="nrThread"><option value="">Loading your app threads…</option></select>
      <span class="hint" id="nrShared"></span></div>
    <div data-for="chat" class="field"><label for="nrText">First message</label><textarea id="nrText" rows="4" placeholder="What do you want to talk about?"></textarea>
      <label class="opt"><input type="checkbox" id="nrDiscuss"> Let them discuss for 2 rounds after their first answers</label></div>
    <div data-for="plan" class="field"><label for="nrTopic">What should be planned?</label><textarea id="nrTopic" rows="4" placeholder="The goal, constraints, what's out of scope…"></textarea></div>
    <div data-for="build" style="display:grid;gap:12px">
      <div class="field"><label for="nrPlan">Plan file (optional)</label><input type="text" id="nrPlan" placeholder="docs/plans/my-plan.md"></div>
      <div class="field"><label for="nrTask">Task</label><textarea id="nrTask" rows="3" placeholder="What to build. With a plan file: “Work through the remaining slices.”"></textarea></div>
      <div class="pair"><div class="field"><label for="nrBuilder">Builder</label><select id="nrBuilder">${agentOptions(installed, "codex")}</select></div>
      <div class="field"><label for="nrReviewer">Reviewer</label><select id="nrReviewer">${agentOptions(installed, "claude")}</select></div></div>
      ${handoffFields("nr")}
      <div id="nrWhereBox"></div>
    </div>
    <div class="field"><label for="nrTitle">Room name (optional)</label><input type="text" id="nrTitle" placeholder="Named after the first message if left empty"></div>
    <div class="ns-busy" role="alert" hidden></div>
    <div style="display:flex;gap:8px"><button class="btn primary" type="submit">Start</button><button class="btn" type="button" data-close>Cancel</button></div>
  </form>`);
  // The Codex app works in a thread of its own per room; offer the project's default, else the general one.
  const usesApp = () => {
    const m = $(".modecard[aria-pressed=true]")?.dataset.mode ?? "chat";
    return $$("input[name=nrCrew]:checked").some((i) => i.value === "codexapp") || (m === "build" && [$("#nrBuilder").value, $("#nrReviewer").value].includes("codexapp"));
  };
  const syncThread = () => ($("#nrShared").innerHTML = sharedThreadNote($("#nrThread").value));
  // Where a build works, with the exact folder: asked of the desk for the chosen project (the room's id comes with it).
  // Only the answer for the project chosen now, in this form, counts: a slower answer for one chosen before, or for a
  // form closed since (a new one has the same fields), is dropped. A build starts only once its folders have been
  // shown (see the submit below).
  const form = $("#newRoomForm");
  const inForm = (sel) => form.querySelector(sel);
  let preview = null;
  let asked = 0;
  const drawWhere = () => {
    if (!form.isConnected) return;
    const was = inForm("input[name=nrFolder]:checked")?.value;
    const id = inForm("#nrProject").value;
    inForm("#nrWhereBox").innerHTML =
      preview && preview.projectId === id
        ? folderChoice("nr", preview, { appCrew: usesApp() })
        : `<div class="field"><span class="lbl">Where it works</span><span class="hint">${id === "__add" ? "Shown once the project is added: press Start." : "Finding the folders…"}</span></div>`;
    const keep = was && inForm(`input[name=nrFolder][value=${was}]:not([disabled])`);
    if (keep) keep.checked = true;
  };
  const loadWhere = async () => {
    const id = inForm("#nrProject").value;
    const mine = ++asked;
    preview = null;
    drawWhere();
    if (!id || id === "__add") return null;
    const got = await api("GET", `/api/projects/${encodeURIComponent(id)}/workspace`).catch(() => null);
    if (!form.isConnected || mine !== asked || inForm("#nrProject").value !== id) return null;
    preview = got;
    drawWhere();
    return preview;
  };
  loadWhere();
  const syncApp = () => {
    $("#nrAppBox").hidden = !usesApp();
    drawWhere();
  };
  const fillThreads = async () => {
    const threads = await appThreads();
    $("#nrThread").innerHTML = threadOptions(threads, defaultThread($("#nrProject").value), threads.length ? "Choose a thread" : "No app threads found");
    syncThread();
  };
  $("#nrThread").addEventListener("change", syncThread);
  if (S.state.agents?.codexapp?.installed) fillThreads();
  const sync = () => {
    const m = $(".modecard[aria-pressed=true]")?.dataset.mode ?? "chat";
    for (const d of $$("[data-for]", $("#sheetBody"))) d.hidden = d.dataset.for !== m;
    $("#nrAdd").hidden = $("#nrProject").value !== "__add";
    syncApp();
  };
  sync();
  $("#sheetBody").addEventListener("click", (e) => {
    const card = e.target.closest(".modecard");
    if (card) {
      for (const c of $$(".modecard")) c.setAttribute("aria-pressed", String(c === card));
      sync();
    }
  });
  $("#nrProject").addEventListener("change", () => {
    sync();
    loadWhere();
    if (S.state.agents?.codexapp?.installed) fillThreads();
  });
  wireHandoff("nr");
  // The chosen builder and reviewer join the crew; the Codex app and headless Codex are the same agent, so keep one.
  const syncCrew = () => {
    const picked = [$("#nrBuilder").value, $("#nrReviewer").value];
    for (const box of $$("input[name=nrCrew]")) {
      if (picked.includes(box.value)) box.checked = true;
      else if ((box.value === "codex" && picked.includes("codexapp")) || (box.value === "codexapp" && picked.includes("codex"))) box.checked = false;
    }
  };
  $("#nrBuilder").addEventListener("change", () => (syncCrew(), syncApp()));
  $("#nrReviewer").addEventListener("change", () => (syncCrew(), syncApp()));
  $("#sheetBody").addEventListener("change", (e) => {
    const box = e.target.closest("input[name=nrCrew]");
    if (!box?.checked || !["codex", "codexapp"].includes(box.value)) return;
    const twin = box.value === "codex" ? "codexapp" : "codex";
    for (const sel of [$("#nrBuilder"), $("#nrReviewer")]) if (sel.value === twin && [...sel.options].some((o) => o.value === box.value)) sel.value = box.value;
    syncCrew();
  });
  $("#sheetBody").addEventListener("change", (e) => e.target.closest("input[name=nrCrew]") && syncApp());
  $("#newRoomForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      let projectId = $("#nrProject").value;
      const mode = $(".modecard[aria-pressed=true]").dataset.mode;
      if (projectId === "__add") {
        const added = await api("POST", "/api/projects", { path: $("#nrPath").value.trim() });
        projectId = added.id;
        // A build shows where it would work first: the new project is chosen in the form, and Start is pressed again.
        if (mode === "build") {
          const sel = $("#nrProject");
          if (![...sel.options].some((o) => o.value === added.id)) sel.insertBefore(new Option(`${added.name} · ${added.path}`, added.id), sel.querySelector("option[value=__add]"));
          sel.value = added.id;
          $("#nrAdd").hidden = true;
          await loadWhere();
          return toast("Project added", "Check where the build works, then press Start again.");
        }
      }
      const crew = $$("input[name=nrCrew]:checked").map((i) => i.value);
      const body = { projectId, mode, members: crew, title: $("#nrTitle").value };
      if (mode === "chat") Object.assign(body, { text: $("#nrText").value, to: "everyone", discuss: $("#nrDiscuss").checked ? 2 : 0 });
      if (mode === "plan") Object.assign(body, { topic: $("#nrTopic").value });
      if (mode === "build") {
        Object.assign(body, { planPath: $("#nrPlan").value, task: $("#nrTask").value, builder: $("#nrBuilder").value, reviewer: $("#nrReviewer").value, ...handoffBody("nr") });
        // The builder and reviewer are always part of the crew.
        body.members = [...new Set([...crew, body.builder, body.reviewer])];
        // Only with its folders shown for this project; the desk refuses a folder other than the one shown.
        if (preview?.projectId !== projectId) {
          await loadWhere();
          return toast("Where it works", "Check the folder it works in, then press Start again.");
        }
        const folder = inForm("input[name=nrFolder]:checked")?.value ?? "shared";
        Object.assign(body, { folder }, folder === "own" ? { roomId: preview.roomId, workspacePath: preview.own.path } : {});
        if (body.reviewFirst && !body.task.trim()) body.task = "After the review, carry on with the remaining work.";
      }
      if (body.members.includes("codexapp")) {
        body.appThread = $("#nrThread").value;
        if (!body.appThread) throw new Error("Choose the Codex app's thread for this room.");
      }
      if (mode === "plan" && !body.topic.trim()) throw new Error("Say what should be planned.");
      if (mode === "build" && !body.task.trim() && !body.planPath.trim()) throw new Error("Give a task or a plan file.");
      if (mode === "build" && body.builder === body.reviewer) throw new Error("Choose different agents to build and to review.");
      if (mode === "build" && body.reviewFirst && !body.handoff.trim() && body.builder !== "codexapp")
        throw new Error(
          S.state.agents?.codexapp?.installed
            ? `Paste ${name(body.builder)}'s handoff message, or choose Codex app as the builder to use your app thread's last reply.`
            : `Paste ${name(body.builder)}'s handoff message, so the reviewer knows what to review.`,
        );
      const go = async (wait) => {
        const created = await api("POST", "/api/rooms", { ...body, wait });
        closeSheet();
        history.pushState(null, "", `#/r/${created.id}`);
        await loadRoom(created.id, { open: true });
      };
      await go(false).catch((error) => (error.code === "folder-busy" ? offerWait($("#newRoomForm .ns-busy"), error, go) : Promise.reject(error)));
    } catch (error) {
      fail(error);
    }
  });
}

function startPlanSheet() {
  const r = room();
  openSheet(`${sheetHead("Plan", "Start a planning round")}
  <form id="planForm" style="display:grid;gap:14px">
    <p class="hint" style="margin:0">Each planner drafts on its own first, then critiques the others. You settle the open questions, one of them writes the plan and records your decisions in the repository, and another checks it. Sessions are kept, so the planners remember this room's conversation.</p>
    <div class="field"><label for="pTopic">What should be planned?</label><textarea id="pTopic" rows="5"></textarea></div>
    <div class="field"><span class="lbl">Planners</span>${r.crew.members.map((m) => `<label class="opt"><input type="checkbox" name="pWho" value="${m}" checked> ${name(m)}</label>`).join("")}</div>
    <div style="display:flex;gap:8px"><button class="btn primary" type="submit">Start planning</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
  $("#planForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", `/api/rooms/${r.id}/control`, { action: "start-plan", topic: $("#pTopic").value, participants: $$("input[name=pWho]:checked").map((i) => i.value) });
      closeSheet();
    } catch (error) {
      fail(error);
    }
  });
}

function startBuildSheet(planPath) {
  const r = room();
  const path = planPath ?? r.plan?.planPath ?? r.build?.planPath ?? "";
  openSheet(`${sheetHead("Build", "Start the build relay")}
  <form id="buildForm" style="display:grid;gap:14px">
    <p class="hint" style="margin:0">The builder works through the plan slice by slice. After each slice the reviewer checks it read-only; findings go straight back until it approves, then the builder moves on. You're asked only for real decisions.</p>
    <div class="field"><label for="bPlan">Plan file</label><input type="text" id="bPlan" value="${esc(path)}" placeholder="docs/plans/…"></div>
    <div class="field"><label for="bTask">Task</label><textarea id="bTask" rows="3">${path ? "Work through the plan's slices in order." : ""}</textarea></div>
    <div class="pair"><div class="field"><label for="bBuilder">Builder</label><select id="bBuilder">${agentOptions(r.crew.members, r.crew.builder)}</select></div>
    <div class="field"><label for="bReviewer">Reviewer</label><select id="bReviewer">${agentOptions(r.crew.members, r.crew.reviewer)}</select></div></div>
    ${handoffFields("b")}
    <div id="bWhereBox"></div>
    <div class="ns-busy" role="alert" hidden></div>
    <div style="display:flex;gap:8px"><button class="btn primary" type="submit">Start building</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
  wireHandoff("b");
  // Where it works: a room that has its own worktree stays there; one in the project's folder can move to its own.
  // This form's answer, for this form only: a sheet closed before it came doesn't write into the next one.
  const buildForm = $("#buildForm");
  let where = null;
  api("GET", `/api/rooms/${r.id}/workspace`)
    .then((w) => {
      if (!buildForm.isConnected) return;
      where = w;
      buildForm.querySelector("#bWhereBox").innerHTML = w.fixed
        ? `<p class="hint" style="margin:0">It works in this room's own worktree: <span class="mono">${esc(w.own.path)}</span>.</p>`
        : `${folderChoice("b", w, { appCrew: r.crew.members.includes("codexapp") })}${w.own ? `<p class="hint" style="margin:0">Moving to its own worktree starts the agents' sessions afresh there; the room's messages and plan go with it.</p>` : ""}`;
    })
    .catch(() => {});
  buildForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const folder = buildForm.querySelector("input[name=bFolder]:checked")?.value;
    // Its own worktree only where its folder was shown (the desk refuses another).
    const workspacePath = folder === "own" && !where?.fixed ? where?.own?.path : undefined;
    const go = async (wait) => {
      await api("POST", `/api/rooms/${r.id}/control`, { action: "start-build", planPath: $("#bPlan").value, task: $("#bTask").value, builder: $("#bBuilder").value, reviewer: $("#bReviewer").value, ...handoffBody("b"), wait, folder, workspacePath });
      closeSheet();
    };
    try {
      await go(false).catch((error) => (error.code === "folder-busy" ? offerWait($("#buildForm .ns-busy"), error, go) : Promise.reject(error)));
    } catch (error) {
      fail(error);
    }
  });
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** 3h14m, 42m, 1d3h (the same as src/plan.mjs). */
function shortDuration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** Model and effort dropdowns, filled from what the agent itself offers. Unlisted models stay choosable through "Other…". */
async function fillModels(id, current) {
  const modelSel = $(`#ag-${id}-model`);
  const effortSel = $(`#ag-${id}-effort`);
  const custom = $(`#ag-${id}-model-custom`);
  const hint = $(`#ag-${id}-effort-hint`);
  if (!modelSel) return;
  let list = { models: [] };
  try {
    list = await api("GET", `/api/agents/${id}/models`);
  } catch {
    /* fall back to Default and Other… */
  }
  // Settings may have closed while the list was loading (Cursor's takes a few seconds).
  if (!modelSel.isConnected) return;
  const models = list.models ?? [];
  const known = models.some((m) => m.id === current.model);
  modelSel.innerHTML =
    `<option value="">Default</option>` +
    models.map((m) => `<option value="${esc(m.id)}" ${m.id === current.model ? "selected" : ""}>${esc(m.label === m.id ? m.id : `${m.label} · ${m.id}`)}</option>`).join("") +
    `<option value="__custom" ${current.model && !known ? "selected" : ""}>Other…</option>`;
  const syncEffort = () => {
    const chosen = models.find((m) => m.id === modelSel.value);
    custom.hidden = modelSel.value !== "__custom";
    if (list.effortInName) {
      effortSel.hidden = true;
      hint.hidden = false;
      hint.textContent = "Set by the model you choose (its name says the effort).";
      return;
    }
    const efforts = chosen?.efforts?.length ? chosen.efforts : models.length ? [...new Set(models.flatMap((m) => m.efforts ?? []))] : EFFORTS;
    const keep = effortSel.value || current.effort || "";
    const def = chosen?.defaultEffort ? `Default (${chosen.defaultEffort})` : "Default";
    effortSel.innerHTML =
      `<option value="">${esc(def)}</option>` +
      [...new Set([...efforts, ...(keep && !efforts.includes(keep) ? [keep] : [])])]
        .map((e) => `<option value="${esc(e)}" ${e === keep ? "selected" : ""}>${esc(e)}${efforts.includes(e) ? "" : " (not offered by this model)"}</option>`)
        .join("");
  };
  modelSel.addEventListener("change", syncEffort);
  syncEffort();
}

/** The role picker, what an advisor is for, and removing an agent from the room. */
function crewControls(r, a, role, working) {
  const parts = [];
  if (r.mode === "build" && r.crew.members.length > 1) {
    const pending = r.rolesPending ? (a === r.rolesPending.builder ? "builder" : a === r.rolesPending.reviewer ? "reviewer" : "advisor") : null;
    parts.push(`<label class="rolepick"><span>Role</span><select data-role-agent="${a}">${["builder", "reviewer", "advisor"]
      .map((x) => `<option value="${x}" ${(pending ?? role) === x ? "selected" : ""}>${x[0].toUpperCase() + x.slice(1)}</option>`)
      .join("")}</select>${pending && pending !== role ? `<span class="hint">from the next building turn</span>` : ""}</label>`);
  }
  if (role === "advisor")
    parts.push(`<div class="hint">Not part of the relay. ${esc(name(a))} answers when you write to it (choose it in the message box, or start with @${a}) or when you ask for a second opinion on a message, and reads the whole room each time.</div>`);
  const keyRole = r.mode === "build" && (a === r.crew.builder || a === r.crew.reviewer);
  if (r.crew.members.length > 1)
    parts.push(
      keyRole || working
        ? `<div class="hint">${working ? "Can be removed when its turn has finished." : `To remove ${esc(name(a))}, give its role to someone else first.`}</div>`
        : `<div><button type="button" class="btn small quiet" data-remove-agent="${a}">Remove ${esc(name(a))} from this room</button></div>`,
    );
  return parts.length ? `<div class="crewctl">${parts.join("")}</div>` : "";
}

/** Who builds and who reviews if `agent` takes `role`; the agent it replaces takes its old place. */
function rolesFor(r, agent, role) {
  let { builder, reviewer } = r.rolesPending ?? r.crew;
  if (role === "builder") {
    if (agent === reviewer) reviewer = builder;
    builder = agent;
  } else if (role === "reviewer") {
    if (agent === builder) builder = reviewer;
    reviewer = agent;
  } else {
    const spare = r.crew.members.find((m) => m !== builder && m !== reviewer && m !== agent);
    if ((agent === builder || agent === reviewer) && !spare) throw new Error("A build needs a builder and a reviewer. Add another agent first, then give it this role.");
    if (agent === builder) builder = spare;
    else if (agent === reviewer) reviewer = spare;
  }
  return { builder, reviewer };
}

function settingsSheet() {
  const cfg = S.state.config;
  const proj = project() ?? cfg.projects[0];
  const agentFields = (id) => {
    const a = cfg.agents[id] ?? {};
    const extra =
      id === "codex"
        ? `<div class="field"><label for="ag-${id}-perm">Write access for builders</label><select id="ag-${id}-perm">
            <option value="sandboxed" ${(a.permissions ?? "sandboxed") === "sandboxed" ? "selected" : ""}>Sandboxed: repository and network only (tested)</option>
            <option value="auto-review" ${a.permissions === "auto-review" ? "selected" : ""}>Like the Codex app: asks, and an automatic reviewer approves (untested headless)</option>
            <option value="full" ${a.permissions === "full" ? "selected" : ""}>No sandbox (only on a machine you trust)</option></select></div>
            <div class="field"><label for="ag-${id}-roots">Extra folders Codex may write to when building (one per line)</label><textarea id="ag-${id}-roots" rows="2" placeholder="~/.cache">${esc((a.writableRoots ?? []).join("\n"))}</textarea></div>`
        : id === "claude"
          ? `<div class="field"><label for="ag-${id}-perm">Permission mode</label><select id="ag-${id}-perm">${["auto", "acceptEdits", "dontAsk", "bypassPermissions"].map((m) => `<option ${(a.permissionMode ?? "auto") === m ? "selected" : ""}>${m}</option>`).join("")}</select></div>`
          : "";
    return `<fieldset class="card" style="border:1px solid var(--line)"><legend class="eyebrow">${name(id)}</legend>
      <div class="pair"><div class="field"><label for="ag-${id}-model">Model</label><select id="ag-${id}-model" data-models="${id}"><option value="">Default</option>${a.model ? `<option value="${esc(a.model)}" selected>${esc(a.model)}</option>` : ""}</select>
        <input type="text" id="ag-${id}-model-custom" placeholder="Model name" value="${esc(a.model ?? "")}" hidden></div>
      <div class="field" id="ag-${id}-effort-field"><label for="ag-${id}-effort">Effort</label><select id="ag-${id}-effort"><option value="">Default</option>${a.effort ? `<option value="${esc(a.effort)}" selected>${esc(a.effort)}</option>` : ""}</select>
        <span class="hint" id="ag-${id}-effort-hint" hidden></span></div></div>${extra}</fieldset>`;
  };
  openSheet(
    `${sheetHead("Settings", "Toryo")}
    <form id="settingsForm" style="display:grid;gap:16px">
      <div class="field"><span class="lbl">Notifications</span>
        <label class="opt"><input type="checkbox" id="nWin" ${cfg.notify.windows !== false ? "checked" : ""}> Windows notifications when someone needs you or a plan finishes</label>
        <label class="opt"><input type="checkbox" id="nBrowser" ${"Notification" in window && Notification.permission === "granted" ? "checked" : ""}> Browser notifications when this tab is in the background</label>
        <div class="pair"><div class="field"><label for="nTopic">Phone (ntfy topic, optional)</label><input type="text" id="nTopic" value="${esc(cfg.notify.ntfyTopic ?? "")}" placeholder="a long random topic name"></div>
        <div class="field"><label for="nServer">ntfy server</label><input type="text" id="nServer" value="${esc(cfg.notify.ntfyServer ?? "")}" placeholder="https://ntfy.sh"></div></div>
        <p class="hint">ntfy sends the notification title and first line to that server. Leave it empty to keep everything on this machine.</p>
        <div><button type="button" class="btn small" id="testNotify">Send a test notification</button></div></div>
      <div class="field"><span class="lbl">Agents (defaults for every project)</span>${Object.keys(S.state.agents ?? cfg.agents).filter((id) => id !== "codexapp").map(agentFields).join("")}
        <fieldset class="card" style="border:1px solid var(--line)"><legend class="eyebrow">Codex app (experimental)</legend>
          <p class="hint" style="margin:0">Use a thread in your Codex desktop app as a crew member, so its work stays visible and steerable in the app and the ChatGPT phone app. Toryo queues messages into the thread and opens it in the app when needed; the app sends them once that thread is idle. Each room has its own thread, chosen when you create it; changing the default here doesn't move existing rooms.</p>
          <div class="field"><label for="ag-codexapp-thread">Default thread for new rooms</label><select id="ag-codexapp-thread"><option value="">None</option>${cfg.agents.codexapp?.thread ? `<option value="${esc(cfg.agents.codexapp.thread)}" selected>${esc(cfg.agents.codexapp.thread)}</option>` : ""}</select>
          <span class="hint" id="appThreadsHint">Loading your app threads…</span></div></fieldset>
        <div><button type="button" class="btn small" id="redetect">Look for agents again</button></div></div>
      ${
        proj
          ? `<div class="field"><span class="lbl">Project: ${esc(proj.name)}</span>
        <label for="pRules">House rules every agent gets</label><textarea id="pRules" rows="7">${esc(proj.rules ?? "")}</textarea>
        <label for="pDecisions">How decisions and plans are recorded</label><textarea id="pDecisions" rows="3" placeholder="Leave empty to follow the repository's own conventions">${esc(proj.decisions ?? "")}</textarea>
        <label for="pAppThread">Default Codex app thread for new rooms in this project</label><select id="pAppThread"><option value="">Use the general default</option>${proj.agents?.codexapp?.thread ? `<option value="${esc(proj.agents.codexapp.thread)}" selected>${esc(proj.agents.codexapp.thread)}</option>` : ""}</select>
        <span class="lbl">Checks Toryo runs before each review</span>
        <div class="gates" id="gates">${(proj.gates ?? []).map((g) => gateRow(g)).join("")}</div>
        <div><button type="button" class="btn small" id="addGate">Add a check</button></div></div>`
          : ""
      }
      <div style="display:flex;gap:8px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>`,
    { wide: true },
  );
  appThreads().then((threads) => {
    const sel = $("#ag-codexapp-thread");
    if (!sel) return;
    sel.innerHTML = threadOptions(threads, cfg.agents.codexapp?.thread ?? "", "None");
    if ($("#pAppThread")) $("#pAppThread").innerHTML = threadOptions(threads, proj?.agents?.codexapp?.thread ?? "", "Use the general default");
    $("#appThreadsHint").textContent = threads.length ? "New rooms with the Codex app start in this thread unless you pick another." : "No Codex desktop app threads found.";
  });
  for (const id of Object.keys(S.state.agents ?? cfg.agents).filter((x) => x !== "codexapp")) fillModels(id, cfg.agents[id] ?? {});
  $("#testNotify").addEventListener("click", async () => {
    await api("POST", "/api/notify/test");
    toast("Test sent", "Saved settings are used: save first if you just changed them.");
  });
  $("#addGate")?.addEventListener("click", () => $("#gates").appendChild(el(gateRow({ name: "", command: "" }))));
  $("#gates")?.addEventListener("click", (e) => e.target.closest("[data-remove-gate]")?.closest(".row").remove());
  $("#redetect").addEventListener("click", async () => {
    await api("POST", "/api/agents/refresh");
    toast("Agents checked", Object.entries(S.state.agents).map(([id, a]) => `${name(id)} ${a.installed ? "✓" : "✗"}`).join("  "));
  });
  $("#settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const agents = {};
      agents.codexapp = { thread: $("#ag-codexapp-thread")?.value || null };
      for (const id of Object.keys(S.state.agents ?? cfg.agents).filter((x) => x !== "codexapp")) {
        const model = $(`#ag-${id}-model`).value === "__custom" ? $(`#ag-${id}-model-custom`).value.trim() : $(`#ag-${id}-model`).value;
        agents[id] = { model: model || null, effort: $(`#ag-${id}-effort`).value || null };
        if (id === "codex") {
          agents[id].permissions = $(`#ag-${id}-perm`).value;
          agents[id].writableRoots = $(`#ag-${id}-roots`).value.split("\n").map((l) => l.trim()).filter(Boolean);
        }
        if (id === "claude") agents[id].permissionMode = $(`#ag-${id}-perm`).value;
      }
      // Use what was saved straight away, rather than waiting for the desk's next update.
      S.state.config = await api("PATCH", "/api/config", { notify: { windows: $("#nWin").checked, ntfyTopic: $("#nTopic").value.trim(), ntfyServer: $("#nServer").value.trim() }, agents });
      await api("POST", "/api/agents/refresh");
      if ($("#nBrowser").checked && "Notification" in window && Notification.permission !== "granted") await Notification.requestPermission();
      if (proj) {
        const appThread = $("#pAppThread")?.value || null;
        const saved = await api("PATCH", `/api/projects/${proj.id}`, {
          rules: $("#pRules").value,
          decisions: $("#pDecisions").value,
          agents: { ...proj.agents, codexapp: { ...proj.agents?.codexapp, thread: appThread ?? undefined } },
          gates: $$("#gates .row").map(gateFromRow).filter((g) => g.command),
        });
        S.state.config.projects = S.state.config.projects.map((p) => (p.id === saved.id ? saved : p));
      }
      closeSheet();
      toast("Settings saved", "They apply from the next turn.");
    } catch (error) {
      fail(error);
    }
  });
}
// Each row keeps the whole check it was made from, so saving never drops a setting this form doesn't show.
const gateRow = (g) =>
  `<div class="row" data-gate="${esc(JSON.stringify(g))}"><input type="text" name="gname" value="${esc(g.name ?? "")}" placeholder="Name, e.g. API typecheck"><input type="text" name="gcmd" value="${esc(g.command ?? "")}" placeholder="Command, run in the project folder"><input type="number" name="gmin" min="1" step="1" value="${esc(g.timeoutMin ?? "")}" placeholder="20" title="Time limit in minutes (20 if empty)" aria-label="Time limit in minutes" style="width:6em"><button type="button" class="btn small quiet" data-remove-gate>Remove</button></div>`;
const gateFromRow = (row) => {
  const gate = { ...JSON.parse(row.dataset.gate || "{}"), name: $("input[name=gname]", row).value.trim(), command: $("input[name=gcmd]", row).value.trim() };
  const min = Number($("input[name=gmin]", row).value);
  if (min > 0) gate.timeoutMin = min;
  else delete gate.timeoutMin;
  return gate;
};

async function fileSheet(path, line) {
  const r = room();
  const projectId = r?.projectId ?? S.state.config.projects[0]?.id;
  try {
    // In a room: the file in the folder it works in (its own worktree, or the project's).
    const f = await api("GET", r ? `/api/rooms/${r.id}/file?path=${encodeURIComponent(path)}` : `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`);
    const isMd = /\.(md|mdx|markdown)$/i.test(f.path);
    const body = isMd
      ? `<div class="viewer md">${renderMarkdown(f.content)}</div>`
      : `<div class="viewer"><pre>${f.content
          .split("\n")
          .map((l, i) => `<span id="L${i + 1}" style="display:block${Number(line) === i + 1 ? ";background:var(--warn-soft)" : ""}"><span class="hint" style="display:inline-block;width:4ch;text-align:right;margin-right:12px">${i + 1}</span>${esc(l)}</span>`)
          .join("")}</pre></div>`;
    openSheet(`${sheetHead("File", f.path)}${f.truncated ? `<div class="hint">Showing the first part of a large file.</div>` : ""}${body}`, { wide: true });
    if (line) $(`#L${Number(line)}`)?.scrollIntoView({ block: "center" });
  } catch (error) {
    fail(error);
  }
}

async function diffSheet(turnId, path) {
  const r = room();
  try {
    const d = await api("GET", `/api/rooms/${r.id}/turns/${turnId}/diff${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    const files = d.files.map((f) => `<button type="button" data-diff-file="${esc(f.path)}" aria-pressed="${f.path === path}">${esc(f.status)} ${esc(f.path)}</button>`).join("");
    const lines = d.diff
      .split("\n")
      .map((l) => {
        const cls = l.startsWith("diff --git") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "";
        return `<span class="${cls}">${esc(l) || " "}</span>`;
      })
      .join("");
    const ev = S.view.events.find((e) => e.id === turnId);
    openSheet(
      `${sheetHead("Changes", `${name(ev?.agent)}'s turn · ${d.files.length} file${d.files.length === 1 ? "" : "s"}`)}
      <div class="filelist">${path ? `<button type="button" data-diff-file="">All files</button>` : ""}${files}</div>
      <div class="diff">${lines || '<span class="hint">No textual changes.</span>'}</div>`,
      { wide: true },
    );
    $("#sheetBody").dataset.turn = turnId;
  } catch (error) {
    fail(error);
  }
}

async function promptSheet(turnId) {
  try {
    const text = await api("GET", `/api/rooms/${room().id}/turns/${turnId}/prompt`);
    openSheet(`${sheetHead("What Toryo sent", "The exact prompt for this turn")}<div class="viewer"><pre>${esc(text)}</pre></div>`, { wide: true });
  } catch (error) {
    fail(error);
  }
}

function roomSheet() {
  const r = room();
  const proj = project();
  const st = r.settings;
  openSheet(`${sheetHead("Room", "Room settings")}<form id="roomForm" style="display:grid;gap:14px">
    <div class="field"><label for="rmTitle">Name</label><input type="text" id="rmTitle" value="${esc(r.title)}"></div>
    <div class="field"><span class="lbl">Building</span>
      <label class="opt"><input type="checkbox" name="autoContinue" ${st.autoContinue ? "checked" : ""}> Continue to the next slice after approval, without asking</label>
      <label class="opt"><input type="checkbox" name="gates" ${st.gates !== false ? "checked" : ""}> Run the project's checks before each review${proj?.gates?.length ? ` (${proj.gates.map((g) => esc(g.name || g.command)).join(", ")})` : " (none set; add them in Settings)"}</label>
      <label class="opt"><input type="checkbox" name="snapshots" ${st.snapshots !== false ? "checked" : ""}> Snapshot the tree every turn, for the “files changed” diffs</label>
      <label class="opt"><input type="checkbox" name="freshReviewer" ${st.freshReviewer !== false ? "checked" : ""}> Fresh reviewer for each new slice, with a ledger of open findings and your decisions (the final review always gets one)</label></div>
    <div class="field"><span class="lbl">Planning</span>
      <label class="opt"><input type="checkbox" name="recheckAfterChanges" ${st.recheckAfterChanges !== false ? "checked" : ""}> Re-check after changes: when you ask for changes to a ready plan, the other planners check the revision once, and the author addresses what they find</label></div>
    <div class="pair"><label class="field"><span class="lbl">Review rounds per slice before asking you</span><input type="number" name="maxRounds" min="1" max="20" value="${st.maxRounds}"></label>
      <label class="field"><span class="lbl">Nudges when a builder stops without a status</span><input type="number" name="maxNudges" min="0" max="10" value="${st.maxNudges}"></label></div>
    <label class="field"><span class="lbl">Longest turn before Toryo gives up (minutes)</span><input type="number" name="turnTimeoutMin" min="5" max="1440" value="${st.turnTimeoutMin ?? 240}"></label>
    <div class="field"><span class="lbl">Session ${esc(r.session?.n ?? 1)}</span>
      <p class="hint" style="margin:0">For new work in this room, such as the next sprint: this session ends and its history stays, folded. Nothing is deleted.</p>
      <div><button class="btn" type="button" data-new-session>Start a new session…</button></div></div>
    <div style="display:flex;gap:8px;align-items:center"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button><span class="sep" style="flex:1"></span><button class="btn danger" type="button" id="deleteRoom">Delete room</button></div>
    <p class="hint" style="margin:0">Deleting removes the room from Toryo. Its transcript stays on disk in ~/.toryo/rooms/${esc(r.id)}, and nothing in your repository changes.${r.workspace?.kind === "worktree" ? ` Its own worktree stays too, with its changes: <span class="mono">${esc(r.workspace.cwd)}</span> (branch <span class="mono">${esc(r.workspace.branch)}</span>). Removing worktrees from Toryo comes in a later update.` : ""}${r.status === "running" ? " The turn that's running now is stopped first." : ""}</p></form>`);
  $("#roomForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      if ($("#rmTitle").value.trim() && $("#rmTitle").value.trim() !== r.title) await api("POST", `/api/rooms/${r.id}/control`, { action: "rename", title: $("#rmTitle").value });
      await api("POST", `/api/rooms/${r.id}/control`, {
        action: "settings",
        autoContinue: f.has("autoContinue"),
        snapshots: f.has("snapshots"),
        gates: f.has("gates"),
        freshReviewer: f.has("freshReviewer"),
        recheckAfterChanges: f.has("recheckAfterChanges"),
        maxRounds: Number(f.get("maxRounds")),
        maxNudges: Number(f.get("maxNudges")),
        turnTimeoutMin: Number(f.get("turnTimeoutMin")),
      });
      closeSheet();
      toast("Saved", "Room settings apply from the next turn.");
      loadRoom(r.id, { keepScroll: true });
    } catch (error) {
      fail(error);
    }
  });
  $("#deleteRoom").addEventListener(
    "click",
    () => {
      $("#deleteRoom").textContent = "Click again to delete";
      $("#deleteRoom").addEventListener(
        "click",
        async () => {
          await api("DELETE", `/api/rooms/${r.id}`).catch(fail);
          closeSheet();
          S.state.rooms = S.state.rooms.filter((x) => x.id !== r.id);
          S.roomId = null;
          S.view = null;
          $("#log").innerHTML = "";
          // Home, after the room you were in is gone.
          history.replaceState(null, "", "#/");
          showHome();
        },
        { once: true },
      );
    },
    { once: true },
  );
}

// ------------------------------------------------------------------ a new session

/** What keeps the room from starting a new session, in words (the desk says the same when it refuses). */
function sessionBusy(r) {
  const doing = { build: "building", review: "reviewing", plan: "planning", checks: "running", chat: "replying" };
  const sum = S.state?.rooms.find((x) => x.id === r.id);
  const out = (sum?.working ?? []).map((w) => (w.agent === "toryo" ? "The checks are running" : `${name(w.agent)} is ${doing[workKind(w.kind)]}`));
  const queue = r.queue ?? [];
  if (queue.length) {
    const what = queue.map((q) => (q.agent === "toryo" ? "the checks" : `${name(q.agent)}'s ${{ build: "building turn", review: "review", plan: "planning turn", checks: "checks", chat: "reply" }[workKind(q.kind)]}`));
    out.push(`${what.join(", ").replace(/^./, (c) => c.toUpperCase())} ${what.length > 1 ? "are" : "is"} queued`);
  }
  if (r.appTurn && !(sum?.working ?? []).some((w) => w.agent === "codexapp")) out.push("The Codex app still has this room's turn");
  return out;
}

/**
 * Start a new session in the room: what ends (its planning round or build, open questions, notes not sent yet), the
 * agents' memory, and the first step, as the new-room form starts one. Refused while anything runs or is queued:
 * the sheet says what, and offers to stop the room.
 */
function newSessionSheet() {
  const r = room();
  if (!r) return;
  const n = r.session?.n ?? 1;
  const sum = S.state?.rooms.find((x) => x.id === r.id);
  const ends = [];
  if (r.mode === "plan" && r.plan) ends.push(`the planning round on “${r.plan.topic}”`);
  if (r.mode === "build" && r.build) ends.push(`the build${r.build.slice ? ` (${r.build.slice})` : ""}`);
  const asks = sum?.questions?.length ?? 0;
  if (asks) ends.push(`${asks} open question${asks === 1 ? "" : "s"}, which close`);
  const unsent = S.view.events.filter((e) => e.type === "owner" && !e.kind && !e.cancelled && !e.notSent?.length && (e.to ?? []).some((a) => !(e.deliveredTo ?? []).includes(a) && !e.readBy?.[a])).length;
  if (unsent) ends.push(`${unsent} note${unsent === 1 ? "" : "s"} the agents haven't had yet, which won't be sent`);
  const members = r.crew.members;
  const v = S.timeline?.view(undefined, {});
  const totals = v ? `${durationWords(v.length)}: ${workWords(v.totals)}` : "";
  openSheet(`${sheetHead("New session", `Start session ${n + 1}`)}
  <form id="sessionForm" style="display:grid;gap:14px">
    <p style="margin:0">For new work in this room, such as the next sprint. Session ${n} ends${ends.length ? `: ${esc(ends.join("; "))}` : ""}. It stays in the room, folded, with its totals${totals ? ` (${esc(totals)})` : ""}. The room's name, crew, settings, folder and ledger stay.</p>
    <div class="ns-busy" role="alert" hidden><span></span> <button class="btn small" type="button" data-ns-stop>Stop the room</button></div>
    <div class="field"><label class="opt"><input type="checkbox" id="nsKeep"> Keep the agents' memory of this room</label>
      <span class="hint">Otherwise each agent starts fresh on its next turn, with Toryo's briefing.${members.includes("codexapp") ? " The Codex app keeps its thread either way: its memory is the thread." : ""}</span></div>
    <div class="field"><span class="lbl">Then</span><div class="modecards ns-modes">
      <button type="button" class="modecard" data-mode="none" aria-pressed="true">${ic("dots")}<b>Nothing yet</b><span>The room waits in chat.</span></button>
      <button type="button" class="modecard" data-mode="chat" aria-pressed="false">${ic("chat")}<b>Chat</b><span>A first message for the crew.</span></button>
      <button type="button" class="modecard" data-mode="plan" aria-pressed="false">${ic("plan")}<b>Plan</b><span>A planning round.</span></button>
      <button type="button" class="modecard" data-mode="build" aria-pressed="false">${ic("build")}<b>Build</b><span>A task, or a plan's slices.</span></button>
    </div></div>
    <div data-for="chat" class="field" hidden><label for="nsText">First message</label><textarea id="nsText" rows="3"></textarea></div>
    <div data-for="plan" class="field" hidden><label for="nsTopic">What should be planned?</label><textarea id="nsTopic" rows="3" placeholder="The next sprint: the goal, constraints, what's out of scope…"></textarea></div>
    <div data-for="build" style="display:grid;gap:12px" hidden>
      <div class="field"><label for="nsPlan">Plan file (optional)</label><input type="text" id="nsPlan" placeholder="docs/plans/my-plan.md" value="${esc(r.plan?.planPath ?? r.build?.planPath ?? "")}"></div>
      <div class="field"><label for="nsTask">Task</label><textarea id="nsTask" rows="3" placeholder="What to build. With a plan file: “Work through the remaining slices.”"></textarea></div>
      <div class="pair"><div class="field"><label for="nsBuilder">Builder</label><select id="nsBuilder">${agentOptions(members, r.crew.builder)}</select></div>
      <div class="field"><label for="nsReviewer">Reviewer</label><select id="nsReviewer">${agentOptions(members, r.crew.reviewer)}</select></div></div>
      ${handoffFields("ns")}
    </div>
    <div style="display:flex;gap:8px"><button class="btn primary" type="submit" id="nsGo">Start session ${n + 1}</button><button class="btn" type="button" data-close>Cancel</button></div>
  </form>`);
  const form = $("#sessionForm");
  const busyBox = $(".ns-busy", form);
  const showBusy = (text) => {
    busyBox.hidden = !text;
    $("span", busyBox).textContent = text ?? "";
  };
  const busy = sessionBusy(r);
  if (busy.length) showBusy(`${busy.join(". ")}. Wait for ${busy.length > 1 ? "them" : "it"} to finish, or stop the room first.`);
  const mode = () => $(".modecard[aria-pressed=true]", form)?.dataset.mode ?? "none";
  form.addEventListener("click", async (e) => {
    const card = e.target.closest(".modecard");
    if (card) {
      for (const c of $$(".modecard", form)) c.setAttribute("aria-pressed", String(c === card));
      for (const d of $$("[data-for]", form)) d.hidden = d.dataset.for !== mode();
    }
    if (e.target.closest("[data-ns-stop]")) {
      await api("POST", `/api/rooms/${r.id}/control`, { action: "stop" }).catch(fail);
      showBusy("Stopped. Anything still finishing ends in a moment; then start the new session.");
    }
  });
  wireHandoff("ns");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = $("#nsGo");
    // One request, however many clicks: the desk refuses a second one for the same session too.
    if (go.disabled) return;
    const m = mode();
    const then =
      m === "chat"
        ? { mode: m, text: $("#nsText").value, to: "everyone" }
        : m === "plan"
          ? { mode: m, topic: $("#nsTopic").value }
          : m === "build"
            ? { mode: m, planPath: $("#nsPlan").value, task: $("#nsTask").value, builder: $("#nsBuilder").value, reviewer: $("#nsReviewer").value, ...handoffBody("ns") }
            : undefined;
    if (then?.reviewFirst && !then.task.trim()) then.task = "After the review, carry on with the remaining work.";
    go.disabled = true;
    const send = async (wait) => {
      await api("POST", `/api/rooms/${r.id}/control`, { action: "new-session", ends: n, keepMemory: $("#nsKeep").checked, then: then && { ...then, wait } });
      closeSheet();
      toast(`Session ${n + 1} started`, `Session ${n} is folded in the room, with its totals.`);
      S.shownSession = null;
      await loadRoom(r.id, { keepScroll: false });
    };
    try {
      await send(false);
    } catch (error) {
      go.disabled = false;
      // A build as the first step, refused because another room is building in this folder: it can wait instead.
      if (error.code === "folder-busy") offerWait(busyBox, error, send);
      else showBusy(error.message);
    }
  });
}

// ------------------------------------------------------------------ the session's timeline

const LANE_NAMES = { plan: "Planning", build: "Building", review: "Reviewing", checks: "Checks", other: "Other work" };

/**
 * The strip at the top of the room: one lane per phase on one time axis, long breaks drawn short, waiting for you
 * shaded, paused or held hatched, and the totals in words, which open the full list (for the keyboard and screen
 * readers). On a phone, one bar of the totals. Drawn from the room's events as they come, and once a minute.
 */
function renderSession() {
  const box = $("#sessionStrip");
  const r = room();
  if (!r || !S.timeline || S.page !== "room") return;
  // The session going on, or an earlier one you chose to see (from the list); it ends where the next began.
  const count = S.timeline.list.length;
  const shown = S.shownSession != null && S.shownSession < count - 1 ? S.shownSession : null;
  const cur = S.timeline.current;
  const live = [...S.live.values()].filter((l) => l.kind === "gates").map((l) => ({ id: l.turnId, kind: "gates", agent: "toryo", startedAt: l.startedAt }));
  const v = shown != null ? S.timeline.view(shown) : S.timeline.view(undefined, { live, end: r.done && cur.last != null ? cur.last : null });
  const n = S.timeline.list[shown ?? count - 1].n;
  S.session = v;
  S.sessionShown = { i: shown ?? count - 1, n, earlier: shown != null };
  // A room with one session shows the strip once something has run; with earlier sessions, always (they're there).
  if (!v.segments.length && count < 2) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const x = sessionAxis(v);
  const span = (a, b, min = 0) => `left:${x(a).toFixed(3)}%;width:${Math.max(min, x(b) - x(a)).toFixed(3)}%`;
  const lanes = LANES.filter((lane) => lane !== "other" || v.totals.other > 0);
  const list = phaseList(v.totals);
  const words = `${count > 1 ? `Session ${n}${shown != null ? " (earlier)" : ""} · ` : ""}${list.filter((p) => LANES.includes(p.key)).map((p) => `${LANE_NAMES[p.key]} ${durationWords(p.ms)}`).join(" · ") || (LANES.some((l) => v.totals[l] > 0) ? "Under a second of work" : "Nothing run yet")} · ${durationWords(v.length)} in all`;
  const worked = LANES.reduce((n, l) => n + v.totals[l], 0) || 1;
  // Built once, then changed in place, each part only when it changed: the words keep the focus while news comes in.
  if (!box.firstElementChild) {
    box.innerHTML = `<div class="ss-track" role="img"></div><div class="ss-bar" aria-hidden="true"></div>
      <div class="ss-side"><button type="button" class="ss-words" data-session-list title="The session, phase by phase"></button><button type="button" class="linkbtn ss-back" data-show-session="now" hidden></button></div>`;
  }
  const back = $(".ss-back", box);
  back.hidden = shown == null;
  back.textContent = `Back to session ${S.timeline.n}`;
  const track = $(".ss-track", box);
  track.setAttribute("aria-label", sessionWords(v, shown != null ? `Session ${n}` : "This session"));
  setHtml(track, `${v.waiting.map(([a, b]) => `<i class="ss-shade" data-k="waiting" style="${span(a, b)}"></i>`).join("")}
      ${[...v.paused, ...v.held].map(([a, b]) => `<i class="ss-shade" data-k="paused" style="${span(a, b)}"></i>`).join("")}
      ${lanes
        .map((lane) => `<div class="ss-lane" data-lane="${lane}">${v.segments
          .filter((s) => s.lane === lane)
          .map((s) =>
            // A link to its turn or checks; work with nothing in the room yet (checks running) or ever (checks cut short) isn't one.
            s.inRoom === false
              ? `<i class="ss-seg" style="${span(s.from, s.to, 0.5)}" title="${esc(segmentWords(s))}"></i>`
              : `<a href="#" class="ss-seg" data-seg="${esc(s.id)}" tabindex="-1" style="${span(s.from, s.to, 0.5)}" title="${esc(segmentWords(s))}"></a>`,
          )
          .join("")}</div>`)
        .join("")}
      ${v.breaks.map((b) => `<span class="ss-break" style="${span(b.from, b.to)}" title="${esc(`${durationWords(b.to - b.from)} ${b.why === "waiting" ? "waiting for you" : "with nothing running"}`)}">${esc(durationWords(b.to - b.from))}</span>`).join("")}`);
  setHtml($(".ss-bar", box), LANES.filter((l) => v.totals[l] > 0).map((l) => `<i data-lane="${l}" style="width:${((v.totals[l] / worked) * 100).toFixed(2)}%"></i>`).join(""));
  setHtml($(".ss-words", box), `${esc(words)}${v.overlap ? `<span class="muted"> (phases overlap)</span>` : ""}`);
}

/** Sets an element's HTML only when it differs from what it was last given. */
const lastHtml = new WeakMap();
function setHtml(node, html) {
  if (lastHtml.get(node) === html) return;
  lastHtml.set(node, html);
  node.innerHTML = html;
}

/**
 * Time to a position on the strip, in percent. Breaks (long stretches with nothing running) are drawn as 3% of the
 * time worked each, so the work stays readable however long the room has waited.
 */
function sessionAxis(v) {
  const removed = v.breaks.reduce((n, b) => n + (b.to - b.from), 0);
  const active = Math.max(1, v.length - removed);
  const short = active * 0.03;
  const total = active + short * v.breaks.length;
  return (t) => {
    let pos = 0;
    let cur = v.start;
    for (const b of v.breaks) {
      if (t <= b.from) break;
      pos += b.from - cur;
      if (t < b.to) return ((pos + (short * (t - b.from)) / (b.to - b.from)) / total) * 100;
      pos += short;
      cur = b.to;
    }
    return (Math.min(total, pos + Math.max(0, t - cur)) / total) * 100;
  };
}

/** One piece of work on the strip, in words: who, what, when, how long. */
function segmentWords(s) {
  const who = s.agent === "toryo" ? "The checks" : `${name(s.agent)}, ${(KIND[s.kind] ?? s.kind ?? "").toLowerCase()}`;
  const slice = s.slice ? `, ${s.slice}${s.round > 1 ? ` round ${s.round}` : ""}` : "";
  return `${who}${slice}: ${clock(new Date(s.from).toISOString())}–${s.running ? "now" : clock(new Date(s.to).toISOString())} (${durationWords(s.to - s.from)})${s.ok === false ? ", failed" : ""}${s.estimated ? ", start estimated" : ""}${s.cut ? CUT[s.cut] ?? ", cut short" : ""}`;
}
const CUT = { stopped: ", stopped before the end", superseded: ", cut short when the room moved on", crashed: ", crashed", restart: ", cut off when Toryo stopped (run again after)" };

/** The session as a list: each phase's total, then every piece of work, each a link to it in the room. */
function sessionSheet() {
  const v = S.session;
  if (!v) return;
  const list = phaseList(v.totals);
  const { i: at, n, earlier } = S.sessionShown ?? { i: 0, n: 1, earlier: false };
  const iso = (ms) => new Date(ms).toISOString();
  // Every session of the room, each one shown on the strip on request.
  const sessions = S.timeline.list.length > 1
    ? `<h3 class="eyebrow">Sessions</h3><ul class="ss-list">${S.timeline.list
        .map((x, k) => {
          const w = S.timeline.view(k === S.timeline.list.length - 1 ? undefined : k);
          const label = `Session ${x.n}: ${whenText(iso(w.start))}${k === S.timeline.list.length - 1 ? ", now" : ` to ${whenText(iso(w.end))}`}, ${durationWords(w.length)}`;
          return `<li>${k === at ? `<b>${esc(label)}</b> (on the strip)` : `<button type="button" class="linkbtn" data-show-session="${k === S.timeline.list.length - 1 ? "now" : k}">${esc(label)}</button>`}</li>`;
        })
        .join("")}</ul>`
    : "";
  openSheet(`${sheetHead(earlier ? `Session ${n}, earlier` : S.timeline.list.length > 1 ? `Session ${n}` : "This session", durationWords(v.length))}
    <p>${esc(sessionWords(v, earlier ? `Session ${n}` : "This session"))}${v.overlap ? " Phases can overlap (a reply while building, say), so the totals can add up to more than the session." : ""}</p>
    <ul class="ss-list">${list.map((p) => `<li><b>${esc(p.words[0].toUpperCase() + p.words.slice(1))}</b> ${esc(durationWords(p.ms))}</li>`).join("")}</ul>
    ${LANES.filter((lane) => v.segments.some((s) => s.lane === lane))
      .map((lane) => `<h3 class="eyebrow">${LANE_NAMES[lane]}</h3><ul class="ss-list">${v.segments
        .filter((s) => s.lane === lane)
        .map((s) => `<li>${s.inRoom === false ? esc(segmentWords(s)) : `<a href="#" data-seg="${esc(s.id)}">${esc(segmentWords(s))}</a>`}</li>`)
        .join("")}</ul>`)
      .join("")}
    ${v.breaks.length ? `<h3 class="eyebrow">Breaks</h3><ul class="ss-list">${v.breaks.map((b) => `<li>${esc(`${clock(new Date(b.from).toISOString())}–${clock(new Date(b.to).toISOString())}: ${durationWords(b.to - b.from)} ${b.why === "waiting" ? "waiting for you" : "with nothing running"}`)}</li>`).join("")}</ul>` : ""}
    ${sessions}`);
}

// ------------------------------------------------------------------ Home

/**
 * Home's overview, fetched whole (GET /api/home: never a transcript). One fetch at a time: news while one is on its
 * way asks for one more after it. A burst of news (many rooms at work) waits for a quarter of a second of quiet, and
 * never more than a second, so it costs one fetch, not one per room or per event.
 */
let homeLoading = false;
let homeAgain = false;
let homeTimer = null;
let homeFirstNews = 0;
async function loadHome() {
  if (homeLoading) {
    homeAgain = true;
    return;
  }
  homeLoading = true;
  try {
    do {
      homeAgain = false;
      try {
        S.home = await api("GET", `/api/home?recent=${S.recent}`);
        if (S.page === "home") renderHome();
      } catch {
        /* the next news, or the reconnect, tries again */
      }
    } while (homeAgain);
  } finally {
    homeLoading = false;
  }
}
function homeSoon() {
  if (S.page !== "home") return;
  homeFirstNews ||= Date.now();
  clearTimeout(homeTimer);
  homeTimer = setTimeout(() => {
    homeFirstNews = 0;
    loadHome();
  }, Math.max(0, Math.min(250, 1000 - (Date.now() - homeFirstNews))));
}
/** A working agent's latest line, straight from the live feed: no fetch. */
function homeActivity({ turnId, item }) {
  const card = $(`#home [data-turn="${CSS.escape(turnId)}"]`);
  if (!card) return;
  const line = $("[data-activity]", card);
  if (line) line.textContent = item.text ?? "";
  const out = $("[data-ago]", card);
  if (out && item.at) {
    out.dataset.ago = item.at;
    out.textContent = ago(item.at);
  }
}

/** How long ago, to the second while it's recent (a turn's last output). */
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
/** A moment in words, in your own time zone: "Tue 14 Oct, 09:00". */
const whenText = (iso) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const span = (a, b) => duration(a, b ?? new Date().toISOString()) || "0s";

function renderHome() {
  const box = $("#home");
  const h = S.home;
  if (!h || !S.state) {
    if (!$(".home", box)) box.innerHTML = `<div class="home"><p class="hint">Loading Home…</p></div>`;
    return;
  }
  const top = box.scrollTop;
  // Drawn again as news comes, part by part: a link or button you'd reached (by keyboard, say) keeps the focus, and
  // a question you're answering isn't drawn again at all (see patchNeeds).
  const focused = box.contains(document.activeElement) && document.activeElement.matches("a, button") ? focusKey(document.activeElement) : null;
  if (!$(".home [data-part]", box))
    box.innerHTML = `<div class="home"><div data-part="offline"></div><div data-part="hero"></div><div data-part="result"></div>
      <div class="home-grid"><div class="col"><div data-part="needs"></div><div data-part="working"></div><div data-part="others"></div></div>
      <div class="col"><div data-part="usage"></div><div data-part="recent"></div></div></div></div>`;
  setPart("offline", S.connected ? "" : `<div class="offline" role="status">${ic("alert")}<span>Reconnecting to the desk… What you see here may be out of date.</span></div>`);
  setPart("hero", homeHero(h));
  setPart("result", homeResult());
  patchNeeds(h);
  setPart("working", homeWorking(h));
  setPart("others", homeOthers(h));
  setPart("usage", homeUsage(h));
  setPart("recent", homeRecent(h));
  box.scrollTop = top;
  if (focused && !box.contains(document.activeElement)) [...box.querySelectorAll("a, button")].find((el) => focusKey(el) === focused)?.focus({ preventScroll: true });
  wakeSparklers();
}

/** One part of Home, drawn again only when what it shows has changed. */
const homeParts = new Map();
function setPart(name, html) {
  if (homeParts.get(name) === html && $(`#home [data-part="${name}"]`)?.childElementCount) return;
  homeParts.set(name, html);
  $(`#home [data-part="${name}"]`).innerHTML = html;
}

/** What makes one of Home's links or buttons the same one after Home is drawn again. */
function focusKey(el) {
  return el.dataset.key ?? `${el.tagName}|${el.getAttribute("href") ?? ""}|${el.dataset.openQuestion ?? ""}|${el.closest("[data-turn]")?.dataset.turn ?? ""}|${el.hasAttribute("data-more-recent")}|${el.closest("li")?.querySelector("time")?.dataset.ago ?? ""}`;
}

/** A button on Home that does one thing: `act` and its arguments ride on it, and `key` keeps its focus across redraws. */
function homeBtn(label, act, args = {}, cls = "btn small") {
  const data = Object.entries(args).map(([k, v]) => ` data-${k}="${esc(String(v))}"`).join("");
  return `<button type="button" class="${cls}" data-act="${act}"${data} data-key="${esc(`${act}|${Object.values(args).join("|")}`)}">${label}</button>`;
}

function homeHero(h) {
  const working = new Set(h.working.map((w) => w.room)).size;
  const asks = h.questionCount;
  const need = asks ? `<em>${asks} question${asks > 1 ? "s need" : " needs"} you</em>` : "";
  let headline;
  if (h.desk.paused) headline = "Everything is paused.";
  else if (working && asks) headline = `${working} room${working > 1 ? "s are" : " is"} working, and ${need}.`;
  else if (asks) headline = `${need}. Nothing else is moving.`;
  else if (working) headline = `${working} room${working > 1 ? "s are" : " is"} working. Nothing needs you.`;
  else headline = "All quiet. Nothing is running, and nothing needs you.";
  // Pause everything, and what Resume will let go: the rooms waiting only on the pause.
  const finishing = h.working.length;
  const waiting = h.rooms.filter((r) => (r.blocked ?? []).some((b) => b.reasons.includes("everything is paused"))).length;
  const pause = h.desk.paused
    ? `${homeBtn(`${ic("play")}Resume everything`, "desk", { do: "resume" }, "btn primary")}<span class="hint">${esc(`${finishing ? `${finishing} turn${finishing > 1 ? "s" : ""} still finishing. ` : ""}Resume lets ${waiting ? `${waiting} room${waiting > 1 ? "s" : ""} waiting on the pause` : "new work"} start again; your holds and the guard stay.`)}</span>`
    : homeBtn(`${ic("pause")}Pause everything`, "desk", { do: "pause" }, "btn");
  // Each restriction, with the way to lift it.
  const desk = [];
  if (h.desk.problem) desk.push(`<span class="chip" data-k="bad">${ic("alert")}${esc(h.desk.problem.text)}</span>`);
  for (const hold of h.desk.holds) desk.push(`<span class="chip" data-k="held">${ic("lock")}You hold ${esc(hold.label)} ${homeBtn("Release", "desk", { do: "release", target: hold.key.replace(":headless", ""), headless: hold.key.endsWith(":headless") }, "linkbtn")}</span>`);
  // Folders you said you're using: Toryo starts nothing new in them.
  for (const f of h.desk.folders ?? []) desk.push(`<span class="chip" data-k="held">${ic("lock")}You're using <span class="mono">${esc(f.root)}</span> ${homeBtn("Release", "desk", { do: "release-folder", project: f.root }, "linkbtn")}</span>`);
  for (const g of h.desk.guard.holds) {
    const policy = h.desk.guard.policies.find((p) => p.group === g.group);
    const target = policy?.target ?? g.group;
    const window = g.type.replace(/_/g, "-");
    const action = g.excepted
      ? ""
      : g.state === "ready"
        ? homeBtn("Release it", "guard", { do: "guard-release", target, window }, "linkbtn")
        : g.resetsAt
          ? homeBtn("Let it run until the reset", "guard", { do: "guard-pause", target, window }, "linkbtn")
          : `<span class="muted">Its reset time isn't known.</span> ${homeBtn("Turn this rule off", "guard", { do: "rule-off", target, window }, "linkbtn")}`;
    desk.push(`<span class="chip" data-k="${g.excepted ? "idle" : "held"}">${ic("lock")}${esc(g.excepted ? `The guard is paused for ${g.name}'s ${g.label} limit until it resets` : `${g.reason[0].toUpperCase()}${g.reason.slice(1)}`)} ${action}</span>`);
  }
  const notice = h.desk.guard.notice?.pending
    ? `<div class="notice" role="status"><p>The usage guard is on: when an agent's 5-hour or weekly usage reaches 90%, Toryo lets its running turns finish and starts no new ones until that limit resets, then carries on by itself.</p><div class="actions">${homeBtn("OK", "guard", { do: "guard-ok" }, "btn small primary")}${homeBtn("Turn it off", "guard", { do: "guard-all-off" }, "btn small")}${homeBtn("Settings…", "guard-sheet", {}, "btn small quiet")}</div></div>`
    : "";
  return `<section class="hero" aria-labelledby="h-home">
    <div class="hero-text"><p class="eyebrow">Home · ${esc(new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }))}</p><h1 id="h-home">${headline}</h1>${h.desk.paused ? `<p class="lede">Rooms you paused yourself stay paused when you resume.</p>` : ""}</div>
    <div class="deskbar"><div class="deskctl">${pause}${homeBtn(`${ic("lock")}Usage guard`, "guard-sheet", {}, "btn quiet")}${homeBtn(`${ic("lock")}I'm using a folder…`, "folder-sheet", {}, "btn quiet")}</div>${desk.join("")}</div>
    ${notice}
  </section>`;
}

/**
 * The folders you can say you're using yourself (an editor, the Codex app on its own): Toryo then starts nothing new
 * in them until you release them. It can't see what you do there; it only keeps its own work out.
 */
function folderSheet() {
  const folders = S.home?.desk?.folders ?? S.state?.desk?.folders ?? [];
  openSheet(`${sheetHead("Folders", "I'm using a folder")}
    <p class="hint" style="margin:0 0 12px">While you work in a folder yourself (in an editor, or with the Codex app on its own), Toryo starts nothing new in it, in any room. Turns already running there finish. Toryo can't see what you do: it only keeps its own work out until you release the folder.</p>
    <ul class="ss-list folderlist">${S.state.config.projects
      .map((p) => {
        // The folder you're using that keeps Toryo out of this project (its own, or one around it): released by that
        // folder itself, whatever the projects are called.
        const f = folders.find((x) => x.projects?.includes(p.id)) ?? folders.find((x) => x.covers?.includes(p.id));
        const action = f
          ? `${f.projects?.includes(p.id) ? "" : `<span class="hint">You're using <span class="mono">${esc(f.root)}</span>, around it.</span> `}${homeBtn("Release", "desk", { do: "release-folder", project: f.root }, "btn small")}`
          : homeBtn("I'm using it", "desk", { do: "use-folder", project: p.id }, "btn small");
        return `<li><b>${esc(p.name)}</b> <span class="mono muted">${esc(p.path)}</span> ${action}</li>`;
      })
      .join("")}</ul>`);
}

/** What the desk said after you used one of its controls, with any way forward it offers (Release: the guard). */
function homeResult() {
  const r = S.deskResult;
  if (!r) return "";
  const offers = (r.offers ?? [])
    .map((o) => {
      const btn = o.action === "pause-until-reset" ? homeBtn("Pause this guard until reset", "guard", { do: "guard-pause", target: o.mcp.arguments.target, window: o.mcp.arguments.window }, "btn small you")
        : o.action === "release-expired-hold" ? homeBtn("Release it", "guard", { do: "guard-release", target: o.mcp.arguments.target, window: o.mcp.arguments.window }, "btn small you")
        : homeBtn("Turn this rule off", "guard", { do: "rule-off", target: o.mcp.arguments.target, window: Object.keys(o.mcp.arguments.rules ?? {})[0] ?? "" }, "btn small");
      return `<li><span>${esc(o.text)}.</span>${btn}</li>`;
    })
    .join("");
  return `<div class="deskresult" role="status" data-error="${Boolean(r.error)}"><p>${esc(r.message)}</p>${offers ? `<ul>${offers}</ul>` : ""}${homeBtn("Dismiss", "dismiss-result", {}, "btn small quiet")}</div>`;
}

function homeTile(roomId, title) {
  const sum = S.state.rooms.find((r) => r.id === roomId) ?? { id: roomId, title, status: "idle" };
  return roomTile(sum, 40);
}

// ------------------------------------------------------------------ Home: answering

/**
 * Answers written on Home, per question, kept in this browser until sent or dismissed: a reload, news or another
 * room never loses one. { [questionId]: { room, text } }.
 */
function homeDrafts() {
  try {
    return JSON.parse(localStorage.getItem("toryo.homeDrafts") ?? "{}");
  } catch {
    return {};
  }
}
function setHomeDraft(qid, value) {
  const all = homeDrafts();
  if (value) all[qid] = value;
  else delete all[qid];
  try {
    localStorage.setItem("toryo.homeDrafts", JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
/**
 * A draft, with its question as it was shown: if the question closes (answered elsewhere, even while this page was
 * closed), the card can still be drawn, saying so, with your text to copy or dismiss.
 */
function draftFor(qid, text) {
  const q = S.homeCards.get(qid);
  const was = homeDrafts()[qid] ?? {};
  return { room: q?.room ?? was.room, roomTitle: q?.roomTitle ?? was.roomTitle ?? "", question: q?.question ?? was.question ?? "", from: q?.from ?? was.from ?? null, kind: q?.kind ?? was.kind ?? null, text };
}
const fromDraft = (id, d) => ({ id, room: d.room, roomTitle: d.roomTitle || "A room", question: d.question || "(the question isn't known)", from: d.from ?? null, kind: d.kind ?? null, at: null });

const STALE_NOTE = "This question was answered elsewhere, or its room has moved on. Nothing was sent from here. Your text is kept below: copy it, or dismiss it.";

/** One question waiting for you, with what you can do about it from here. */
function askCard(q, { stale = false } = {}) {
  const draft = homeDrafts()[q.id];
  const error = S.homeErrors.get(q.id);
  const sending = S.homePending.has(q.id);
  const off = sending ? " disabled" : "";
  const asker = q.from ? `${name(q.from)} asks` : "Your call";
  const open = `<a class="btn small quiet" href="#/r/${esc(q.room)}" data-open-question="${esc(q.id)}">${q.kind === "plan-checkpoint" ? "Open the form" : "Open the room"}</a>`;
  const write = (label) => homeBtn(label, "write", { q: q.id }, "btn small");
  let actions = "";
  let more = "";
  if (q.kind === "plan-checkpoint") {
    // The full form stays in the room. Here: every recommendation as shown, with the author the form would choose.
    const qs = q.questions ?? [];
    if (!stale) more = qs.length ? `<ul class="recs">${qs.map((x) => `<li>${esc(x.question)} <span class="muted">(${esc(name(x.from))})</span>: <b>${esc(x.recommendation || "no recommendation")}</b></li>`).join("")}</ul>` : `<p class="hint">No open questions were raised.</p>`;
    actions = q.complete && q.author ? homeBtn(`${ic("check")}Accept all recommendations: ${esc(name(q.author))} writes the plan`, "accept-checkpoint", { q: q.id }, "btn small you") : "";
    if (!q.complete && !stale) more += `<p class="hint">Some have no recommendation: answer them in the form.</p>`;
  } else if (q.kind === "plan-ready") {
    // Refused because another room is building in this folder: the choice to wait for it.
    const busy = S.homeFolder.get(q.id);
    actions = (busy ? homeBtn(`${ic("build")}Wait for “${esc(busy.title)}”, then build`, "accept-wait", { q: q.id }, "btn small you") : homeBtn(`${ic("build")}Start building with this plan`, "accept", { q: q.id }, "btn small you")) + ((q.checkers ?? []).length ? homeBtn(`Ask ${esc(q.checkers.map(name).join(" and "))} to check it`, "plan-check", { q: q.id }) : "") + write("Ask for changes");
  } else if (q.kind === "error") {
    actions = homeBtn("Retry", "accept", { q: q.id }, "btn small you") + write("Retry with a note");
  } else if (q.kind === "app-lost") {
    actions = homeBtn("Follow it again", "accept", { q: q.id }, "btn small you");
  } else {
    actions = (q.recommendation ? homeBtn(`${ic("check")}Use the recommendation`, "accept", { q: q.id }, "btn small you") : "") + write("Write my own answer");
  }
  if (sending) actions = actions.replaceAll("<button ", "<button disabled ");
  const to = q.from ? name(q.from) : "the room";
  return `<article class="ask" data-q="${esc(q.id)}" data-room="${esc(q.room)}"${stale ? ' data-stale="true"' : ""}${sending ? ' aria-busy="true"' : ""}>
    <header>${homeTile(q.room, q.roomTitle)}<div class="who"><strong>${esc(q.roomTitle)}</strong><span class="muted">${esc(asker)}</span></div><span class="wait">${stale ? "closed" : `waiting <span data-since="${esc(q.at ?? "")}">${q.at ? since(q.at) : ""}</span>`}</span></header>
    <p class="q">${esc(q.question)}</p>
    ${more}
    ${q.recommendation && !stale && !["plan-checkpoint", "plan-ready", "error", "app-lost"].includes(q.kind) ? `<div class="rec"><span class="eyebrow">Recommended</span><p>${esc(q.recommendation)}</p></div>` : ""}
    ${stale ? `<p class="stalenote" role="status">${STALE_NOTE}</p>` : ""}
    ${error && !stale ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
    <div class="actions">${stale ? "" : actions}${open}${stale ? homeBtn("Dismiss", "dismiss", { q: q.id }, "btn small quiet") : ""}</div>
    <div class="write"${draft ? "" : " hidden"}>
      <label for="hw-${esc(q.id)}">Your answer to ${esc(to)}</label>
      <textarea id="hw-${esc(q.id)}" rows="3" data-draft="${esc(q.id)}" placeholder="Write to ${esc(to)}… (Ctrl+Enter sends)"${sending ? " readonly" : ""}>${esc(draft?.text ?? "")}</textarea>
      ${stale ? "" : `<div class="actions"><button type="button" class="btn small you" data-act="send" data-q="${esc(q.id)}" data-key="send|${esc(q.id)}"${off}>${sending ? "Sending…" : "Send"}</button><button type="button" class="btn small quiet" data-act="cancel-write" data-q="${esc(q.id)}" data-key="cancel-write|${esc(q.id)}"${off}>Cancel</button></div>`}
    </div>
  </article>`;
}

/**
 * A card you're typing in, whose question has just closed: it says so, and nothing can be sent from it any more,
 * without drawing it again (your text and focus stay).
 */
function markStale(node) {
  const id = node.dataset.q;
  S.homeStale.add(id);
  if (node.dataset.stale === "true" && $(".stalenote", node)) return;
  node.dataset.stale = "true";
  const wait = $(".wait", node);
  if (wait) wait.textContent = "closed";
  $(".err", node)?.remove();
  $(".rec", node)?.remove();
  const actions = $(":scope > .actions", node);
  actions.before(el(`<p class="stalenote" role="status">${STALE_NOTE}</p>`));
  actions.innerHTML = `<a class="btn small quiet" href="#/r/${esc(node.dataset.room)}" data-open-question="${esc(id)}">Open the room</a>${homeBtn("Dismiss", "dismiss", { q: id }, "btn small quiet")}`;
  $(".write > .actions", node)?.remove();
}

/**
 * Needs you, card by card. A card you're writing in, or sending from, isn't drawn again (your text, cursor and focus
 * stay). A question that has closed while you had text for it (on this page, or kept from before a reload) stays as
 * a closed card, saying so, until you dismiss it.
 */
function patchNeeds(h) {
  const part = $('#home [data-part="needs"]');
  if (!$(".asks", part))
    part.innerHTML = `<section class="panel needs" aria-labelledby="h-needs"><header><h2 id="h-needs">Needs you</h2><span class="count" hidden></span><span class="hnote">Oldest first</span></header><div class="asks"></div><p class="hint more" hidden></p></section>`;
  const count = $(".count", part);
  count.hidden = !h.questionCount;
  count.textContent = h.questionCount;
  const moreNote = $(".more", part);
  const more = h.questionCount - h.questions.length;
  moreNote.hidden = more <= 0;
  moreNote.textContent = `And ${more} more, in their rooms.`;
  const list = $(".asks", part);
  const old = new Map([...list.querySelectorAll(":scope > .ask")].map((n) => [n.dataset.q, n]));
  const busy = (node) => node.contains(document.activeElement) || S.homePending.has(node.dataset.q);
  const drafts = homeDrafts();
  const target = [];
  const open = new Set(h.openIds ?? h.questions.map((q) => q.id));
  for (const q of h.questions) {
    S.homeCards.set(q.id, q);
    const was = old.get(q.id);
    if (was && busy(was)) {
      if (S.homeStale.has(q.id)) markStale(was);
      target.push(was);
    } else target.push(el(askCard(q, { stale: S.homeStale.has(q.id) })));
  }
  // Questions now closed that you had text for: from the cards on the page, and from the drafts kept in this browser.
  for (const id of new Set([...old.keys(), ...Object.keys(drafts)])) {
    if (open.has(id)) continue;
    const node = old.get(id);
    if (node && busy(node)) {
      markStale(node);
      target.push(node);
    } else if (drafts[id]) target.push(el(askCard(S.homeCards.get(id) ?? fromDraft(id, drafts[id]), { stale: true })));
  }
  for (const [, node] of old) if (!target.includes(node)) node.remove();
  let ref = null;
  for (let i = target.length - 1; i >= 0; i--) {
    const node = target[i];
    // A busy card already in the list stays where it is (moving it would take the focus away).
    if (!(node.parentNode === list && busy(node)) && (node.parentNode !== list || node.nextSibling !== ref)) list.insertBefore(node, ref);
    ref = node;
  }
  const empty = $(".hempty", list);
  if (!target.length && !empty) list.innerHTML = `<div class="hempty">${ic("check")}<span>Nothing needs you. A room turns orange when something does.</span></div>`;
  if (target.length && empty) empty.remove();
}

/**
 * Who an action reached and when they'll act on it, from the room as the desk returned it (its summary): for each
 * recipient, held up and why, at work already, or next.
 */
function reachedText(sum, who) {
  const blocked = sum?.blocked ?? [];
  const agents = (who?.length ? who : [...new Set([...blocked.map((b) => b.agent), ...(sum?.running ?? [])])]).filter(Boolean);
  if (sum?.paused) return `${agents.map(name).join(" and ") || "The room"} ${agents.length > 1 ? "get" : "gets"} it when you resume “${sum.title}”.`;
  return agents
    .map((a) => {
      const b = blocked.find((x) => x.agent === a);
      if (b) return `${name(a)} gets it when this ends: ${b.reasons.join("; ")}.`;
      return (sum?.running ?? []).includes(a) ? `${name(a)} is on it.` : `${name(a)} gets it next.`;
    })
    .join(" ");
}

/** Something done from Home: answers, the planning checkpoint, a ready plan's check, and the desk's controls. */
async function homeAct(btn) {
  const act = btn.dataset.act;
  const card = btn.closest(".ask");
  const qid = card?.dataset.q;
  const roomId = card?.dataset.room;
  // The card as it is now (drawing it again replaces the element).
  const current = () => (qid ? $(`#home .ask[data-q="${CSS.escape(qid)}"]`) : null);
  const redraw = ({ focus = false } = {}) => {
    const node = current();
    const q = S.homeCards.get(qid) ?? (homeDrafts()[qid] ? fromDraft(qid, homeDrafts()[qid]) : null);
    if (!q || !node) return;
    const fresh = el(askCard(q, { stale: S.homeStale.has(qid) }));
    node.replaceWith(fresh);
    if (focus) $("textarea", fresh)?.focus();
  };
  if (act === "write") {
    setHomeDraft(qid, draftFor(qid, homeDrafts()[qid]?.text ?? ""));
    const box = $(".write", current());
    box.hidden = false;
    return $("textarea", box).focus();
  }
  if (act === "cancel-write" || act === "dismiss") {
    setHomeDraft(qid, null);
    S.homeErrors.delete(qid);
    S.homeStale.delete(qid);
    if (act === "dismiss") return current()?.remove();
    $(".write", current()).hidden = true;
    $("textarea", current()).value = "";
    return;
  }
  if (act === "dismiss-result") {
    S.deskResult = null;
    return setPart("result", "");
  }
  if (act === "guard-sheet") return guardSheet();
  if (act === "folder-sheet") return folderSheet();
  if (card) {
    // One send at a time, and none from a question that has closed.
    if (S.homePending.has(qid)) return;
    if (S.homeStale.has(qid) || card.dataset.stale === "true" || (S.home?.openIds && !S.home.openIds.includes(qid))) {
      const node = current();
      if (node) markStale(node);
      return;
    }
    const node = current();
    const text = $("textarea", node)?.value ?? "";
    if (act === "send" && !text.trim()) {
      S.homeErrors.set(qid, "Write an answer first.");
      return redraw({ focus: true });
    }
    const q = S.homeCards.get(qid);
    const call =
      act === "accept-checkpoint" ? ["control", { action: "accept-checkpoint", questionId: qid }]
      : act === "plan-check" ? ["control", { action: "plan-check", questionId: qid }]
      : ["answer", act === "send" ? { text, questionId: qid } : { accept: true, questionId: qid, wait: act === "accept-wait" }];
    // While it's on its way: nothing in the card can change or be pressed (what's sent is what you see).
    S.homePending.add(qid);
    S.homeErrors.delete(qid);
    node.setAttribute("aria-busy", "true");
    for (const b of node.querySelectorAll("button")) b.disabled = true;
    const box = $("textarea", node);
    if (box) box.readOnly = true;
    const sendBtn = $("[data-act=send]", node);
    if (sendBtn) sendBtn.textContent = "Sending…";
    let sent = false;
    try {
      const sum = await api("POST", `/api/rooms/${roomId}/${call[0]}`, call[1]);
      sent = true;
      setHomeDraft(qid, null);
      // Who it reached: the author for a checkpoint, the checkers for a check, the agent asking for an answer (a
      // ready plan's Start building: whoever the build queued), and whether each is held up, from the desk's reply.
      const building = q?.kind === "plan-ready" && (act === "accept" || act === "accept-wait");
      const who = act === "accept-checkpoint" ? [q?.author] : act === "plan-check" ? q?.checkers ?? [] : building ? null : [q?.from];
      const title = act === "accept-checkpoint" ? "Your call is in: the plan is next" : act === "plan-check" ? "The check is asked for" : building ? (sum?.folder?.waitsFor ? "The build waits for its folder" : "The build starts") : "Answer sent";
      S.homeFolder.delete(qid);
      toast(title, reachedText(sum, who) || q?.roomTitle);
    } catch (error) {
      if (error.code === "folder-busy") {
        // Another room is building in this folder: the question stays open, with the choice to wait for that room.
        S.homeErrors.set(qid, error.message);
        S.homeFolder.set(qid, error.room ?? { title: "the other room" });
        return;
      }
      // Answered elsewhere meanwhile (another tab, a terminal, your phone): nothing was sent, and your text stays.
      S.homeErrors.set(qid, error.status === 409 ? `Not sent: ${error.message}` : `That didn't work: ${error.message} Your text is kept.`);
      if (error.status === 409) S.homeStale.add(qid);
      // Without text of yours, the card goes once Home catches up: say it here too.
      if (act !== "send") toast("Not sent", error.message, 9000);
    } finally {
      S.homePending.delete(qid);
      // Sent: the question is answered, so its card goes. Not sent: back in your text.
      if (sent) current()?.remove();
      else redraw({ focus: act === "send" });
      loadHome();
    }
    return;
  }
  // The desk's controls, as the terminal and MCP use them.
  const d = btn.dataset;
  const body =
    act === "desk" ? (d.do === "pause" || d.do === "resume" ? { action: d.do } : d.do === "use-folder" || d.do === "release-folder" ? { action: d.do, project: d.project } : { action: d.do, target: d.target, headless: d.headless === "true" })
    : d.do === "guard-ok" ? { action: "guard-ok" }
    : d.do === "guard-all-off" ? { action: "guard", enabled: false }
    : d.do === "rule-off" ? { action: "guard", target: d.target, rules: { [d.window]: { enabled: false } } }
    : { action: d.do, target: d.target, window: d.window };
  btn.disabled = true;
  try {
    const res = await api("POST", "/api/desk", body);
    if (d.do === "guard-all-off") await api("POST", "/api/desk", { action: "guard-ok" }).catch(() => {});
    S.deskResult = { message: res.message, offers: res.offers ?? [] };
  } catch (error) {
    S.deskResult = { message: error.message, offers: [], error: true };
  } finally {
    btn.disabled = false;
    setPart("result", homeResult());
    loadHome();
  }
}

/** The usage guard's rules for each allowance: on or off, the threshold per window, and release at reset. */
function guardSheet() {
  const policies = S.home?.desk.guard.policies ?? [];
  openSheet(`${sheetHead("Usage guard", "When to hold each allowance")}<form id="guardForm" style="display:grid;gap:16px">
    <p class="hint" style="margin:0">When an allowance's usage reaches a threshold, Toryo lets running turns finish and starts nothing new until that limit resets.</p>
    ${policies
      .map(
        (p) => `<fieldset class="field" data-group="${esc(p.group)}"><legend class="lbl">${esc(p.label ?? p.name)}</legend>
        ${p.rules.map((r) => `<label class="opt"><input type="checkbox" name="on" data-type="${esc(r.type)}" ${r.enabled ? "checked" : ""}> ${esc(r.label)} limit, at <input type="number" name="at" data-type="${esc(r.type)}" min="1" max="100" value="${r.at}" aria-label="${esc(`${p.name}'s ${r.label} threshold, in percent`)}" style="width:5em">%</label>`).join("")}
        <label class="opt"><input type="checkbox" name="auto" ${p.autoRelease ? "checked" : ""}> Let go by itself at the reset (otherwise it waits for you)</label></fieldset>`,
      )
      .join("")}
    <div style="display:flex;gap:8px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
  $("#guardForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      // Only what you changed is sent: an allowance left as it was keeps its own settings.
      const said = [];
      for (const set of $$("#guardForm fieldset")) {
        const p = policies.find((x) => x.group === set.dataset.group);
        const rules = {};
        for (const r of p.rules) {
          const on = $(`input[name=on][data-type="${CSS.escape(r.type)}"]`, set).checked;
          const at = Number($(`input[name=at][data-type="${CSS.escape(r.type)}"]`, set).value);
          if (on !== r.enabled || at !== r.at) rules[r.type] = { enabled: on, at };
        }
        const auto = $("input[name=auto]", set).checked;
        if (!Object.keys(rules).length && auto === p.autoRelease) continue;
        said.push((await api("POST", "/api/desk", { action: "guard", target: p.target, rules, autoRelease: auto === p.autoRelease ? undefined : auto })).message);
      }
      closeSheet();
      if (said.length) {
        S.deskResult = { message: said.join(" "), offers: [] };
        setPart("result", homeResult());
      }
      loadHome();
    } catch (error) {
      fail(error);
    }
  });
}

/** The rooms sharing a folder, in a few words: one or two by name, more as a count (the names on hover). */
function sharedText(shared) {
  if (!shared?.length) return "";
  const names = shared.map((x) => x.title);
  const said = names.length <= 2 ? names.join(" and ") : `${names.length} other rooms`;
  return `<span title="${esc(names.join(", "))}">shares its folder with ${esc(said)}</span>`;
}

/** What a turn is doing, in a few words: "building Slice 2, round 3", "a planning round on Export"… */
function workWhat(w) {
  if (w.agent === "toryo") return "running the project's checks";
  const kind = workKind(w.kind);
  const verb = { build: "building", review: "reviewing", plan: "planning", chat: KIND[w.kind]?.toLowerCase() ?? "replying" }[kind] ?? "working";
  if (w.mode === "build" && w.slice) return `${verb} ${w.slice}${w.round > 1 ? `, round ${w.round}` : ""}`;
  if (w.task) return `${verb}: ${w.task}`;
  return verb;
}

/** A turn's times, kept apart: preparing, waiting in the Codex app's queue, working. */
function workPhases(w) {
  const out = [];
  if (w.phase === "preparing") out.push(`preparing for <span data-since="${esc(w.startedAt)}">${since(w.startedAt)}</span>`);
  else if (w.agent !== "toryo" && Date.parse(w.submittedAt ?? w.workingAt) - Date.parse(w.startedAt) >= 1000) out.push(`prepared in ${span(w.startedAt, w.submittedAt ?? w.workingAt)}`);
  if (w.submittedAt) out.push(w.phase === "in-app" || w.phase === "sending" ? `in the Codex app's queue for <span data-since="${esc(w.submittedAt)}">${since(w.submittedAt)}</span>` : `waited ${span(w.submittedAt, w.workingAt)} in the Codex app's queue`);
  return out.join(" · ");
}

function homeWorking(h) {
  const cards = h.working.map((w) => {
    const kind = w.agent === "toryo" ? "checks" : workKind(w.kind);
    const chip = `<span class="act-k" data-k="${kind === "chat" ? "checks" : kind}">${ic(kind === "checks" ? "checks" : kind === "chat" ? "chat" : kind)}${{ build: "Building", review: "Reviewing", plan: "Planning", checks: "Checks", chat: "Replying" }[kind]}</span>`;
    const since0 = w.workingAt ?? w.startedAt;
    return `<a class="workcard" href="#/r/${esc(w.room)}" data-turn="${esc(w.turn)}">
      ${homeTile(w.room, w.title)}
      <div class="wc-main">
        <div class="wc-title"><strong>${esc(w.title)}</strong><span class="muted">${esc(w.project ?? "")}${w.folder ? ` · ${w.workspace?.kind === "worktree" ? "own worktree " : ""}<span class="mono">${esc(w.folder)}</span>` : ""}</span></div>
        <div class="wc-line">${chip}<span><b>${esc(w.agent === "toryo" ? "Toryo" : name(w.agent))}</b>${w.role && w.role !== "other" ? `, ${esc(w.role)}` : ""} · ${esc(workWhat(w))}</span>${w.questions ? `<span class="act-k" data-k="you">Needs you too</span>` : ""}</div>
        ${workPhases(w) ? `<div class="wc-phase">${workPhases(w)}</div>` : ""}
        <div class="wc-act mono" data-activity>${esc(w.activity ?? "")}</div>
        ${w.shared?.length ? `<div class="wc-shared">${sharedText(w.shared)}</div>` : ""}
        ${w.folderWaiting?.length ? `<div class="wc-shared">${ic("lock")} ${esc(waitingWords(w.folderWaiting))}</div>` : ""}
      </div>
      <div class="wc-time"><span class="big" data-since="${esc(since0)}">${since(since0)}</span><span class="muted">${w.phase === "working" || w.agent === "toryo" ? "working" : w.phase === "preparing" ? "since it started" : "since it was sent"}${w.lastOutputAt ? ` · last output <span data-ago="${esc(w.lastOutputAt)}">${ago(w.lastOutputAt)}</span>` : ""}</span></div>
    </a>`;
  });
  return `<section class="panel" aria-labelledby="h-work">
    <header><h2 id="h-work">Working now</h2>${h.working.length ? `<span class="count">${h.working.length}</span>` : ""}<span class="hnote">Time is this turn's, not the slice's</span></header>
    ${cards.length ? cards.join("") : `<div class="hempty">${ic("pause")}<span>No one is working right now.</span></div>`}
  </section>`;
}

function homeOthers(h) {
  const rows = h.rooms.map((r) => {
    const sum = S.state.rooms.find((x) => x.id === r.id);
    const state = sum ? railState(sum).text : r.status;
    return `<a class="roomrow" href="#/r/${esc(r.id)}">${homeTile(r.id, r.title)}<span class="rr-text"><strong>${esc(r.title)}</strong><span>${esc(state)}${r.project ? ` · ${esc(r.project)}` : ""}${r.workspace?.kind === "worktree" ? ` · own worktree${r.workspace.state === "failed" ? " (couldn't be made)" : r.workspace.state === "creating" ? " (being made)" : ""}` : ""}${r.shared?.length ? ` · ${sharedText(r.shared)}` : ""}</span></span><span class="rr-meta">${r.updatedAt ? `<span data-ago="${esc(r.updatedAt)}">${ago(r.updatedAt)}</span>` : ""}</span></a>`;
  });
  return `<section class="panel" aria-labelledby="h-other">
    <header><h2 id="h-other">Other rooms</h2></header>
    ${rows.length ? `<div class="rowlist">${rows.join("")}</div>` : S.state.rooms.length ? `<div class="hempty">${ic("rooms")}<span>Every room is working.</span></div>` : startRoom()}
  </section>`;
}

/** No rooms yet: what a room is, and the three ways to start one. */
function startRoom() {
  return `<div class="startroom"><p>A room is one conversation with your crew. It can switch between chatting, planning and building, and everyone keeps their memory of the room.</p>
    <div class="modecards">
      <button type="button" class="modecard" data-new="chat">${ic("chat")}<b>Chat</b><span>Ask one agent or several, and let them discuss.</span></button>
      <button type="button" class="modecard" data-new="plan">${ic("plan")}<b>Plan</b><span>Independent proposals, critiques, your call, a written plan.</span></button>
      <button type="button" class="modecard" data-new="build">${ic("build")}<b>Build</b><span>One builds, the other reviews, slice by slice.</span></button></div></div>`;
}

/** One window of an allowance: how much is used, the guard's threshold on the bar, when it resets and when it was read. */
function homeMeter(w, rule) {
  const over = w.expired || (w.resetsAt && new Date(w.resetsAt) <= Date.now());
  const used = over || w.used == null ? null : Math.round(w.used);
  const at = rule?.enabled ? rule.at : null;
  const level = used == null ? "none" : at != null && used >= at ? "bad" : used >= 70 ? "warn" : "ok";
  const resets = w.resetsAt && !over ? `resets ${whenText(w.resetsAt)} (in ${duration(new Date().toISOString(), w.resetsAt)})` : over ? "has reset; waiting for a new reading" : "reset time not known";
  const read = w.sourceAt ?? w.receivedAt;
  return `<div class="hmeter" data-level="${level}" data-window="${esc(w.type)}">
    <div class="row"><span>${esc(w.label ?? w.type)}</span><b>${used == null ? (over ? "reset" : "unknown") : `${used}%`}</b></div>
    <div class="bar" role="img" aria-label="${esc(`${w.label ?? w.type}: ${used == null ? "no current reading" : `${used}% used`}${at != null ? `; the guard holds at ${at}%` : ""}`)}"><i style="width:${used == null ? 0 : Math.min(100, Math.max(1, used))}%"></i>${at != null ? `<span class="mark" style="left:${at}%"></span>` : ""}</div>
    <div class="row sub"><span>${esc(resets)}</span><span>${read ? `read <span data-ago="${esc(read)}">${ago(read)}</span>${w.agent ? ` from ${esc(name(w.agent))}` : ""}` : ""}</span></div>
  </div>`;
}

function homeUsage(h) {
  const policies = h.desk.guard.policies;
  const groups = [...new Set([...policies.map((p) => p.group), ...Object.keys(h.usage.groups ?? {})])];
  const allow = groups
    .map((group) => {
      const p = policies.find((x) => x.group === group);
      const g = h.usage.groups?.[group];
      const agents = h.agents.filter((a) => a.group === group);
      if (!agents.length && !g) return "";
      const rules = Object.fromEntries((p?.rules ?? []).map((r) => [r.type, r]));
      const on = (p?.rules ?? []).filter((r) => r.enabled);
      const guard = on.length ? `guard at ${on.map((r) => `${r.at}% ${r.label}`).join(", ")}` : "guard off";
      const holds = h.desk.guard.holds.filter((x) => x.group === group);
      // Both Codex interfaces share one allowance: hold or release them together too.
      const family = agents.some((a) => a.agent === "codex") && agents.some((a) => a.agent === "codexapp");
      const familyHeld = h.desk.holds.some((x) => x.key === "codex");
      return `<div class="allow" data-group="${esc(group)}">
        <header><strong>${esc(p?.label ?? group)}</strong><span class="muted">${esc(guard)}</span>${family ? homeBtn(familyHeld ? "Release both" : "Hold both", "desk", { do: familyHeld ? "release" : "hold", target: "codex", headless: false }, "btn small quiet") : ""}</header>
        ${g?.windows?.length ? g.windows.map((w) => homeMeter(w, rules[w.type])).join("") : `<p class="hint">No usage reading yet.</p>`}
        ${holds.map((x) => `<p class="guardhold" data-excepted="${x.excepted}">${ic("lock")}<span>${esc(x.excepted ? `The guard is paused for the ${x.label} limit until it resets.` : `${x.reason[0].toUpperCase()}${x.reason.slice(1)}.`)}</span></p>`).join("")}
        <div class="agentrows">${agents
          .map((a) => {
            // "building in A, B and C; reviewing in D": one verb per kind of work.
            const byVerb = new Map();
            for (const w of a.working) {
              const verb = workWhat({ ...w, agent: a.agent }).split(/[: ]/)[0];
              byVerb.set(verb, [...(byVerb.get(verb) ?? []), `<a href="#/r/${esc(w.room)}">${esc(w.title)}</a>`]);
            }
            const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0]);
            const doing = byVerb.size ? [...byVerb].map(([verb, rooms]) => `${esc(verb)} in ${list(rooms)}`).join("; ") : `<span class="muted">idle</span>`;
            // Holding this agent alone: headless Codex, the Codex app, or any other agent.
            const key = a.agent === "codex" ? "codex:headless" : a.agent;
            const held = h.desk.holds.some((x) => x.key === key);
            const ctl = homeBtn(held ? "Release" : "Hold", "desk", { do: held ? "release" : "hold", target: a.agent, headless: a.agent === "codex" }, "btn small quiet");
            return `<div class="agentrow">${avatar(a.agent, 22)}<b>${esc(a.label)}</b><span>${doing}</span>${ctl}${a.blockers.length ? `<span class="muted held">held: ${esc(a.blockers.join("; "))}</span>` : ""}</div>`;
          })
          .join("")}</div>
      </div>`;
    })
    .join("");
  return `<section class="panel" aria-labelledby="h-usage">
    <header><h2 id="h-usage">Agents and usage</h2></header>
    <div class="usage">${allow}</div>
  </section>`;
}

/** One line of Recent, in words. */
function recentText(f) {
  const turnSaid = { APPROVED: "approved", CHANGES: "asked for changes", REVIEW: "handed over for review", OWNER: "asked you something", DONE: "says it's done", REPLY: "replied", PROPOSAL: "proposed a plan", CRITIQUE: "critiqued the proposals", AGREE: "agreed", DISAGREE: "disagreed" };
  switch (f.kind) {
    case "turn":
      return f.state === "failed"
        ? `<b>${esc(name(f.agent))}</b>'s ${esc((KIND[f.turnKind] ?? "turn").toLowerCase())} failed${f.error ? `: ${esc(f.error)}` : ""}`
        : `<b>${esc(name(f.agent))}</b> ${esc(turnSaid[f.status] ?? `finished: ${(KIND[f.turnKind] ?? "a turn").toLowerCase()}`)}${f.detail ? `: ${esc(f.detail)}` : ""}`;
    case "question":
      return `<b>${esc(f.from ? name(f.from) : "Toryo")}</b> asked: ${esc(f.question)}${f.open ? "" : ` <span class="muted">(answered)</span>`}`;
    case "answer":
      return f.change ? `<b>You</b> sent a change request` : `<b>You</b> answered${f.answered ? ` “${esc(f.answered)}”` : ""}: ${esc(f.text)}`;
    case "checks":
      return `Checks failed: ${esc(f.failed.join(", "))}`;
    default:
      return esc(f.text ?? "");
  }
}

function homeRecent(h) {
  const icon = (f) => (f.kind === "turn" ? (f.state === "failed" ? "x" : f.status === "APPROVED" ? "check" : { build: "build", review: "review", plan: "plan" }[workKind(f.turnKind)] ?? "chat") : { question: "hand", answer: "chat", checks: "checks", approved: "check", desk: "lock" }[f.kind] ?? "dots");
  const items = h.recent.items.map(
    (f) => `<li data-k="${esc(f.kind)}"><span class="fi" aria-hidden="true">${ic(icon(f))}</span><span class="ft">${recentText(f)}${f.room ? `<br><a href="#/r/${esc(f.room)}">${esc(f.roomTitle)}</a>` : ""}</span><time datetime="${esc(f.at)}" data-ago="${esc(f.at)}">${ago(f.at)}</time></li>`,
  );
  return `<section class="panel" aria-labelledby="h-recent">
    <header><h2 id="h-recent">Recent</h2></header>
    ${items.length ? `<ul class="recent">${items.join("")}</ul>` : `<div class="hempty">${ic("clock")}<span>Nothing yet.</span></div>`}
    ${h.recent.next && S.recent < 100 ? `<div><button type="button" class="btn small quiet" data-more-recent>Show older</button></div>` : ""}
  </section>`;
}

// ------------------------------------------------------------------ empty states

function renderWelcome() {
  $("#composer").hidden = true;
  $("#log").innerHTML = `<div class="empty"><p class="eyebrow">Welcome</p><h2>Point Toryo at a project</h2>
    <p>Toryo runs Codex, Claude and other coding agents in your repository, passes their messages to each other, and only stops for you when a decision is yours.</p>
    <form id="welcomeForm" class="field"><label for="wPath">Project folder (absolute path)</label><input type="text" id="wPath" placeholder="/home/you/project">
    <div><button class="btn primary" type="submit">Add project</button></div></form></div>`;
  $("#welcomeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/api/projects", { path: $("#wPath").value.trim() });
    } catch (error) {
      fail(error);
    }
  });
  $("#crewPane").innerHTML = agentsOverview();
  setSideTab("crew");
}

// ------------------------------------------------------------------ wiring

/**
 * The side panel's tab: Plan, Crew or Ledger. A panel chosen as the room's tab on a narrower screen follows too,
 * so after widening the window the panel shown is always the one you chose last.
 */
function setSideTab(tab) {
  S.sideTab = tab;
  if (S.roomTab !== "relay") S.roomTab = tab;
  applyTabs();
}
/** The room's tab on narrower screens: the relay, or one of the side panels in its place. */
function setRoomTab(tab) {
  S.roomTab = tab;
  if (tab !== "relay") S.sideTab = tab;
  applyTabs();
}
/** On a phone: the rooms list, or the room. */
function setPane(pane) {
  S.pane = pane;
  applyTabs();
}
function applyTabs() {
  $("#main").dataset.tab = S.roomTab;
  $("#side").dataset.panel = S.roomTab !== "relay" ? S.roomTab : S.sideTab;
  $("#app").dataset.view = S.pane;
  for (const b of $$("[data-sidetab]")) b.setAttribute("aria-selected", String(b.dataset.sidetab === S.sideTab));
  for (const b of $$("[data-roomtab]")) b.setAttribute("aria-selected", String(b.dataset.roomtab === S.roomTab));
  for (const b of $$("#tabbar [data-view]")) b.toggleAttribute("aria-current", b.dataset.view === S.pane), b.dataset.view === S.pane && b.setAttribute("aria-current", "page");
}

/** Light, dark, or as the system says: your choice, kept in this browser. */
function applyTheme() {
  const theme = localStorage.getItem("toryo.theme") ?? "system";
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("#themeBtn").innerHTML = ic(theme === "dark" ? "moon" : theme === "light" ? "sun" : "system");
  $("#themeBtn").title = `Theme: ${theme === "system" ? "as the system" : theme}. Click to change.`;
  $("#themeBtn").setAttribute("aria-label", $("#themeBtn").title);
  rethemeSparklers();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rethemeSparklers);

document.addEventListener("click", async (e) => {
  const t = e.target;
  const r = room();
  const hit = (sel) => t.closest(sel);
  try {
    if (hit("[data-close]") || t.id === "sheet") return closeSheet();
    if (hit("[data-copy-path]")) {
      const btn = hit("[data-copy-path]");
      return navigator.clipboard.writeText(btn.dataset.copyPath).then(
        () => (btn.textContent = "Copied"),
        () => fail(new Error("The browser refused clipboard access.")),
      );
    }
    if (hit(".roomlink[data-room]")) {
      // A step in the browser's history, so Back returns to where you were (Home, or another room).
      const id = hit(".roomlink[data-room]").dataset.room;
      if (location.hash !== `#/r/${id}`) history.pushState(null, "", `#/r/${id}`);
      return loadRoom(id, { open: true });
    }
    if (hit("#home button[data-act]")) return homeAct(hit("#home button[data-act]"));
    // The folders sheet's buttons: the desk's own control, then the sheet closes and Home says what the desk said.
    if (hit("#sheet .folderlist button[data-act]")) {
      const btn = hit("#sheet .folderlist button[data-act]");
      return homeAct(btn).finally(() => closeSheet());
    }
    if (hit("[data-session-list]")) return sessionSheet();
    if (hit("[data-show-session]")) {
      // The strip shows an earlier session, or the current one again.
      const k = hit("[data-show-session]").dataset.showSession;
      S.shownSession = k === "now" ? null : Number(k);
      if (!$("#sheet").hidden) closeSheet();
      renderSession();
      $("#sessionStrip .ss-words")?.focus();
      return;
    }
    if (hit("[data-new-session]")) return newSessionSheet();
    if (hit("[data-seg]")) {
      // A piece of the session: its turn (or checks) in the room's timeline.
      e.preventDefault();
      const id = hit("[data-seg]").dataset.seg;
      if (!$("#sheet").hidden) closeSheet();
      if (!S.view?.events.some((x) => x.id === id)) return;
      setRoomTab("relay");
      S.focusOn = id;
      return renderTimeline();
    }
    if (hit("[data-open-question]")) {
      // From Home: the room, at that question.
      S.focusOn = hit("[data-open-question]").dataset.openQuestion;
      setRoomTab("relay");
      return;
    }
    if (hit("[data-more-recent]")) {
      S.recent = Math.min(100, S.recent + 30);
      return loadHome();
    }
    if (hit("[data-sidetab]")) return setSideTab(hit("[data-sidetab]").dataset.sidetab);
    if (hit("[data-roomtab]")) return setRoomTab(hit("[data-roomtab]").dataset.roomtab);
    if (hit("#tabbar [data-view]")) {
      // On a phone: Home and the room are pages (with an address); the rooms list is the rail.
      const view = hit("#tabbar [data-view]").dataset.view;
      if (view === "home") return S.page === "home" ? setPane("home") : (location.hash = "#/");
      if (view === "room" && S.roomId && S.page !== "room") return (location.hash = `#/r/${S.roomId}`);
      return setPane(view === "room" && !S.roomId ? "rooms" : view);
    }
    if (hit("[data-next-ask]")) {
      // The oldest question waiting for you, in any room: open its room and show it.
      const asks = (S.state?.rooms ?? []).flatMap((x) => (x.questions ?? []).map((q) => ({ room: x.id, id: q.id, at: q.at ?? "" })));
      const next = asks.sort((a, b) => a.at.localeCompare(b.at))[0];
      if (!next) return;
      setPane("room");
      setRoomTab("relay");
      S.focusOn = next.id;
      if (next.room === S.roomId && S.page === "room") renderTimeline();
      else {
        if (location.hash !== `#/r/${next.room}`) history.pushState(null, "", `#/r/${next.room}`);
        await loadRoom(next.room, { open: true });
      }
      return;
    }
    if (hit("[data-new]")) return newRoomSheet(hit("[data-new]").dataset.new);
    if (hit("a.file, button[data-file]")) {
      e.preventDefault();
      const a = hit("a.file, button[data-file]");
      if (a.dataset.file) return fileSheet(a.dataset.file, a.dataset.line);
      return;
    }
    if (hit("[data-intent]")) {
      S.intent = hit("[data-intent]").dataset.intent;
      return renderIntent();
    }
    if (hit("[data-route]")) {
      setRoute(hit("[data-route]").dataset.route);
      for (const b of $$("#recipients button")) b.setAttribute("aria-pressed", String(b.dataset.route === S.route));
      return renderRouteInfo();
    }
    if (hit("[data-expand]")) {
      const id = hit("[data-expand]").dataset.expand;
      S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
      const ev = S.view.events.find((x) => x.id === id);
      return $(`[data-id="${CSS.escape(id)}"]`).replaceWith(turnEl(ev));
    }
    if (hit("[data-diff]")) return diffSheet(hit("[data-diff]").dataset.diff);
    if (hit("[data-diff-file]")) return diffSheet($("#sheetBody").dataset.turn, hit("[data-diff-file]").dataset.diffFile || undefined);
    if (hit("[data-prompt]")) return promptSheet(hit("[data-prompt]").dataset.prompt);
    if (hit("[data-room-settings]")) return roomSheet();
    if (hit("[data-jump]")) {
      const target = $(`[data-id="${CSS.escape(hit("[data-jump]").dataset.jump)}"]`);
      // In a folded round or an earlier session: open it first.
      openFoldsAround(target);
      target?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      if (matchMedia("(max-width: 1180px)").matches) setRoomTab("relay");
      return;
    }
    if (hit("[data-dismiss]")) {
      hit(".away")?.remove();
      return;
    }
    if (hit("[data-accept]")) return api("POST", `/api/rooms/${r.id}/answer`, { accept: true, questionId: hit("[data-accept]").closest("[data-id]")?.dataset.id }).catch(fail);
    if (hit("[data-chat-accept]")) return api("POST", `/api/rooms/${r.id}/answer`, { accept: true, questionId: hit("[data-chat-accept]").closest("[data-id]")?.dataset.id }).catch(fail);
    if (hit("[data-accept-checkpoint]")) {
      const form = hit("[data-accept-checkpoint]").closest("form");
      return api("POST", `/api/rooms/${r.id}/control`, { action: "accept-checkpoint", questionId: form.dataset.id, synthesizer: $("#cqWho", form).value, planPath: $("#cqPath", form).value }).catch(fail);
    }
    if (hit("[data-answer-focus]")) {
      const who = hit("[data-answer-focus]").dataset.answerFocus;
      setRoute(who && isMember(who) ? who : "auto");
      const card = hit("[data-answer-focus]").closest("[data-id]")?.dataset.id;
      if (who && isMember(who) && card) bindAnswer(r, { id: card, from: who });
      renderComposer();
      return $("#msg").focus();
    }
    if (hit("[data-focus-everyone]")) {
      setRoute("everyone");
      renderComposer();
      return $("#msg").focus();
    }
    if (hit("[data-note-now]")) {
      setRoute(hit("[data-note-now]").dataset.noteNow);
      $("#delivery").value = "now";
      renderComposer();
      return $("#msg").focus();
    }
    if (hit("[data-start-build]")) return startBuildSheet(hit("[data-start-build]").dataset.startBuild);
    if (hit("[data-plan-check]") || hit("[data-forward]")) {
      // Both name the Ready card they came from, and a second click waits for the first: an older card is refused.
      const b = hit("[data-plan-check]") ?? hit("[data-forward]");
      const body = b.dataset.forward ? { action: "forward-discussion", questionId: b.dataset.forward, agent: b.dataset.agent } : { action: "plan-check", questionId: b.closest("[data-id]")?.dataset.id };
      b.disabled = true;
      return api("POST", `/api/rooms/${r.id}/control`, body).catch((error) => {
        b.disabled = false;
        fail(error);
      });
    }
    if (hit("[data-action=swap]")) return api("POST", `/api/rooms/${r.id}/control`, { action: "swap" }).catch(fail);
    if (hit("[data-fresh]")) return api("POST", `/api/rooms/${r.id}/control`, { action: "fresh", agent: hit("[data-fresh]").dataset.fresh }).catch(fail);
    if (hit("[data-note-edit]")) return editNote(hit("[data-note-edit]").closest("[data-id]"));
    if (hit("[data-unsaved-dismiss]") || hit("[data-unsaved-reuse]")) {
      const id = hit("[data-unsaved]").dataset.unsaved;
      const lost = noteChanges(r.id)[id];
      setNoteChange(r.id, id, null);
      hit("[data-unsaved]").remove();
      if (hit("[data-unsaved-reuse]") && lost) {
        // Into the composer, to the same agents, as a note of its own (it answers nothing).
        const box = $("#msg");
        box.value = box.value.trim() ? `${box.value.trimEnd()}\n\n${lost.text}` : lost.text;
        setRoute(lost.to.length === 1 && isMember(lost.to[0]) ? lost.to[0] : lost.to.length > 1 ? "everyone" : "auto");
        keepAnswer(r.id, { roomId: r.id, asker: null, byAgent: {}, chosen: false, route: S.route });
        box.dispatchEvent(new Event("input"));
        renderComposer();
        box.focus();
      }
      return;
    }
    if (hit("[data-note-cancel]")) {
      const id = hit("[data-note-cancel]").closest("[data-id]").dataset.id;
      return api("DELETE", `/api/rooms/${r.id}/notes/${id}`).then(() => refreshRoomSoon()).catch(fail);
    }
    if (hit("[data-change-thread]")) return appThreadSheet(false);
    if (hit("[data-app-release]")) return api("POST", `/api/rooms/${r.id}/control`, { action: "app-release" }).catch(fail);
    if (hit("[data-remove-agent]")) {
      const a = hit("[data-remove-agent]").dataset.removeAgent;
      return api("POST", `/api/rooms/${r.id}/control`, { action: "members", members: r.crew.members.filter((m) => m !== a) })
        .then(() => toast(`${name(a)} left the room`, "Add it again under More agents; it keeps its session here."), fail);
    }
    if (hit("[data-add-agent]")) {
      const a = hit("[data-add-agent]").dataset.addAgent;
      if (a === "codexapp") return appThreadSheet(true);
      return api("POST", `/api/rooms/${r.id}/control`, { action: "members", members: [...r.crew.members, a] }).catch(fail);
    }
    if (hit("[data-copy-turn]")) {
      const ev = S.view.events.find((x) => x.id === hit("[data-copy-turn]").dataset.copyTurn);
      await navigator.clipboard.writeText(ev?.text ?? "").then(
        () => toast("Copied", `${name(ev?.agent)}'s whole message`),
        () => fail(new Error("The browser refused clipboard access.")),
      );
      return;
    }
    if (hit("[data-copy]")) {
      const text = hit("[data-copy]").dataset.copy;
      await navigator.clipboard.writeText(text).then(
        () => toast("Copied", text),
        () => toast("Copy this", text, 12000),
      );
      return;
    }
    if (hit("#modes button")) {
      const mode = hit("#modes button").dataset.mode;
      if (mode === r.mode) return;
      if (mode === "plan") return startPlanSheet();
      if (mode === "build") return startBuildSheet();
      return api("POST", `/api/rooms/${r.id}/control`, { action: "chat-mode" }).catch(fail);
    }
  } catch (error) {
    fail(error);
  }
});

document.addEventListener("change", (e) => {
  const pick = e.target.closest("[data-role-agent]");
  if (pick) {
    const r = room();
    try {
      const roles = rolesFor(r, pick.dataset.roleAgent, pick.value);
      api("POST", `/api/rooms/${r.id}/control`, { action: "roles", ...roles }).then(() => refreshRoomSoon(), (error) => (fail(error), renderCrew()));
    } catch (error) {
      fail(error);
      renderCrew();
    }
    return;
  }
  const sel = e.target.closest("[data-opinion]");
  if (sel && sel.value) {
    const agent = sel.value;
    sel.value = "";
    api("POST", `/api/rooms/${room().id}/control`, { action: "opinion", eventId: sel.dataset.opinion, agent }).catch(fail);
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.matches("[data-checkpoint]")) {
    e.preventDefault();
    const answers = $$("input[data-q]", form)
      .map((i) => `- ${i.dataset.q} → ${i.value.trim() || "(no answer: use your judgement)"}`)
      .join("\n");
    const extra = $("#cqExtra", form).value.trim();
    const decisions = [answers, extra].filter(Boolean).join("\n\n");
    await api("POST", `/api/rooms/${room().id}/control`, { action: "synthesize", questionId: form.dataset.id, synthesizer: $("#cqWho", form).value, planPath: $("#cqPath", form).value, decisions }).catch(fail);
  }
});

$("#composer").addEventListener("submit", send);
// Enter sends; Shift+Enter starts a new line. Not while an input method is still composing a character.
$("#msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    send();
  }
});
$("#msg").addEventListener("input", () => {
  const r = room();
  if (r) revise(r.id);
  if (r && !$("#msg").value.trim()) bound(r) && !bound(r).chosen && keepAnswer(r.id, null);
  else if (r && !bound(r)) bindAnswer(r);
  renderRouteInfo();
  renderIntent();
  try {
    if (S.roomId) localStorage.setItem(`toryo.draft.${S.roomId}`, $("#msg").value);
  } catch {
    /* ignore */
  }
});
$("#delivery").addEventListener("change", renderRouteInfo);
$("#allowWrite").addEventListener("change", renderRouteInfo);
$("#newRoomBtn").addEventListener("click", () => (S.state?.config.projects.length ? newRoomSheet() : renderWelcome()));
$("#settingsBtn").addEventListener("click", () => S.state && settingsSheet());
$("#roomTitle").addEventListener("click", () => room() && roomSheet());
$("#roomBtn").addEventListener("click", () => room() && roomSheet());
$("#pauseBtn").addEventListener("click", () => {
  const r = room();
  const action = ["paused", "stopped", "pausing", "stopping"].includes(r.status) ? "resume" : "pause";
  api("POST", `/api/rooms/${r.id}/control`, { action }).catch(fail);
});
$("#stopBtn").addEventListener("click", () => {
  const b = $("#stopBtn");
  const label = (text) => (b.innerHTML = `${ic("stop")}<span class="lbl">${text}</span>`);
  if (b.dataset.armed) {
    delete b.dataset.armed;
    label("Stop");
    return api("POST", `/api/rooms/${room().id}/control`, { action: "stop" }).catch(fail);
  }
  b.dataset.armed = "1";
  label("Stop everything?");
  setTimeout(() => {
    delete b.dataset.armed;
    label("Stop");
  }, 4000);
});
$("#bellBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("Not available", "This browser has no notifications.");
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "Browser notifications on" : "Browser notifications off", p === "granted" ? "You'll be told when someone needs you while this tab is in the background." : "Allow them in the browser's site settings.");
});
$("#themeBtn").addEventListener("click", () => {
  const order = ["system", "light", "dark"];
  const now = localStorage.getItem("toryo.theme") ?? "system";
  localStorage.setItem("toryo.theme", order[(order.indexOf(now) + 1) % order.length]);
  applyTheme();
});
// A folded round you open stays open when the timeline is drawn again.
document.addEventListener("toggle", (e) => {
  const key = e.target.dataset?.fold;
  if (key) e.target.open ? S.openFolds.add(key) : S.openFolds.delete(key);
}, true);
// Icons and labels that never change.
for (const b of $$("#modes button")) {
  b.innerHTML = `${ic(b.dataset.mode)}<span class="lbl">${b.dataset.mode[0].toUpperCase() + b.dataset.mode.slice(1)}</span>`;
  b.setAttribute("aria-label", b.dataset.mode[0].toUpperCase() + b.dataset.mode.slice(1));
}
$("#stopBtn").setAttribute("aria-label", "Stop");
$("#roomBtn").setAttribute("aria-label", "Room settings, rename or delete");
$("#bellBtn").innerHTML = ic("bell");
$("#bellBtn").setAttribute("aria-label", "Browser notifications");
$("#settingsBtn").innerHTML = ic("sliders");
$("#roomBtn").innerHTML = `${ic("dots")}<span class="lbl">Room</span>`;
$("#newRoomBtn").innerHTML = `${ic("plus")}New room`;
$("#tabbar [data-view=home]").innerHTML = `${ic("home")}<span>Home</span>`;
$("#tabbar [data-view=rooms]").innerHTML = `${ic("rooms")}<span>Rooms</span>`;
$("#tabbar [data-view=room]").innerHTML = `${ic("chat")}<span>Room</span>`;
applyTheme();
applyTabs();
// A sparkler that appears anywhere (a room's tile, a working agent's monogram) wakes the loop that draws them.
new MutationObserver(() => wakeSparklers()).observe(document.body, { childList: true, subtree: true });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
});
document.addEventListener("visibilitychange", () => !document.hidden && markSeenSoon());
$("#log").addEventListener("scroll", markSeenSoon, { passive: true });
// An answer written on Home is kept as you type it; Ctrl+Enter (or Cmd+Enter) sends it.
$("#home").addEventListener("input", (e) => {
  const qid = e.target.dataset?.draft;
  if (qid && !e.target.readOnly) setHomeDraft(qid, draftFor(qid, e.target.value));
});
$("#home").addEventListener("keydown", (e) => {
  if (e.target.dataset?.draft && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    const send = $("[data-act=send]", e.target.closest(".ask"));
    if (send) homeAct(send);
  }
});

// Links to rooms and Home, Back and Forward: the address decides.
window.addEventListener("hashchange", () => S.state && route());

setInterval(() => {
  for (const t of $$("[data-since]")) t.textContent = since(t.dataset.since);
  for (const t of $$("[data-ago]")) t.textContent = ago(t.dataset.ago);
}, 1000);

// The session's strip, between news: every ten seconds while something runs (its words count seconds at first), else
// once a minute.
let sessionTicks = 0;
setInterval(() => {
  sessionTicks += 1;
  if (S.session?.segments.some((s) => s.running) || sessionTicks % 6 === 0) renderSession();
}, 10_000);

// Usage meters change with time alone: a limit resets, a reading ages. Redraw them without waiting for news.
setInterval(() => {
  for (const box of $$(".limits[data-agent]")) {
    const html = limitMeters(S.state?.limits?.[box.dataset.agent], box.dataset.agent);
    if (html) box.outerHTML = html;
  }
  // Home's, per allowance: only that panel, so nothing else on Home moves.
  const usage = $("#home #h-usage")?.closest("section");
  if (usage && S.home) usage.outerHTML = homeUsage(S.home);
}, 30_000);


connect();
