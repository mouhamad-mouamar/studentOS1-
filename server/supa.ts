import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

// Build an RLS-scoped client: every query runs as the authenticated user, so
// row-level security (auth.uid() = user_id) is the real isolation boundary.
export function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// Anonymous-level client only for auth verification calls.
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
