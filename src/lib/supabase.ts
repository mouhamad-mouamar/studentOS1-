import { createClient } from '@supabase/supabase-js';
import { createVerdentAuth } from '@verdent/auth-js';

// Public runtime config of the managed Supabase project (projectRef
// p9052fdee286a2668429f). The publishable key is the public anon key — it is
// safe to ship in the browser bundle and is NOT a secret.
const MANAGED_SUPABASE_URL = 'https://supabase-api-prod.verdent.ai/p/p9052fdee286a2668429f';
const MANAGED_PUBLISHABLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2OTAyMDg2LCJpYXQiOjE3OTEyODI4ODYsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwOTA1MmZkZWUyODZhMjY2ODQyOWYiLCJyb2xlIjoiYW5vbiJ9.6kre7yWu80xczttItHpDPtzi0WRY8GQNkmS4MH45yPg';

// Verdent hosting serves a same-origin BaaS proxy for preview/published apps.
// Other hosts (e.g. Vercel) have no such proxy, so the client must talk to the
// managed Supabase URL directly — otherwise every auth request 404s.
const isVerdentHost =
  typeof window !== 'undefined' && /(^|\.)verdent\.(ai|app)$/.test(window.location.hostname);

// Prefer platform-injected public config; fall back per host type.
const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL || (isVerdentHost ? window.location.origin : MANAGED_SUPABASE_URL);
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  (isVerdentHost ? 'verdent-baas-proxy' : MANAGED_PUBLISHABLE_KEY);

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const auth = createVerdentAuth({
  supabase,
  ...(import.meta.env.VITE_VERDENT_OAUTH_INITIATE_URL
    ? { oauth: { authorizeUrl: import.meta.env.VITE_VERDENT_OAUTH_INITIATE_URL } }
    : {}),
});
