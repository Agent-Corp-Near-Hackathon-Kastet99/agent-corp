import { api, getState, connectWallet, disconnectWallet } from './hackathon.js';
const $ = s => document.querySelector(s), modal = $('#modal');
let account;
async function refresh() {
  let s; try { s = await getState(); } catch (e) { $('#wallet-status').textContent = e.message; $('#wallet-status').classList.add('err'); return; }
  account = s.me?.account;
  $('#wallet-btn').hidden = !!account; $('#wallet-out').hidden = !account; $('#to-dash').hidden = !account;
  $('#wallet-status').textContent = account ? `Connected: ${account}` : 'No wallet connected.';
  const hw = $('#hdr-wallet'); hw.textContent = account ? (account.length > 18 ? account.slice(0, 8) + '…' + account.slice(-8) : account) : 'Connect Wallet'; hw.title = account ? 'Click to disconnect' : '';
  $('#flow li[data-s]').classList.toggle('on', !!account);
}
const open = () => { modal.hidden = false; refresh(); };
$('#invest').onclick = open; $('#invest-hero').onclick = open;
$('#m-close').onclick = () => { modal.hidden = true; };
modal.onclick = e => { if (e.target === modal) modal.hidden = true; };
addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });
$('#wallet-btn').onclick = async e => {
  e.currentTarget.disabled = true; $('#wallet-status').textContent = 'Open your wallet and approve the login message…';
  try { await connectWallet(); await refresh(); } catch (err) { $('#wallet-status').textContent = err.message; $('#wallet-status').classList.add('err'); } finally { e.currentTarget.disabled = false; }
};
$('#hdr-wallet').onclick = async e => {
  const b = e.currentTarget; b.disabled = true;
  try { if (account) await disconnectWallet(); else await connectWallet(); } catch (err) { alert(err.message); } finally { b.disabled = false; await refresh(); }
};
$('#wallet-out').onclick = async () => { try { await disconnectWallet(); } finally { await refresh(); } };
// Play Game: start the shared demo session, then load the existing game inside the page.
$('#play').onclick = async e => {
  const out = $('#play-status'), btn = e.currentTarget; btn.disabled = true; out.textContent = 'Starting game…';
  try {
    await api('/api/demo/session', {});
    const frame = $('#game'); frame.src = '/game';
    frame.onload = () => { $('#cover').hidden = true; frame.focus(); };
  } catch (err) { out.textContent = err.message; btn.disabled = false; }
};
// Full Screen: fullscreen the stage (iframe + button). Esc exits; button toggles and label follows state.
{
  const stage = $('#stage'), fs = $('#fs');
  const cur = () => document.fullscreenElement ?? document.webkitFullscreenElement;
  const exit = () => (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  const sync = () => { const on = cur() === stage; fs.textContent = on ? '✕ Exit Full Screen' : '⛶ Full Screen'; fs.setAttribute('aria-label', on ? 'Exit Full Screen' : 'Full Screen'); if (!on) $('#game').focus(); };
  fs.onclick = () => { if (cur()) exit(); else (stage.requestFullscreen ?? stage.webkitRequestFullscreen).call(stage); };
  document.addEventListener('fullscreenchange', sync); document.addEventListener('webkitfullscreenchange', sync);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && cur()) exit(); });
}
refresh();
