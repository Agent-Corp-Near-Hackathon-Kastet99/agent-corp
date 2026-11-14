import { loadGrowthEnv, isDryRun } from '../src/growth/env.js';
import { loadBrief, hasPlaceholderUrl } from '../src/growth/brief.js';
import { loadOwnerPolicy } from '../src/growth/policy.js';
const env = loadGrowthEnv();
const groups: Record<string, string[]> = {
  'LLM / Anthropic': ['ANTHROPIC_API_KEY'],
  'Research / Exa': ['EXA_API_KEY'],
  'Images / fal': ['FAL_KEY'],
  'Distribution / Postiz': ['POSTIZ_API_KEY'],
  'Bluesky (optional)': ['BLUESKY_HANDLE','BLUESKY_APP_PASSWORD'],
  'Telegram (optional)': ['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'],
  'Discord (optional)': ['DISCORD_WEBHOOK_URL'],
  'Analytics / PostHog': ['POSTHOG_PERSONAL_API_KEY','POSTHOG_PROJECT_ID'],
  'Opt-in email / Resend (optional)': ['RESEND_API_KEY','RESEND_FROM'],
  'Paused campaigns / Instantly (optional)': ['INSTANTLY_API_KEY'],
};
console.log(`Mode: ${isDryRun(env) ? 'DRY-RUN' : 'LIVE'}; no external requests made.`);
for (const [name,keys] of Object.entries(groups)) {
  const missing=keys.filter(k=>!env[k as keyof typeof env]);
  console.log(`${name}: ${missing.length ? 'missing '+missing.join(', ') : 'configured (not live-verified)'}`);
}
const policy=loadOwnerPolicy(), brief=loadBrief();
console.log(`Product URL: ${hasPlaceholderUrl(brief)?'placeholder; change growth/brief.yaml':'configured'}`);
console.log(`Policy: ${policy.growth_paused?'paused':'enabled'}, total cap $${policy.total_budget_usd}, cycle cap $${policy.cycle_budget_usd}`);
console.log(`Expense bridge: ${env.GROWTH_EXPENSE_WRITES==='on'&&env.GROWTH_EXPENSE_PAYEE?'configured (testnet only)':'disabled'}`);
console.log('Setup guide: docs/KEYS-SETUP.md');
