import type { SupabaseClient } from '@supabase/supabase-js';
import { embed, cosineSimilarity } from './ai.js';

export interface RetrievedChunk {
  id: string;
  material_id: string;
  content: string;
  score: number;
  page_number?: number | null;
}

const STOP = new Set(
  'a an and are as at be by for from how in is it of on or that the to was what when where which who why with this these those'.split(' '),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length > 2 && !STOP.has(t));
}

export async function retrieveChunks(
  client: SupabaseClient,
  courseId: string,
  query: string,
  limit = 8,
  materialIds?: string[],
): Promise<RetrievedChunk[]> {
  // materialIds is always pre-validated by the caller (must belong to course);
  // RLS on the user-scoped client is the real ownership boundary.
  let q = client
    .from('chunks')
    .select('id, material_id, content, embedding, page_number')
    .eq('course_id', courseId)
    .limit(2000);
  if (materialIds && materialIds.length > 0) q = q.in('material_id', materialIds);
  const { data: chunks, error } = await q;
  if (error || !chunks || chunks.length === 0) return [];

  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  // Keyword scoring (BM25-style) over the candidate set.
  const df = new Map<string, number>();
  const tokenized = chunks.map((c: any) => {
    const t = tokenize(c.content);
    for (const tok of new Set(t)) df.set(tok, (df.get(tok) || 0) + 1);
    return t;
  });
  const N = chunks.length;
  const avgLen = tokenized.reduce((s: number, t: string[]) => s + t.length, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;
  const keywordScore = (i: number): number => {
    let s = 0;
    const counts = new Map<string, number>();
    for (const t of tokenized[i]) counts.set(t, (counts.get(t) || 0) + 1);
    for (const q of qTokens) {
      const f = counts.get(q) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokenized[i].length) / avgLen)));
    }
    return s;
  };

  // Semantic scoring when embeddings exist; scale keyword and semantic to comparable ranges.
  const vectors = await embed([query]).catch(() => null);
  const qVec = vectors?.[0] ?? null;

  const scored: RetrievedChunk[] = chunks.map((c: any, i: number) => {
    let sem = 0;
    if (qVec && Array.isArray(c.embedding) && c.embedding.length > 0) {
      sem = Math.max(0, cosineSimilarity(qVec, c.embedding));
    }
    return { id: c.id, material_id: c.material_id, content: c.content, score: sem + keywordScore(i) / 12, page_number: c.page_number ?? null };
  });

  const anySemantic = qVec && chunks.some((c: any) => Array.isArray(c.embedding) && c.embedding.length > 0);
  // Corpus-size-aware relevance floor. BM25 idf collapses on tiny corpora:
  // with N=1 every term's idf is log(1 + 0.5/1.5) ≈ 0.29, so a query matching
  // four exact terms scores only ~0.12 after the /12 scaling — the previous
  // fixed 0.2 floor rejected genuinely relevant chunks (verified in
  // production evaluation: the tutor claimed "material does not cover this"
  // for topics squarely covered by the only chunk). Small candidate sets get
  // a proportionally lower floor; zero-match chunks still score 0 and weak
  // single-common-word matches (~0.02) stay excluded.
  const minScore = anySemantic ? 0.15 : N <= 10 ? 0.1 : 0.2;
  return scored
    .filter((s) => s.score > minScore)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit);
}

export interface Citation {
  chunkId: string;
  materialId: string;
  source: string;
  page?: number | null;
  snippet?: string;
}

export interface RagResult {
  context: string;
  citations: Citation[];
  /** True when scored retrieval found nothing and the context came from the
   * bounded broad fallback — the excerpts are real course content, but they
   * were not query-matched, so callers must disclose this in their prompts. */
  weakEvidence: boolean;
}

function chunkSnippet(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 260 ? oneLine.slice(0, 260).trimEnd() + '…' : oneLine;
}

async function materialsNames(client: SupabaseClient, matIds: string[]): Promise<Map<string, string>> {
  const nameById = new Map<string, string>();
  if (matIds.length) {
    const { data: mats } = await client.from('materials').select('id, filename').in('id', matIds);
    for (const m of mats || []) nameById.set(m.id, m.filename);
  }
  return nameById;
}

function renderContext(chunks: RetrievedChunk[], nameById: Map<string, string>): { context: string; citations: Citation[] } {
  const parts = chunks.map((c, i) => {
    const page = typeof c.page_number === 'number' ? `, page ${c.page_number}` : '';
    return `[${i + 1}] (source: ${nameById.get(c.material_id) || 'material'}${page})\n${c.content}`;
  });
  return {
    context: parts.join('\n\n---\n\n'),
    citations: chunks.map((c) => ({
      chunkId: c.id,
      materialId: c.material_id,
      source: nameById.get(c.material_id) || 'material',
      page: c.page_number ?? null,
      snippet: chunkSnippet(c.content),
    })),
  };
}

export async function buildRagContext(
  client: SupabaseClient,
  courseId: string,
  query: string,
  limit = 8,
  materialIds?: string[],
): Promise<RagResult> {
  const chunks = await retrieveChunks(client, courseId, query, limit, materialIds);
  const matIds = [...new Set(chunks.map((c) => c.material_id))];
  const nameById = await materialsNames(client, matIds);
  return { ...renderContext(chunks, nameById), weakEvidence: false };
}

// Bounded character budget for a broad course-summary context (roughly 6k
// tokens) — enough for a coherent multi-section summary without approaching
// the provider's limits.
const BROAD_MAX_CHARS = 24_000;
const BROAD_CHUNK_CHARS = 1_200;

/**
 * Course/material-level retrieval for summary requests.
 *
 * Summary intents ("لخّصلي المادة", "summarize this course") are not semantic
 * lookups: the query words never appear in the material, so query-scored
 * retrieval legitimately returns nothing (and with no embedding model the
 * keyword-only scores are all zero). This fetches a representative,
 * ownership-respecting spread of chunks across the authorized materials —
 * round-robin over materials so multi-file courses are covered evenly — and
 * truncates to a bounded character budget. No scoring, no relevance floor:
 * every selected chunk is real course content.
 */
export async function buildBroadContext(
  client: SupabaseClient,
  courseId: string,
  limit = 12,
  materialIds?: string[],
): Promise<{ context: string; citations: Citation[] }> {
  let q = client
    .from('chunks')
    .select('id, material_id, content, page_number')
    .eq('course_id', courseId)
    .order('material_id')
    .order('id')
    .limit(600);
  if (materialIds && materialIds.length > 0) q = q.in('material_id', materialIds);
  const { data: chunks, error } = await q;
  if (error || !chunks || chunks.length === 0) return { context: '', citations: [] };

  // Round-robin across materials: course-wide summaries cover every file;
  // single-material scopes stay within that file.
  const byMaterial = new Map<string, RetrievedChunk[]>();
  for (const c of chunks) {
    const list = byMaterial.get(c.material_id) || [];
    list.push({ id: c.id, material_id: c.material_id, content: c.content, score: 0, page_number: c.page_number ?? null });
    byMaterial.set(c.material_id, list);
  }
  const picked: RetrievedChunk[] = [];
  const queues = [...byMaterial.values()];
  let budget = BROAD_MAX_CHARS;
  outer: for (let round = 0; round < Math.ceil(limit / Math.max(1, queues.length)) + 1; round++) {
    for (const list of queues) {
      const next = list[round];
      if (!next) continue;
      if (picked.length >= limit || budget <= 200) break outer;
      const content = next.content.length > BROAD_CHUNK_CHARS ? next.content.slice(0, BROAD_CHUNK_CHARS).trimEnd() + '…' : next.content;
      budget -= content.length;
      picked.push({ ...next, content });
    }
  }
  if (picked.length === 0) return { context: '', citations: [] };
  const nameById = await materialsNames(client, [...new Set(picked.map((c) => c.material_id))]);
  return renderContext(picked, nameById);
}

/**
 * Scored retrieval with a bounded, ownership-respecting fallback.
 *
 * When query-scored retrieval returns nothing — e.g. a cross-language
 * question (Arabic query, English material, no embeddings) or BM25 floor
 * rejections on tiny corpora — but the course has processed chunks, fall
 * back to a broad spread of the course's OWN authorized chunks so the model
 * sees the real material instead of answering "(no material)" from general
 * knowledge. The same course/materialIds scoping as the scored path applies;
 * fallback excerpts are flagged via `weakEvidence` so prompts can require
 * the model not to treat them as proof of coverage.
 */
export async function buildRagContextWithFallback(
  client: SupabaseClient,
  courseId: string,
  query: string,
  limit = 8,
  materialIds?: string[],
  fallbackLimit = 8,
): Promise<RagResult> {
  const scored = await buildRagContext(client, courseId, query, limit, materialIds);
  if (scored.context.trim()) return scored;
  const broad = await buildBroadContext(client, courseId, fallbackLimit, materialIds);
  if (!broad.context.trim()) return { context: '', citations: [], weakEvidence: false };
  return { ...broad, weakEvidence: true };
}
