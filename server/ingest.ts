import type { SupabaseClient } from '@supabase/supabase-js';
import { extractText, chunkText, findEmphasis, detectKind, downloadMaterial } from './extract';
import { embed, chatJson } from './ai';

interface ConceptExtract {
  title: string;
  summary: string;
  definition?: string;
  importance: number;
  formulas?: { name: string; expression: string; explanation?: string }[];
}

export async function processMaterial(client: SupabaseClient, materialId: string): Promise<void> {
  const { data: mat, error } = await client.from('materials').select('*').eq('id', materialId).maybeSingle();
  if (error || !mat) return;

  await client.from('materials').update({ status: 'processing', error: null }).eq('id', materialId);
  try {
    const kind = mat.kind || detectKind(mat.filename, mat.mime);
    const buf = await downloadMaterial(client, mat.storage_path);
    const { text, note } = await extractText(kind, buf);

    if (!text.trim()) {
      await client
        .from('materials')
        .update({ status: 'failed', error: note || 'EXTRACTION_EMPTY' })
        .eq('id', materialId);
      return;
    }

    const chunks = chunkText(text);
    let embeddings: number[][] | null = null;
    try {
      embeddings = await embed(chunks);
    } catch {
      embeddings = null; // keyword retrieval still works
    }

    // Replace any previous chunks for this material (re-process case).
    await client.from('chunks').delete().eq('material_id', materialId);
    const rows = chunks.map((content, idx) => ({
      user_id: mat.user_id,
      course_id: mat.course_id,
      material_id: materialId,
      idx,
      content,
      embedding: embeddings ? embeddings[idx] : null,
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const { error: e } = await client.from('chunks').insert(rows.slice(i, i + 100));
      if (e) throw new Error(`Chunk insert failed: ${e.message}`);
    }

    // Professor emphasis scan (deterministic, provider-independent).
    const emphasis = findEmphasis(text);
    const emphasisSentences = emphasis.map((e) => e.sentence);

    // AI concept extraction — skips gracefully when no provider is configured.
    let concepts: ConceptExtract[] = [];
    try {
      const excerpt = text.slice(0, 24_000);
      const result = await chatJson<{ concepts: ConceptExtract[] }>(
        'You are an academic content analyzer for university course material. Extract the distinct academic concepts present in the material. Respond in JSON: {"concepts":[{"title","summary","definition","importance":0-100,"formulas":[{"name","expression","explanation"}]}]}. importance reflects how central the concept is to this material. Extract only real formulas/definitions found in the content. No invented content. Limit to the 20 most important concepts.',
        excerpt,
      );
      concepts = (result.concepts || []).filter((c) => c.title).slice(0, 20);
    } catch (err: any) {
      if (err?.message !== 'AI_NOT_CONFIGURED') {
        // Provider configured but call failed: keep going, material is still usable.
        console.error('Concept extraction failed:', err?.message);
      }
    }

    for (const c of concepts) {
      const emphasisHits = emphasisSentences.filter((s) => c.title && s.toLowerCase().includes(c.title.toLowerCase()));
      const hasEmphasis = c.importance >= 85 || emphasisHits.length > 0 || /important|exam|remember|key/i.test(c.summary || '');
      const { data: inserted, error: cErr } = await client
        .from('concepts')
        .upsert(
          {
            user_id: mat.user_id,
            course_id: mat.course_id,
            material_id: materialId,
            title: c.title.slice(0, 200),
            summary: c.summary || null,
            definition: c.definition || null,
            importance_score: Math.max(0, Math.min(100, Math.round(c.importance || 50))),
            professor_emphasis: hasEmphasis,
            emphasis_phrases: emphasisHits.slice(0, 5),
          },
          { onConflict: 'course_id,title' },
        )
        .select('id')
        .maybeSingle();
      if (cErr) continue;
      for (const f of c.formulas || []) {
        if (!f.name || !f.expression) continue;
        await client.from('formulas').insert({
          user_id: mat.user_id,
          course_id: mat.course_id,
          concept_id: inserted?.id || null,
          name: f.name.slice(0, 200),
          expression: f.expression.slice(0, 500),
          explanation: f.explanation || null,
        });
      }
    }

    // If emphasis sentences exist but AI produced no concept matching them, flag top keyword overlap.
    if (concepts.length === 0 && emphasis.length > 0) {
      await client
        .from('materials')
        .update({ status: 'ready', char_count: text.length, error: `EMPHASIS_ONLY:${emphasis.length}` })
        .eq('id', materialId);
      return;
    }

    await client.from('materials').update({ status: 'ready', char_count: text.length, error: null }).eq('id', materialId);
  } catch (err: any) {
    console.error('Ingestion failed for', materialId, err?.message);
    await client.from('materials').update({ status: 'failed', error: (err?.message || 'FAILED').slice(0, 300) }).eq('id', materialId);
  }
}
