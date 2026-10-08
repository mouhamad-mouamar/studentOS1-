export const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

// ---------------- AI provider ----------------
//
// StudyOS is provider-agnostic and local-first. The AI layer speaks the
// OpenAI-compatible /chat/completions + /embeddings protocol, which every
// mainstream local inference server implements (Ollama, llama.cpp server,
// vLLM, LM Studio, llamafile). A commercial API is never required and never
// the default.
//
// Environment:
//   AI_BASE_URL    e.g. http://127.0.0.1:11434/v1 (Ollama). REQUIRED to enable AI.
//                  Unset → AI disabled; the app stays fully honest (AI_NOT_CONFIGURED).
//   AI_API_KEY     Optional. Local servers need none. Only set it for an
//                  external provider the operator explicitly opted into.
//   AI_CHAT_MODEL  e.g. qwen2.5:3b-instruct (Ollama tag) or a GGUF name.
//   AI_EMBED_MODEL Optional; e.g. nomic-embed-text. Without it, BM25 retrieval is used.

export const AI_BASE_URL = (process.env.AI_BASE_URL || '').replace(/\/$/, '');
export const AI_API_KEY = process.env.AI_API_KEY || '';
// No fake default: sending a made-up model ID to an OpenAI-compatible provider
// produces a confusing provider 400 ("local-model is not a valid model ID").
// An unset model must mean "AI not usable", handled honestly by aiConfigured().
export const AI_CHAT_MODEL = process.env.AI_CHAT_MODEL || '';
export const AI_EMBED_MODEL = process.env.AI_EMBED_MODEL || '';
// Optional comma-separated chat models tried only when the primary model keeps
// failing with transient errors (429/5xx). Unset by default → behavior unchanged.
export const AI_CHAT_MODEL_FALLBACKS = process.env.AI_CHAT_MODEL_FALLBACKS || '';

export const PORT = Number(process.env.PORT || 8080);

export function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Supabase configuration missing (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY)');
  }
  let parsed: URL;
  try {
    parsed = new URL(SUPABASE_URL);
  } catch {
    throw new Error('Supabase configuration invalid: SUPABASE_URL must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Supabase configuration invalid: SUPABASE_URL must use http(s)');
  }
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

export interface AiProviderInfo {
  engine: 'local' | 'external' | 'none';
  configured: boolean;
  chatModel: string;
  embedModel: string;
  baseUrlHost: string | null;
  keyRequired: boolean;
}

// Engine state derived only from configuration — never guessed, never defaulted
// to a paid provider. "Configured" means the AI layer can actually issue a
// chat request: a base URL AND a chat model. A base URL without a model must
// report honestly as not configured instead of failing per-request upstream.
export function aiProviderInfo(): AiProviderInfo {
  if (!AI_BASE_URL) {
    return { engine: 'none', configured: false, chatModel: '', embedModel: '', baseUrlHost: null, keyRequired: false };
  }
  let host = AI_BASE_URL;
  try {
    host = new URL(AI_BASE_URL).hostname;
  } catch {
    // keep raw string if not a full URL
  }
  const local = isLocalHost(host);
  return {
    engine: local ? 'local' : 'external',
    configured: Boolean(AI_CHAT_MODEL),
    chatModel: AI_CHAT_MODEL,
    embedModel: AI_EMBED_MODEL,
    baseUrlHost: host,
    keyRequired: !local,
  };
}

export const aiConfigured = () => Boolean(AI_BASE_URL && AI_CHAT_MODEL);
