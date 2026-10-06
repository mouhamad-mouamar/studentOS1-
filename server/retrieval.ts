import type { SupabaseClient } from '@supabase/supabase-js';
import { embed, cosineSimilarity } from './ai';

export interface RetrievedChunk {
  id: string;
  material_id: string;
  content: string;
  score: number;
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
): Promise<RetrievedChunk[]> {
  const { data: chunks, error } = await client
    .from('chunks')
    .select('id, material_id, content, embedding')
    .eq('course_id', courseId)
    .limit(2000);
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
    return { id: c.id, material_id: c.material_id, content: c.content, score: sem + keywordScore(i) / 12 };
  });

  const anySemantic = qVec && chunks.some((c: any) => Array.isArray(c.embedding) && c.embedding.length > 0);
  const minScore = anySemantic ? 0.15 : 0.2;
  return scored
    .filter((s) => s.score > minScore)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit);
}

export async function buildRagContext(
  client: SupabaseClient,
  courseId: string,
  query: string,
  limit = 8,
): Promise<{ context: string; citations: { chunkId: string; materialId: string }[] }> {
  const chunks = await retrieveChunks(client, courseId, query, limit);
  const matIds = [...new Set(chunks.map((c) => c.material_id))];
  const nameById = new Map<string, string>();
  if (matIds.length) {
    const { data: mats } = await client.from('materials').select('id, filename').in('id', matIds);
    for (const m of mats || []) nameById.set(m.id, m.filename);
  }
  const parts = chunks.map((c, i) => `[${i + 1}] (source: ${nameById.get(c.material_id) || 'material'})\n${c.content}`);
  return {
    context: parts.join('\n\n---\n\n'),
    citations: chunks.map((c) => ({ chunkId: c.id, materialId: c.material_id, source: nameById.get(c.material_id) || 'material' })),
  };
}
