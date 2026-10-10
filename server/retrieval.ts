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
  /** Present when the context came from buildBroadContext. */
  coverage?: CoverageMeta;
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
const BROAD_FETCH_CAP = 600;

export interface CoverageMeta {
  /** Eligible chunks visible to this request (after materialIds filtering). */
  chunksFound: number;
  chunksSelected: number;
  /** Characters actually sent to the model (after per-chunk truncation). */
  charsSelected: number;
  /** Raw characters available in the eligible chunks. */
  charsAvailable: number;
  truncatedChunks: number;
  /** Characters lost to per-chunk truncation. */
  truncatedChars: number;
  /** Chunk-count limit stopped selection while eligible chunks remained. */
  cappedByChunks: boolean;
  /** Character budget stopped selection while eligible chunks remained. */
  cappedByChars: boolean;
  /** The fetch cap excluded eligible chunks from consideration. */
  cappedByFetch: boolean;
  /** Every eligible chunk was included without truncation. This means
   * "all available sections were sent" — NOT that the course's knowledge
   * has been fully understood or verified. */
  complete: boolean;
}

const emptyCoverage = (): CoverageMeta => ({
  chunksFound: 0, chunksSelected: 0, charsSelected: 0, charsAvailable: 0,
  truncatedChunks: 0, truncatedChars: 0,
  cappedByChunks: false, cappedByChars: false, cappedByFetch: false,
  complete: false,
});

/**
 * Deterministic, spread-aware pick order for one material.
 *
 * Selects k indices evenly spread across the material's n chunks (ordered by
 * id), so long documents contribute their beginning, middle, and end instead
 * of only the first chunks. Deterministic: same chunks → same selection.
 */
function stratifiedIndices(n: number, k: number): number[] {
  if (k <= 0 || n <= 0) return [];
  if (k === 1) return [0];
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  const idx: number[] = [];
  for (let j = 0; j < k; j++) idx.push(Math.round((j * (n - 1)) / (k - 1)));
  return [...new Set(idx)];
}

/**
 * Course/material-level retrieval for summary requests.
 *
 * Summary intents ("لخّصلي المادة", "summarize this course") are not semantic
 * lookups: the query words never appear in the material, so query-scored
 * retrieval legitimately returns nothing (and with no embedding model the
 * keyword-only scores are all zero). This fetches a representative,
 * ownership-respecting spread of chunks across the authorized materials —
 * stratified per material (beginning/middle/end of long documents) and
 * round-robined across materials so no single file dominates — and truncates
 * to a bounded character budget. No scoring, no relevance floor: every
 * selected chunk is real course content.
 *
 * Returns coverage metadata so callers can disclose partial coverage instead
 * of presenting a sample as a complete course summary.
 */
export async function buildBroadContext(
  client: SupabaseClient,
  courseId: string,
  limit = 24,
  materialIds?: string[],
): Promise<{ context: string; citations: Citation[]; coverage: CoverageMeta }> {
  const coverage = emptyCoverage();
  let q = client
    .from('chunks')
    .select('id, material_id, content, page_number')
    .eq('course_id', courseId)
    .order('material_id')
    .order('id')
    .limit(BROAD_FETCH_CAP);
  if (materialIds && materialIds.length > 0) q = q.in('material_id', materialIds);
  const { data: chunks, error } = await q;
  if (error || !chunks || chunks.length === 0) return { context: '', citations: [], coverage };

  // When the fetch cap is hit, run a bounded count query so the coverage
  // disclosure can report excluded content instead of silently ignoring it.
  let found = chunks.length;
  if (chunks.length >= BROAD_FETCH_CAP) {
    let cq = client.from('chunks').select('id', { count: 'exact', head: true }).eq('course_id', courseId);
    if (materialIds && materialIds.length > 0) cq = cq.in('material_id', materialIds);
    const { count } = await cq;
    coverage.chunksFound = count ?? chunks.length;
    coverage.cappedByFetch = (count ?? chunks.length) > BROAD_FETCH_CAP;
  } else {
    coverage.chunksFound = found;
  }
  found = coverage.chunksFound;
  coverage.charsAvailable = chunks.reduce((s: number, c: any) => s + c.content.length, 0);

  // Per-material stratified pick orders with FAIR QUOTAS: quota turns are
  // distributed round-robin over materials first, so when the chunk limit
  // binds, every file keeps its fair share AND its picks span the file's
  // full length (beginning/middle/end) instead of the spread being cut at
  // the tail. Deterministic: same chunks → same selection.
  const byMaterial = new Map<string, RetrievedChunk[]>();
  for (const c of chunks) {
    const list = byMaterial.get(c.material_id) || [];
    list.push({ id: c.id, material_id: c.material_id, content: c.content, score: 0, page_number: c.page_number ?? null });
    byMaterial.set(c.material_id, list);
  }
  const orders = [...byMaterial.values()];
  const quotas = orders.map(() => 0);
  {
    let left = limit;
    for (;;) {
      let gave = false;
      for (let mi = 0; mi < orders.length && left > 0; mi++) {
        if (quotas[mi] < orders[mi].length) { quotas[mi]++; left--; gave = true; }
      }
      if (!gave) break;
    }
  }
  const queues = orders.map((o, mi) => stratifiedIndices(o.length, quotas[mi]).map((i) => o[i]));
  // Adaptive per-chunk allowance: few chunks → show each more fully, always
  // inside the same total budget. Explicit bounds keep it predictable.
  const perChunkCap = Math.min(3_000, Math.max(800, Math.floor(BROAD_MAX_CHARS / Math.max(1, Math.min(found, limit)))));

  const picked: RetrievedChunk[] = [];
  let budget = BROAD_MAX_CHARS;
  let stoppedByBudget = false;
  outer: for (let round = 0; ; round++) {
    let any = false;
    for (const queue of queues) {
      const next = queue[round];
      if (!next) continue;
      any = true;
      if (picked.length >= limit || budget - perChunkCap < 0) { stoppedByBudget = picked.length < limit; break outer; }
      const truncated = next.content.length > perChunkCap;
      const content = truncated ? next.content.slice(0, perChunkCap).trimEnd() + '…' : next.content;
      if (truncated) { coverage.truncatedChunks++; coverage.truncatedChars += next.content.length - perChunkCap; }
      budget -= content.length;
      picked.push({ ...next, content });
    }
    if (!any) break;
  }
  coverage.chunksSelected = picked.length;
  coverage.charsSelected = picked.reduce((s, c) => s + c.content.length, 0);
  coverage.cappedByChunks = picked.length >= limit && orders.some((o, mi) => o.length > quotas[mi]);
  coverage.cappedByChars = stoppedByBudget && picked.length < limit;
  coverage.complete =
    found > 0 && !coverage.cappedByFetch && !coverage.cappedByChunks && !coverage.cappedByChars &&
    coverage.truncatedChars === 0 && picked.length === found;

  if (picked.length === 0) return { context: '', citations: [], coverage };
  const nameById = await materialsNames(client, [...new Set(picked.map((c) => c.material_id))]);
  return { ...renderContext(picked, nameById), coverage };
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
  return { context: broad.context, citations: broad.citations, weakEvidence: true, coverage: broad.coverage };
}
