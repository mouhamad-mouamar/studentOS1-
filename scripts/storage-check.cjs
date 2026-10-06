const fs = require('fs');
const SUPA = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwOTA1MmZkZWUyODZhMjY2ODQyOWYiLCJyb2xlIjoiYW5vbiJ9.6kre7yWu80xczttItHpDPtzi0WRY8GQNkmS4MH45yPg';
const t1 = fs.readFileSync(process.env.TEMP + '\\demo_token.txt', 'utf8').trim();
const t2 = fs.readFileSync(process.env.TEMP + '\\demo_token2.txt', 'utf8').trim();
(async () => {
  const del = await fetch(`${SUPA}/storage/v1/object/materials/089da010-7068-47c6-83ab-8e046720c928/course/intruder.txt`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t2, apikey: ANON } });
  console.log('cleanup intruder (404/200 both fine):', del.status);
  const up = await fetch(`${SUPA}/storage/v1/object/materials/089da010-7068-47c6-83ab-8e046720c928/x/intruder.txt`, { method: 'POST', headers: { Authorization: 'Bearer ' + t2, apikey: ANON, 'Content-Type': 'text/plain' }, body: 'nope' });
  console.log('cross-user upload:', up.ok ? 'FAIL — NOT BLOCKED' : 'BLOCKED (' + up.status + ')');
  const up3 = await fetch(`${SUPA}/storage/v1/object/materials/089da010-7068-47c6-83ab-8e046720c928/x/own-prefix.txt`, { method: 'POST', headers: { Authorization: 'Bearer ' + t1, apikey: ANON, 'Content-Type': 'text/plain' }, body: 'ok' });
  console.log('own-prefix upload:', up3.ok ? 'OK (' + up3.status + ')' : 'FAIL (' + up3.status + ') ' + (await up3.text()).slice(0, 120));
  const rd = await fetch(`${SUPA}/storage/v1/object/materials/089da010-7068-47c6-83ab-8e046720c928/course/test-lecture.txt`, { headers: { Authorization: 'Bearer ' + t2, apikey: ANON } });
  console.log('cross-user read:', rd.ok ? 'FAIL — NOT BLOCKED' : 'BLOCKED (' + rd.status + ')');
})();
