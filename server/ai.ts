import fs from 'fs';
import { AI_API_KEY, AI_BASE_URL, AI_CHAT_MODEL, AI_EMBED_MODEL, aiConfigured, aiProviderInfo } from './config';

// DEBUG_AI diagnostics go to a dedicated file rather than stderr: on Windows
// process redirections are unreliable, and this keeps raw model output out of
// normal server logs.
const DEBUG_FILE = process.env.DEBUG_AI_FILE || 'debug-ai.log';
function debugLog(line: string) {
  try {
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super('AI_NOT_CONFIGURED');
  }
}

export class AiProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const EXTERNAL_TIMEOUT_MS = 45_000;
// Local CPU inference (quantized small models) is much slower than a hosted
// API; give it room to finish structured generation instead of timing out.
const LOCAL_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 2;

const timeoutMs = () => (aiProviderInfo().engine === 'local' ? LOCAL_TIMEOUT_MS : EXTERNAL_TIMEOUT_MS);

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AI_API_KEY) h.Authorization = `Bearer ${AI_API_KEY}`;
  return h;
}

async function chat(messages: ChatMessage[], jsonMode = false, maxTokens?: number): Promise<string> {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          model: AI_CHAT_MODEL,
          messages,
          temperature: 0.3,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          // Cap structured generation so it finishes before hitting the model's
          // context window — truncation mid-JSON is the main small-model failure.
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new AiProviderError(res.status, `AI provider busy (${res.status})`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new AiProviderError(res.status, `AI chat failed (${res.status}): ${body.slice(0, 300)}`);
      }
      const data: any = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      if (err instanceof AiProviderError && err.status < 500 && err.status !== 429) throw err;
      if (err instanceof AiNotConfiguredError) throw err;
      // Timeouts are NOT retried: on slow local CPU inference a timed-out
      // generation would just be re-queued and time out again, multiplying
      // the request latency. Only transient 429/5xx responses are retried.
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new AiProviderError(504, 'AI provider timed out');
      }
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new AiProviderError(502, 'AI provider unreachable');
}

// Ask the model for JSON; validate the parsed result with an optional guard.
// salvageKeys (optional) enables truncated-output recovery for item-list
// responses: complete flat objects carrying any salvageKey are kept.
export async function chatJson<T = any>(system: string, user: string, guard?: (parsed: T) => boolean, maxTokens = 1200, salvageKeys?: string[]): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await chat(
      [
        { role: 'system', content: attempt === 0 ? system : `${system}\n\nYour previous response was not usable. Respond with ONLY valid JSON matching the schema. Every item MUST include ALL fields from the schema — no field may be omitted or empty. No extra text before or after the JSON.` },
        { role: 'user', content: user },
      ],
      true,
      maxTokens,
    );
    if (process.env.DEBUG_AI) debugLog(`[chatJson attempt ${attempt}] finish-prompt-len≈${user.length} raw(${raw.length}): ${raw.slice(0, 8000).replace(/\n/g, ' ')}`);
    let parsed: T | undefined;
    try {
      parsed = JSON.parse(raw) as T;
    } catch {
      const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      let ok = false;
      if (m) {
        try {
          parsed = JSON.parse(m[0]) as T;
          ok = true;
        } catch {}
      }
      if (!ok) {
        // Truncated output (finish=length): salvage complete flat objects that
        // carry one of the expected item keys. Only fully-parseable objects
        // survive — nothing is invented.
        const flat: any[] = [];
        if (salvageKeys?.length) {
          for (const mm of raw.matchAll(/\{[^{}]*\}/g)) {
            try {
              const o = JSON.parse(mm[0]);
              if (o && typeof o === 'object' && salvageKeys.some((k) => k in o)) flat.push(o);
            } catch {}
          }
        }
        if (flat.length > 0) {
          parsed = { items: flat } as unknown as T;
        } else {
          continue;
        }
      }
    }
    if (parsed === undefined) continue;
    if (guard && !guard(parsed)) continue;
    return parsed;
  }
  throw new AiProviderError(502, 'AI returned invalid structured output');
}

// Small local models often return the right CONTENT in the wrong SHAPE: a
// single item instead of {"cards":[...]}, a top-level array, or the array under
// a different key. This recovers the structure WITHOUT inventing content —
// every returned element comes verbatim from the model's output.
export function coerceItems(parsed: any, itemKeys: string[]): any[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  const values = Object.values(parsed);
  // single flat item, e.g. {"front": ..., "back": ...}
  if (itemKeys.some((k) => k in parsed)) return [parsed];
  // correct items under a different array key, e.g. {"flashcards":[...]}
  for (const v of values) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] && itemKeys.some((k) => k in v[0])) {
      return v as any[];
    }
  }
  return null;
}

export async function chatText(system: string, user: string, maxTokens = 1200): Promise<string> {
  // Bound free-text generation: without a cap, llama.cpp/Ollama generate until
  // the context window is full, which on slow local CPU inference always ends
  // in a client timeout. 1200 tokens ≈ 900 words — ample for tutor answers
  // and study notes.
  return chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    false,
    maxTokens,
  );
}

// Returns null when no provider is configured so callers can fall back to keyword retrieval.
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!aiConfigured()) return null;
  const out: number[][] = [];
  const batchSize = 64;
  for (let i = 0; i < texts.length; i += batchSize) {
    const res = await fetch(`${AI_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: AI_EMBED_MODEL, input: texts.slice(i, i + batchSize) }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AiProviderError(res.status, `AI embeddings failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data: any = await res.json();
    for (const item of data.data) out.push(item.embedding as number[]);
  }
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
