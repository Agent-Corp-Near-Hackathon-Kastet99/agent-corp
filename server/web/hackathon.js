// Shared client for the hackathon demo flow. One backend model; pages only render it.
import { near, esc } from './chain.js';
export { esc };
export const fmtNear = (yocto, d = 4) => yocto == null ? '—' : `${near(yocto, d)} NEAR`;
export const num = n => Number(n).toLocaleString('en-US');
export const pct = bps => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
export async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}
export const getState = () => api('/api/hackathon/state');
/** Polls without page refresh; stops overlapping requests. */
export function watch(cb, ms = 1500) {
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { cb(await getState(), null); } catch (e) { cb(null, e); } finally { busy = false; } };
  tick(); return setInterval(tick, ms);
}
export async function connectWallet() { const w = await import('/wallet.js'); await w.connectPlayer(); }
export async function disconnectWallet() { const w = await import('/wallet.js'); await w.disconnectPlayer(); }

let audio;
export function beep() {
  if (localStorage.getItem('ac_sound') === 'off') return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; g.gain.value = .05;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + .12);
  } catch { /* sound is optional */ }
}
/** Shows notices the user has not seen yet. Seen ids live per browser; the first load after reset replays nothing old. */
export function toastNew(state) {
  const box = document.querySelector('#toasts'); if (!box || !state) return;
  const key = 'ac_notice_seen', seen = Number(localStorage.getItem(key) ?? -1);
  const fresh = state.notices.filter(n => n.id > seen);
  if (!fresh.length) { if (state.notices.length === 0) localStorage.setItem(key, '-1'); return; }
  localStorage.setItem(key, String(Math.max(...fresh.map(n => n.id))));
  fresh.forEach((n, i) => setTimeout(() => {
    const isBudgetNotice = n.title === 'Budget appeared. New task started';
    const el = document.createElement(isBudgetNotice ? 'button' : 'div'); el.className = `toast${isBudgetNotice ? ' toast-action' : ''}`;
    el.setAttribute('role', 'status');
    if (isBudgetNotice) {
      el.type = 'button';
      el.setAttribute('aria-label', 'Open new marketing task in Operations');
      el.innerHTML = `${esc(n.title)}<small>${esc(n.body)} · Open Operations ↗</small>`;
      el.addEventListener('click', () => window.dispatchEvent(new CustomEvent('hackathon:open-task', { detail: { taskId: 'marketing-launch-post' } })));
    } else el.innerHTML = `${esc(n.title)}<small>${esc(n.body)}</small>`;
    box.append(el); beep();
    setTimeout(() => el.remove(), 6000);
  }, i * 700));
}
