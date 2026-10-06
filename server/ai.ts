import { AI_API_KEY, AI_BASE_URL, AI_CHAT_MODEL, AI_EMBED_MODEL, aiConfigured } from './config';

export class AiNotConfiguredError extends Error {
  constructor() {
    super('AI_NOT_CONFIGURED');
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(messages: ChatMessage[], jsonMode = false): Promise<string> {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({
      model: AI_CHAT_MODEL,
      messages,
      temperature: 0.3,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AI chat failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Ask the model for JSON and parse defensively.
export async function chatJson<T = any>(system: string, user: string): Promise<T> {
  const raw = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    true,
  );
  try {
    return JSON.parse(raw) as T;
  } catch {
    const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error('AI returned invalid JSON');
  }
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
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AI embeddings failed (${res.status}): ${body.slice(0, 300)}`);
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
