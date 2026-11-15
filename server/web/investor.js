import { api, esc, fmtNear, num, pct, watch, toastNew, connectWallet } from './hackathon.js';
const castVote = async (id, opt) => { const w = await import('/wallet.js'); return w.voteProposal(account, id, opt); };
const $ = s => document.querySelector(s);
let S, account, busy = false;
const DEPTS = [['marketing', 'Marketing & Growth'], ['product', 'Product Development'], ['self-improvement', 'Self-Improvement'], ['research-ops', 'Research / Operations']];
const COLS = [['todo', 'To Do'], ['in-progress', 'In Progress'], ['done', 'Done']];
const when = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const tokens = n => n == null ? 'Not metered' : `${num(n)} tokens`;
const bar = (name, v, label) => `<div class="bar"><span>${esc(name)}</span><i><b style="width:${Math.min(100, v)}%"></b></i><span>${label}</span></div>`;
const badge = (k, t) => `<span class="tag ${k}">${t}</span>`;

function openOperationsTask(taskId) {
  document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === 'operations')));
  document.querySelectorAll('[data-panel]').forEach(x => { x.hidden = x.dataset.panel !== 'operations'; });
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-task="${taskId}"]`);
    if (!card) return;
    card.classList.remove('task-focus');
    void card.offsetWidth;
    card.classList.add('task-focus');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.focus({ preventScroll: true });
  });
}

function render() {
  const s = S, inv = s.investor, t = s.tokens;
  $('#metrics').innerHTML = [
    ['Company Balance', fmtNear(s.company.balanceYocto, 4), s.company.balanceSource === 'testnet-rpc' ? badge('real', 'testnet') : '', esc(s.company.account)],
    ['Total AI Tokens Used', num(t.totalUsed), '', `${num(t.baselineMock)} baseline`],
    ['Available AI Budget', num(t.availableBudget), '', t.connected ? `${num(t.grant)} granted` : 'Connect wallet'],
    ['My AI Contribution', `${num(inv.contributionTokens)}`, '', 'tokens from completed jobs'],
    ['My Revenue Share', pct(inv.shareBps), '', 'contribution ÷ total tokens used'],
    ['Available to Withdraw', fmtNear(inv.availableYocto, 6), '', `of ${fmtNear(s.company.verifiedPaymentsYocto, 4)} verified revenue`],
  ].map(([a, b, c, d]) => `<div class="metric"><small><span>${a}</span>${c}</small><strong>${b}</strong><em>${d}</em></div>`).join('');

  $('#wallet-btn').hidden = !!account; $('#connect-ai').hidden = !account || t.connected;
  $('#wallet-off').hidden = !account;
  $('#wallet-line').textContent = account ? `Wallet: ${account}` : 'Connect your NEAR wallet to contribute.';
  const investorName = i => i.you ? `You · ${inv.account ?? 'connect NEAR wallet'}` : i.name;
  const investors = s.distribution.investors;
  let angle = 0;
  const slices = investors.map((i, index) => { const next = angle + i.bps / 100; const color = ['#fe3e01', '#ff9d7a', '#6f5b51'][index] ?? '#9a9a9a'; const slice = `${color} ${angle}% ${next}%`; angle = next; return slice; });
  $('#investors').innerHTML = `<div class="pie-layout"><div class="pie" style="background:conic-gradient(${slices.join(',')})" aria-label="Investor distribution"></div><div class="pie-legend">${investors.map((i, index) => `<div><i style="background:${['#fe3e01', '#ff9d7a', '#6f5b51'][index] ?? '#9a9a9a'}"></i><span>${esc(investorName(i))}</span><b>${pct(i.bps)}</b></div>`).join('')}</div></div>`;
  $('#resources').innerHTML = s.distribution.aiResources.map(r => bar(r.name, r.pct, `${r.pct}%`)).join('');

  const w = s.withdrawals.at(-1);
  $('#revenue').innerHTML = `<div class="kv"><b>Verified revenue</b><span>${fmtNear(s.company.verifiedPaymentsYocto, 4)} ${badge('real', 'testnet')}</span><b>Available to withdraw</b><span>${fmtNear(inv.availableYocto, 6)} ${''}</span><b>Already withdrawn</b><span>${fmtNear(inv.withdrawnYocto, 6)}</span></div>
    <button class="btn sm" id="withdraw" ${account && BigInt(inv.availableYocto) > 0n ? '' : 'disabled'}>Withdraw</button>
    ${w ? `<div class="status">${fmtNear(w.amountYocto, 6)} marked as withdrawn at ${when(w.at)}.</div>` : '<div class="status">Revenue appears here after a verified Premium payment in the game, once your contribution is recorded.</div>'}
    ${s.payments.length ? `<ul class="log" style="margin-top:12px">${s.payments.map(p => `<li>${badge('real', 'testnet')}<span>${fmtNear(p.amountYocto, 2)} from ${esc(p.account)} · <a href="${esc(p.explorerUrl)}" target="_blank" rel="noopener">transaction ↗</a></span></li>`).join('')}</ul>` : ''}`;

  if (s.chainProposals) {
    const cp = s.chainProposals;
    $('#proposals').innerHTML = cp.proposals.length ? cp.proposals.map(p => {
      const total = p.options.reduce((a, o) => a + BigInt(o.tally), 0n);
      const rows = p.options.map((o, i) => { const share = total ? Number(BigInt(o.tally) * 100n / total) : 0; const mine = p.myVote === i;
        return `<div class="bar"><span>${o.capUsd == null ? 'Option ' + (i + 1) : '$' + o.capUsd + ' growth budget'}${p.passedOption === i ? ' ✓' : ''}</span><i><b style="width:${share}%"></b></i><span>${share}%</span>${p.votable ? `<button class="btn sm ${mine ? 'selected' : ''}" data-chain-vote="${p.id}:${i}" ${account && inv.shareBps > 0 ? '' : 'disabled title="Only contributors can vote"'}>${mine ? 'Voted' : 'Vote'}</button>` : ''}</div>`; }).join('');
      return `<article class="prop prop-expanded"><div class="prop-head"><div><b>#${p.id} ${esc(p.title)}</b></div></div><div class="proposal-voting">${rows}<p class="status">${p.voters} voter(s) · ${p.votable ? 'voting ends ' + new Date(p.endsAtMs).toLocaleString() : 'voting closed'}</p></div>${!p.votable && p.status === 'Open' && account ? `<button class="btn sm" data-chain-finalize="${p.id}">Finalize</button>` : ''}</article>`; }).join('') : '<p class="status">No on-chain proposals yet. Submit the first one.</p>';
  } else {
  const p = s.proposal, v = p.votes, disabled = !account ? 'disabled title="Connect NEAR wallet to vote"' : inv.shareBps > 0 ? '' : 'disabled title="Only contributors can vote"';
  const list = rows => rows.map(r => bar(r.name, r.pct, `${r.pct}%`)).join('');
  $('#proposals').innerHTML = `<article class="prop prop-expanded"><div class="prop-head"><div><b>${esc(p.title)}</b></div></div><p>${esc(p.description)}</p>
    <div class="proposal-details"><div><p class="cap">Current allocation</p>${list(p.current)}</div><div><p class="cap">Proposed allocation</p>${list(p.proposed)}</div></div>
    <div class="proposal-voting"><p class="cap">Voting progress</p><div class="vote" aria-label="For ${v.for}%, against ${v.against}%, abstain ${v.abstain}%"><i style="width:${v.for}%;background:var(--money)"></i><i style="width:${v.against}%;background:#ff7a6b"></i><i style="width:${v.abstain}%;background:var(--line)"></i></div><p class="status">For ${v.for}% · Against ${v.against}% · Abstain ${v.abstain}%.</p></div>
    <div class="prop-actions"><button class="btn sm vote-for ${p.myVote === 'for' ? 'selected' : ''}" data-vote="for" ${disabled}>For</button><button class="btn ghost sm vote-against ${p.myVote === 'against' ? 'selected' : ''}" data-vote="against" ${disabled}>Against</button>${p.myVote ? `<span class="vote-note">Your vote: ${esc(p.myVote)}</span>` : ''}</div></article>`;
  }

  $('#board').innerHTML = DEPTS.map(([id, label]) => `<div class="dept"><h3>${label}</h3><div class="cols">${COLS.map(([st, sl]) => {
    const cards = s.tasks.filter(x => x.department === id && x.status === st);
    return `<div class="col2"><small>${sl} · ${cards.length}</small>${cards.map(c => `<button class="kcard ${c.failed ? 'warn' : ''}" data-task="${esc(c.id)}">${esc(c.title)}<small>${esc(c.agent)}${c.stage ? ` · ${esc(c.stage)}` : ''}${c.failed ? ' · needs attention' : ''}${c.source === 'worker' ? ' · live worker' : ''}</small>${c.id === 'marketing-launch-post' ? `<span class="task-stages" aria-label="Task stages">${s.stages.map((x, i) => { const current = s.stages.findIndex(stage => stage.id === s.job?.stage); return `<i class="${i < current || s.job?.stage === 'completed' ? 'done' : i === current ? 'current' : ''}">${esc(x.label)}</i>`; }).join('')}</span>` : ''}</button>`).join('')}</div>`;
  }).join('')}</div></div>`).join('');

  $('#activity').innerHTML = s.activity.map(a => `<li><span>${esc(a.text.replace(/\s*·?\s*(demo\s*\/\s*)?(simulated|mock|demo)(\s+only)?/ig, ''))}${a.url ? ` · <a href="${esc(a.url)}" target="_blank" rel="noopener">link ↗</a>` : ''}</span><time>${when(a.ts)}</time></li>`).join('') || '<li>No activity yet.</li>';
}

const modal = $('#modal'), body = $('#m-body');
const show = html => { body.innerHTML = html; modal.hidden = false; };
$('#m-close').onclick = () => { modal.hidden = true; };
modal.onclick = e => { if (e.target === modal) modal.hidden = true; };
addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });

document.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === tab)));
    document.querySelectorAll('[data-panel]').forEach(x => { x.hidden = x.dataset.panel !== tab.dataset.tab; });
    return;
  }
  const vote = e.target.closest('[data-vote]');
  if (vote && S) { act('/api/hackathon/vote', { vote: vote.dataset.vote }); return; }
  const cv = e.target.closest('[data-chain-vote]');
  if (cv && S) { const [id, opt] = cv.dataset.chainVote.split(':').map(Number); cv.disabled = true; $('#status').textContent = 'Approve the vote in your wallet…';
    castVote(id, opt).then(tx => { $('#status').textContent = `Vote sent${tx ? ' · ' + tx.slice(0, 10) + '…' : ''}`; return api('/api/hackathon/state'); }).catch(err => { cv.disabled = false; actError = Date.now(); $('#status').textContent = err.message; $('#status').classList.add('err'); }); return; }
  const fin = e.target.closest('[data-chain-finalize]');
  if (fin && S) { act('/api/hackathon/finalize', { proposalId: Number(fin.dataset.chainFinalize) }); return; }
  const task = e.target.closest('[data-task]');
  if (task && S) {
    const c = S.tasks.find(x => x.id === task.dataset.task); if (!c) return;
    const dept = DEPTS.find(d => d[0] === c.department)[1], st = COLS.find(x => x[0] === c.status)[1];
    show(`<p class="cap">${esc(dept)}</p><h3>${esc(c.title)}</h3><div class="kv"><b>Description</b><span>${esc(c.description)}</span><b>Department</b><span>${esc(dept)}</span><b>Assigned agent</b><span>${esc(c.agent)}</span><b>Status</b><span>${st}${c.stage ? ` · ${esc(c.stage)}` : ''}</span><b>Allocated AI budget</b><span>${tokens(c.budgetTokens)}</span><b>Actual token usage</b><span>${tokens(c.usedTokens)}</span><b>Result / deliverable</b><span style="white-space:pre-wrap">${c.result ? esc(c.result) : 'None yet'}</span><b>External links</b><span>${c.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join(' · ') || 'None'}</span></div>${c.failed ? `<div class="status err">${esc(c.failed)}</div>` : ''}`);
  }
  if (e.target.closest('#create-proposal')) {
    show(!account ? `<p class="cap">Create proposal</p><p>Connect your NEAR wallet to submit a proposal.</p><button class="btn sm" id="proposal-connect">Connect NEAR Wallet</button>`
      : S.investor.shareBps < 500 ? `<p class="cap">Create proposal</p><p>Вам надо иметь больше 5%, чтоб иметь возможность создавать воутинги.</p>`
      : `<p class="cap">Submit Board proposal</p><p>Creates a real on-chain Budget vote (contributors with units only). Options are the owner-approved growth budget tiers.</p><input id="proposal-title" maxlength="140" placeholder="Proposal title (8-140 chars)" style="width:100%;margin:8px 0"><button class="btn sm" id="proposal-submit">Submit on-chain</button><div class="status" id="proposal-status"></div>`);
  }
});
window.addEventListener('hackathon:open-task', e => openOperationsTask(e.detail.taskId));
let actError = 0;
const act = async (path, bodyObj = {}) => { const st = $('#status'); try { actError = 0; await api(path, bodyObj); } catch (err) { actError = Date.now(); st.textContent = err.message; st.classList.add('err'); } };
$('#wallet-btn').onclick = async e => { const btn = e.currentTarget; btn.disabled = true; $('#status').textContent = 'Open your wallet and approve the login message…'; try { await connectWallet(); btn.disabled = false; $('#status').textContent = 'Wallet connected'; } catch (err) { $('#status').textContent = err.message; $('#status').classList.add('err'); btn.disabled = false; } };
$('#wallet-off').onclick = async () => { try { const {disconnectWallet} = await import('./hackathon.js'); await disconnectWallet(); location.reload(); } catch (err) { $('#status').textContent = err.message; $('#status').classList.add('err'); } };
$('#connect-ai').onclick = () => act('/api/hackathon/connect-ai');
$('#revenue').onclick = e => { if (e.target.id === 'withdraw') act('/api/hackathon/withdraw'); };
body.addEventListener('click', async e => {
  if (e.target.id === 'proposal-connect') $('#wallet-btn').click();
  if (e.target.id === 'proposal-submit') {
    const st = $('#proposal-status'), btn = e.target; btn.disabled = true; st.textContent = 'Submitting on-chain…';
    try { const r = await api('/api/hackathon/proposal', { title: $('#proposal-title').value }); st.innerHTML = `Proposal #${esc(String(r.id))} created · <a href="${esc(r.explorerUrl)}" target="_blank" rel="noopener">transaction ↗</a>`; }
    catch (err) { st.textContent = err.message; btn.disabled = false; }
  }
});
let last = '';
watch((s, err) => {
  const st = $('#status');
  if (err) { st.textContent = err.message; st.classList.add('err'); return; }
  S = s; account = s.me?.account;
  if (!actError || Date.now() - actError > 6000) { st.classList.remove('err'); st.textContent = ''; }
  const sig = JSON.stringify({ ...s, now: 0 });
  if (sig !== last) { last = sig; render(); }
  toastNew(s);
});
