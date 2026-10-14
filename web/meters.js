// The plan-usage meters on the crew cards and in the Agents panel. Kept apart from app.js so the tests
// can render them at any moment: what a meter says changes with time alone (a limit resets, a reading
// ages), and the page redraws them every half minute, even when nothing new has arrived.

import { esc } from "./md.js";

/** How long ago, in words. */
export function ago(iso, now = Date.now()) {
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min)) return "";
  if (min < 2) return "just now";
  if (min < 90) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

function resets(iso, now) {
  if (!iso) return "";
  const ms = new Date(iso) - now;
  if (ms <= 0) return "resetting";
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `resets in ${Math.round(h / 24)} d` : h >= 1 ? `resets in ${h} h` : `resets in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

/**
 * When this window's reading was taken. Each window has its own: a fresh 5-hour reading doesn't make an
 * hours-old weekly one current. A reading kept from before 13 Oct 2026 has no time of its own, only when
 * Toryo got it, so it was taken then or earlier.
 */
function taken(w, now) {
  if (w.sourceAt) return { text: ago(w.sourceAt, now), title: `Reading taken ${new Date(w.sourceAt).toLocaleString()}` };
  if (w.receivedAt) return { text: `${ago(w.receivedAt, now)} or earlier`, title: "When this reading was taken isn't known; Toryo had it by then" };
  return { text: "time unknown", title: "When this reading was taken isn't known" };
}

/**
 * The meters for one agent's usage (`state.limits[agent]`), or "" when there's nothing to show. A window that
 * has reset since its reading shows no percentage (the old one would look current), nor does one whose
 * percentage the agent didn't report (that isn't 0%).
 */
export function limitMeters(l, agent, now = Date.now()) {
  const windows = l?.windows ?? [];
  if (!windows.length && !l?.error) return "";
  const meter = (w) => {
    const over = w.expired || (w.resetsAt && new Date(w.resetsAt) <= now);
    const age = taken(w, now);
    const ageCell = `<span class="age" title="${esc(age.title)}">${esc(age.text)}</span>`;
    if (over || w.used == null)
      return `<div class="meter" data-level="none" data-window="${esc(w.type ?? w.label)}"><div class="row"><span>${esc(w.label)} limit</span><b>${over ? "reset" : "unknown"}</b></div><div class="bar"><i style="width:0"></i></div><div class="row"><span>${over ? "waiting for a new reading" : resets(w.resetsAt, now)}</span>${ageCell}</div></div>`;
    return `<div class="meter" data-level="${w.used >= 90 ? "bad" : w.used >= 70 ? "warn" : "ok"}" data-window="${esc(w.type ?? w.label)}"><div class="row"><span>${esc(w.label)} limit</span><b>${Math.round(w.used)}%</b></div><div class="bar"><i style="width:${Math.min(100, Math.max(1, w.used))}%"></i></div><div class="row"><span>${resets(w.resetsAt, now)}</span>${ageCell}</div></div>`;
  };
  const error = l?.error ? `<div class="row asof" data-usage-error><span>Couldn't read the latest usage ${esc(ago(l.error.at, now))}: ${esc(l.error.error)}</span></div>` : "";
  // With no agent (an allowance's meters, on Home), the box isn't one the page redraws per agent.
  return `<div class="limits"${agent == null ? "" : ` data-agent="${esc(agent)}"`} title="Plan usage as the agent last reported it">${windows.map(meter).join("")}${error}</div>`;
}
