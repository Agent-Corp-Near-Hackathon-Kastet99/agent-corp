// View-only decisions. A purchase never affects this calculation; only chain claimable does.
export function canWithdraw(contributor, demoWallets) {
  const role = Object.entries(demoWallets || {}).find(([, account]) => account === contributor.account_id)?.[0];
  return ['alice', 'bob'].includes(role) && /^\d+$/.test(contributor.claimable) && BigInt(contributor.claimable) > 0n ? role : null;
}
export function closedPeriods(periods) {
  return periods.filter(period => period.status === 'Closed').slice().reverse();
}
