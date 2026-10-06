export const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

export const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
export const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
export const AI_CHAT_MODEL = process.env.AI_CHAT_MODEL || 'gpt-4o-mini';
export const AI_EMBED_MODEL = process.env.AI_EMBED_MODEL || 'text-embedding-3-small';

export const PORT = Number(process.env.PORT || 8080);

export function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Supabase configuration missing (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY)');
  }
}

export const aiConfigured = () => Boolean(AI_API_KEY);
