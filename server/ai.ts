import { AI_API_KEY, AI_BASE_URL, AI_CHAT_MODEL, AI_EMBED_MODEL, aiConfigured } from './config';

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

const TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;

async function chat(messages: ChatMessage[], jsonMode = false): Promise<string> {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
        body: JSON.stringify({
          model: AI_CHAT_MODEL,
          messages,
          temperature: 0.3,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
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
      // Timeout / network error: retry
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new AiProviderError(502, 'AI provider unreachable');
}

// Ask the model for JSON; validate the parsed result with an optional guard.
export async function chatJson<T = any>(system: string, user: string, guard?: (parsed: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(
      [
        { role: 'system', content: attempt === 0 ? system : `${system}\n\nYour previous response was not valid JSON. Respond with ONLY valid JSON.` },
        { role: 'user', content: user },
      ],
      true,
    );
    let parsed: T;
    try {
      parsed = JSON.parse(raw) as T;
    } catch {
      const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]) as T;
        } catch {
          continue;
        }
      } else continue;
    }
    if (guard && !guard(parsed)) continue;
    return parsed;
  }
  throw new AiProviderError(502, 'AI returned invalid structured output');
}

export async function chatText(system: string, user: string): Promise<string> {
  return chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
}

// Returns null when no provider is configured so callers can fall back to keyword retrieval.
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!aiConfigured()) return null;
  const out: number[][] = [];
  const batchSize = 64;
  for (let i = 0; i < texts.length; i += batchSize) {
    const res = await fetch(`${AI_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: AI_EMBED_MODEL, input: texts.slice(i, i + batchSize) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
