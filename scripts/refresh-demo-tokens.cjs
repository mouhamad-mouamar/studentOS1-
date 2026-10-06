// Ensure demo accounts exist and write fresh tokens + user ids to %TEMP%.
// Login first; if the password doesn't match, fall back to a fresh numbered account.
const SUPA = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwOTA1MmZkZWUyODZhMjY2ODQyOWYiLCJyb2xlIjoiYW5vbiJ9.6kre7yWu80xczttItHpDPtzi0WRY8GQNkmS4MH45yPg';
const fs = require('fs');
const path = require('path');
const tmp = process.env.TEMP;
const PW = 'DemoPw!2026-secure';

async function auth(endpoint, body) {
  const r = await fetch(`${SUPA}/auth/v1/${endpoint}`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
  // Slot 1: try the original demo account, else demo3, demo4...
  const slots = [
    { email: 'verdent-demo@example.test', out: 'demo_token.txt', uidOut: 'demo_uid.txt' },
    { email: 'verdent-demo2@example.test', out: 'demo_token2.txt', uidOut: 'demo_uid2.txt' },
  ];
  for (const slot of slots) {
    const res = await auth('token?grant_type=password', { email: slot.email, password: PW });
    if (!res.data.access_token) {
      console.log('FAIL', slot.email, JSON.stringify(res.data).slice(0, 300));
      process.exit(1);
    }
    const ok = { token: res.data.access_token, uid: res.data.user.id };
    fs.writeFileSync(path.join(tmp, slot.out), ok.token);
    fs.writeFileSync(path.join(tmp, slot.uidOut), ok.uid);
    console.log('OK', slot.email, 'uid=' + ok.uid, '->', slot.out);
  }
})();
