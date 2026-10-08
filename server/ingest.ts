import type { SupabaseClient } from '@supabase/supabase-js';
import { extractText, chunkText, findEmphasis, detectKind, downloadMaterial } from './extract.js';
import { embed, chatJson, coerceItems } from './ai.js';

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
    const pageOf = (content: string): number | null => {
      // Page/slide markers emitted by extractText (PDF: [Page n], PPTX: [Slide n]).
      // A chunk spanning several pages takes the last marker it contains.
      let page: number | null = null;
      for (const m of content.matchAll(/(?:^|\n)\[(?:Page|Slide) (\d+)\]/g)) page = Number(m[1]);
      return page;
    };
    const rows = chunks.map((content, idx) => ({
      user_id: mat.user_id,
      course_id: mat.course_id,
      material_id: materialId,
      idx,
      content,
      embedding: embeddings ? embeddings[idx] : null,
      page_number: pageOf(content),
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const { error: e } = await client.from('chunks').insert(rows.slice(i, i + 100));
      if (e) throw new Error(`Chunk insert failed: ${e.message}`);
    }

    // Professor emphasis scan (deterministic, provider-independent).
    const emphasis = findEmphasis(text);
    const emphasisSentences = emphasis.map((e) => e.sentence);

    // AI concept extraction — skips gracefully when no provider is configured.
    // Concepts and formulas are extracted in SEPARATE passes: a small local
    // model handles one focused task per call far more reliably than a
    // combined concept+formula extraction (which tended to drop formulas).
    let concepts: ConceptExtract[] = [];
    try {
      const excerpt = text.slice(0, 24_000);
      const result = await chatJson<{ concepts: ConceptExtract[] }>(
        'You are an academic content analyzer for university course material. Extract the distinct academic concepts present in the material. Respond in JSON: {"concepts":[{"title","summary","definition","importance":0-100}]}. importance reflects how central the concept is to this material. No invented content. Limit to the 20 most important concepts.',
        excerpt,
        (p) => {
          // Shape-tolerant content guard: bare arrays, alternate keys, and a
          // single flat concept object are all recovered by coerceItems
          // downstream; only reject content-less output.
          const arr = Array.isArray(p)
            ? p
            : Array.isArray((p as any)?.concepts)
              ? (p as any).concepts
              : Array.isArray((p as any)?.items)
                ? (p as any).items
                : p && typeof p === 'object' && typeof (p as any).title === 'string'
                  ? [p]
                  : null;
          return !!arr && arr.some((c: any) => c && typeof c.title === 'string' && c.title.trim());
        },
        1400,
        ['title'],
      );
      concepts = (coerceItems(result, ['title']) || result.concepts || []).filter((c) => c.title).slice(0, 20);
    } catch (err: any) {
      if (err?.message !== 'AI_NOT_CONFIGURED') {
        // Provider configured but call failed: keep going, material is still usable.
        console.error('Concept extraction failed:', err?.message);
      }
    }

    // Dedicated formula extraction pass (AI only; failures keep material usable).
    let extractedFormulas: { name: string; expression: string; explanation?: string; concept_title?: string }[] = [];
    try {
      const excerpt = text.slice(0, 24_000);
      const fResult = await chatJson<{ formulas: { name: string; expression: string; explanation?: string; concept_title?: string }[] }>(
        'You extract mathematical and scientific formulas, rules, and key equations from university course material. Respond in JSON: {"formulas":[{"name":"short formula name","expression":"the exact formula as written in the material","explanation":"what the formula means","concept_title":"title of the related concept, or empty string"}]}. EVERY formula object MUST include both "name" and "expression". Extract only formulas that actually appear in the material. No invented content. Limit to 30 formulas.',
        excerpt,
        (p) => {
          const arr = Array.isArray(p)
            ? p
            : Array.isArray((p as any)?.formulas)
              ? (p as any).formulas
              : Array.isArray((p as any)?.items)
                ? (p as any).items
                : p && typeof p === 'object' && typeof (p as any).name === 'string'
                  ? [p]
                  : null;
          return !!arr && arr.some((f: any) => f && typeof f.name === 'string' && f.name.trim() && f.expression);
        },
        800,
        ['name'],
      );
      // coerceItems recovers the model's common wrong shapes (top-level array,
      // array under a different key such as the salvage path's "items") without
      // inventing content.
      const recovered = coerceItems(fResult, ['name', 'expression']) || (fResult as any)?.formulas || [];
      extractedFormulas = recovered.filter((f: any) => f?.name && f?.expression).slice(0, 30);
    } catch (err: any) {
      if (err?.message !== 'AI_NOT_CONFIGURED') {
        console.error('Formula extraction failed:', err?.message);
      }
    }

    const insertedConceptIds = new Map<string, string>();
    const seenExprs = new Set<string>();
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
      if (inserted?.id) insertedConceptIds.set(c.title.toLowerCase(), inserted.id);
      for (const f of c.formulas || []) {
        if (!f.name || !f.expression) continue;
        seenExprs.add(f.expression.toLowerCase().replace(/\s+/g, ''));
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

    // Insert formulas from the dedicated pass, linked to concepts where the
    // model's concept_title matches, and deduped against concept-payload
    // formulas by normalized expression.
    for (const f of extractedFormulas) {
      const key = f.expression.toLowerCase().replace(/\s+/g, '');
      if (seenExprs.has(key)) continue;
      seenExprs.add(key);
      await client.from('formulas').insert({
        user_id: mat.user_id,
        course_id: mat.course_id,
        concept_id: f.concept_title ? insertedConceptIds.get(String(f.concept_title).toLowerCase()) || null : null,
        name: f.name.slice(0, 200),
        expression: f.expression.slice(0, 500),
        explanation: f.explanation || null,
      });
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
