import fs from 'fs';
import { AI_API_KEY, AI_BASE_URL, AI_CHAT_MODEL, aiFallbackModels, AI_EMBED_MODEL, aiConfigured, aiProviderInfo } from './config.js';

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

// Messages authored by this module — safe to show to users verbatim. Anything
// else (raw provider bodies, network errors) is replaced with a generic line.
const SAFE_AI_MESSAGES = new Set([
  'AI is temporarily rate-limited. Please try again shortly.',
  'AI provider timed out',
  'AI returned invalid structured output',
]);

// Map an AI-layer failure to an honest HTTP status + user-safe message.
// 429 stays 429 (rate limit), 503 stays 503 (provider unavailable), timeouts
// become 504; everything else collapses to 502. Never echoes raw provider
// response bodies to the client.
export function aiHttpStatus(err: unknown): { status: number; message: string } {
  if (err instanceof AiNotConfiguredError) return { status: 503, message: 'AI_NOT_CONFIGURED' };
  if (err instanceof AiProviderError) {
    if (err.status === 429 || err.status === 503 || err.status === 504) {
      const message = SAFE_AI_MESSAGES.has(err.message)
        ? err.message
        : err.status === 429
          ? 'AI is temporarily rate-limited. Please try again shortly.'
          : err.status === 504
            ? 'AI provider timed out'
            : 'AI is currently unavailable. Please try again.';
      return { status: err.status, message };
    }
    const message = SAFE_AI_MESSAGES.has(err.message) ? err.message : 'AI could not complete this request. Please try again.';
    return { status: 502, message };
  }
  return { status: 502, message: 'AI could not complete this request. Please try again.' };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// AI_TIMEOUT_MS (optional) narrows the per-attempt budget — an explicit
// operator override wins over the inferred local/external defaults, and is
// also what makes the chain-deadline behavior testable.
const EXPLICIT_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || null;
const EXTERNAL_TIMEOUT_MS = 45_000;
// Local CPU inference (quantized small models) is much slower than a hosted
// API; give it room to finish structured generation instead of timing out.
const LOCAL_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 2;

const timeoutMs = () => EXPLICIT_TIMEOUT_MS ?? (aiProviderInfo().engine === 'local' ? LOCAL_TIMEOUT_MS : EXTERNAL_TIMEOUT_MS);

// Flip to true for the rest of the process once a provider rejects
// response_format — avoids re-sending a rejected parameter on every call.
let skipJsonMode = false;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AI_API_KEY) h.Authorization = `Bearer ${AI_API_KEY}`;
  return h;
}

async function chat(messages: ChatMessage[], jsonMode = false, maxTokens?: number): Promise<string> {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  // Primary model first; optional fallback models (AI_CHAT_MODEL_FALLBACKS)
  // are tried only after the primary exhausts its retries on transient errors.
  // Unset env → single-model loop, identical to the previous behavior.
  const models = [AI_CHAT_MODEL, ...aiFallbackModels()];
  // Overall wall-clock budget for the WHOLE chain. Without it, a stalling
  // provider (accepted connection, no response) would burn the per-attempt
  // timeout on every model × retry — minutes of dead latency ending in a
  // platform-level timeout instead of an honest error.
  const deadline = Date.now() + timeoutMs() * 2 + 15_000;
  let lastErr: unknown;
  for (const model of models) {
    try {
      return await chatWithModel(model, messages, jsonMode, maxTokens, deadline);
    } catch (err: any) {
      lastErr = err;
      // Never fall back for non-transient failures (bad request, not configured).
      if (err instanceof AiProviderError && err.status < 500 && err.status !== 429) throw err;
      if (err instanceof AiNotConfiguredError) throw err;
      if (err instanceof AiBudgetExceededError) throw new AiProviderError(504, 'AI provider timed out');
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new AiProviderError(504, 'AI provider timed out');
    }
  }
  throw lastErr instanceof Error ? lastErr : new AiProviderError(502, 'AI provider unreachable');
}

// Thrown when the chain's overall wall-clock budget is exhausted; surfaced as
// a timeout so the client shows an honest "try again" instead of hanging.
class AiBudgetExceededError extends Error {}

async function chatWithModel(model: string, messages: ChatMessage[], jsonMode: boolean, maxTokens?: number, deadline = Infinity): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 2_000) throw new AiBudgetExceededError();
    try {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.3,
        // Cap structured generation so it finishes before hitting the model's
        // context window — truncation mid-JSON is the main small-model failure.
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      };
      // Some OpenAI-compatible providers/models reject response_format with a
      // 400 (free-tier catalog changes often). Fall back to plain prompting —
      // the parse/repair/salvage layers below already handle raw output.
      if (jsonMode && !skipJsonMode) body.response_format = { type: 'json_object' };
      const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
        // Per-attempt timeout clamped to the chain's remaining budget.
        signal: AbortSignal.timeout(Math.min(timeoutMs(), remaining)),
      });
      if (res.status === 400 && jsonMode && !skipJsonMode) {
        skipJsonMode = true;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new AiProviderError(
          res.status,
          res.status === 429
            ? 'AI is temporarily rate-limited. Please try again shortly.'
            : `AI provider busy (${res.status})`,
        );
        // Bounded exponential backoff with jitter: spreads retry bursts across
        // clients so a saturated free pool is not hammered in lockstep.
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1) + Math.floor(Math.random() * 800)));
        continue;
      }
      if (!res.ok) {
        const body2 = await res.text();
        throw new AiProviderError(res.status, `AI chat failed (${res.status}): ${body2.slice(0, 300)}`);
      }
      const data: any = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      if (err instanceof AiProviderError && err.status < 500 && err.status !== 429) throw err;
      if (err instanceof AiNotConfiguredError) throw err;
      if (err instanceof AiBudgetExceededError) throw err;
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

// Best-effort repair of common small-model JSON mistakes, applied only when
// strict parsing fails: markdown fences, prose before/after the JSON, trailing
// commas, and smart quotes used as string delimiters. Content strings are
// never rewritten except for quote normalization on already-broken output.
// Parse-layer only: no prompts, request parameters, or generation behavior
// change, so it cannot affect what the model produces.
export function repairJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/```json|```/g, '');
  // Drop prose before the first JSON value and after the last closing brace/bracket.
  const a = s.indexOf('{');
  const b = s.indexOf('[');
  const start = a === -1 ? b : b === -1 ? a : Math.min(a, b);
  if (start > 0) s = s.slice(start);
  const endBrace = s.lastIndexOf('}');
  const endBracket = s.lastIndexOf(']');
  const end = Math.max(endBrace, endBracket);
  if (end !== -1 && end < s.length - 1) s = s.slice(0, end + 1);
  s = s.replace(/“|”/g, '"').replace(/‘|’/g, "'");
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return s.trim();
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
      // Strict parse failed: try best-effort repair before the brace-scan and
      // salvage paths (both preserved).
      try {
        parsed = JSON.parse(repairJson(raw)) as T;
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined) {
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

// Returns null when no provider or no embeddings model is configured so callers
// can fall back to keyword retrieval. Chat-only providers (e.g. OpenRouter's
// free tier, which has no embeddings endpoint) must never receive embeddings
// requests — AI_EMBED_MODEL unset means embeddings are off by design.
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!aiConfigured() || !AI_EMBED_MODEL) return null;
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

/* ---------------- generated-quiz sanitation ---------------- */

// Single-letter "options" (a/b/c/d) are placeholders, not answers.
const PLACEHOLDER_OPTION = /^[a-j]$/i;

export interface SanitizedQuestion {
  type?: string;
  question: string;
  options?: string[];
  answer: string;
  explanation?: string;
  concept_title?: string;
}

/**
 * Validate model-generated quiz/exam questions before persistence.
 *
 * The grader compares the student's submitted option TEXT against the stored
 * `answer` text, so a multiple-choice question is only gradable when:
 *  - it has at least two distinct, non-placeholder options, and
 *  - the answer text exactly matches one of those options (case-insensitive;
 *    the stored answer is normalized to the option's own casing).
 * Questions violating these invariants are DROPPED, never stored ungradable.
 */
export function sanitizeGeneratedQuestions(raw: any): SanitizedQuestion[] {
  const out: SanitizedQuestion[] = [];
  for (const q of Array.isArray(raw) ? raw : []) {
    const question = typeof q?.question === 'string' ? q.question.trim() : '';
    const answer = q?.answer != null ? String(q.answer).trim() : '';
    if (!question || !answer) continue;
    if (Array.isArray(q.options) && q.options.length > 0) {
      const seen = new Set<string>();
      const options: string[] = [];
      for (const rawOpt of q.options) {
        const opt = String(rawOpt ?? '').trim();
        if (!opt || opt.length > 300) continue;
        const key = opt.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        options.push(opt);
      }
      if (options.length < 2 || options.every((o) => PLACEHOLDER_OPTION.test(o))) continue;
      const match = options.find((o) => o.toLowerCase() === answer.toLowerCase());
      if (!match) continue;
      out.push({ ...q, question, options, answer: match });
    } else {
      // Multiple-choice without usable options is unanswerable (the grader
      // compares submitted option TEXT against the stored answer). Drop it
      // rather than persist it or silently re-type it as short_answer.
      if (typeof q?.type === 'string' && /multiple[\s_-]?choice|\bmcq?\b/i.test(q.type)) continue;
      out.push({ ...q, question, answer });
    }
  }
  return out;
}
