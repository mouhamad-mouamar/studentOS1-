import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Badge, Button, Card, ErrorNote, Icon, Markdownish, Skeleton } from '../ui';

const LEVELS = ['full', 'study', 'quick', 'cram'] as const;
type Level = (typeof LEVELS)[number];

const MINUTES_OPTIONS = [30, 60, 90];

interface SummaryConcept {
  id: string;
  title: string;
  summary: string | null;
  priority: string;
  professor_emphasis: boolean;
  mentioned_in_exams: number;
  mastery: number | null;
  mastery_state: string;
  weakness_score: number | null;
}

interface Summary {
  level: Level;
  overview: string;
  must_know: SummaryConcept[];
  should_know: SummaryConcept[];
  topics: SummaryConcept[];
  definitions: { title: string; definition: string }[];
  formulas: { name: string; expression: string; explanation: string | null; concept: string | null }[];
  exam_relevant: { title: string; evidence: string[] }[];
  commonly_confused: { a: string; b: string; note: string }[];
  what_to_remember: string;
  sources: { material_id: string; filename: string; concepts: string[] }[];
  meta: { concepts_total: number; materials_total: number; exam_date: string | null; exam_days_away: number | null; due_cards: number; ai_analyzed: boolean };
}

interface WhatMatters {
  items: { conceptId: string; title: string; priority: string; score: number; reasons: string[] }[];
  due_cards: number;
  minutes_per_concept: number;
}

function ConceptRow({ c }: { c: SummaryConcept }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{c.title}</p>
        {c.summary && <p className="mt-0.5 truncate text-sm text-slate-500">{c.summary}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
          {c.professor_emphasis && <span className="rounded bg-violet-50 px-1.5 py-0.5 font-medium text-violet-600">professor emphasis</span>}
          {c.mentioned_in_exams > 0 && <span className="rounded bg-orange-50 px-1.5 py-0.5 font-medium text-orange-600">in past exams ×{c.mentioned_in_exams}</span>}
          {c.weakness_score != null && c.weakness_score >= 25 && <span className="rounded bg-red-50 px-1.5 py-0.5 font-medium text-red-600">weak</span>}
        </div>
      </div>
      {c.mastery != null && (
        <span className="shrink-0 text-xs text-slate-400" title={`${c.mastery}% mastery`}>
          {c.mastery}%
        </span>
      )}
    </div>
  );
}

export function OverviewTab({ courseId }: { courseId: string }) {
  const { t } = useI18n();
  const [level, setLevel] = useState<Level>('study');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaries, setSummaries] = useState<Partial<Record<Level, Summary>>>({});
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(60);
  const [matters, setMatters] = useState<WhatMatters | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeNote, setAnalyzeNote] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askCitations, setAskCitations] = useState<any[]>([]);
  const [askError, setAskError] = useState<string | null>(null);
  const [guide, setGuide] = useState<any | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairNote, setRepairNote] = useState<string | null>(null);

  // Materials uploaded and processed, but concepts were never extracted
  // (e.g. the AI provider was rate-limited at upload time): the Analysis
  // area can offer an honest repair instead of a bare empty state.
  const needsAnalysis =
    (summary?.meta.materials_total ?? 0) > 0 && (summary?.meta.concepts_total ?? 0) === 0;

  const loadSummary = async (lv: Level) => {
    const cached = summaries[lv];
    if (cached) {
      setSummary(cached);
      return;
    }
    setSummary(null);
    setSummaryError(null);
    try {
      const d = await api<{ summary: Summary }>(`/courses/${courseId}/summary?level=${lv}`);
      setSummary(d.summary);
      setSummaries((s) => ({ ...s, [lv]: d.summary }));
    } catch (e: any) {
      setSummaryError(e.message);
    }
  };

  useEffect(() => {
    loadSummary(level);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, courseId]);

  useEffect(() => {
    setMatters(null);
    api<WhatMatters>(`/courses/${courseId}/what-matters?minutes=${minutes}`)
      .then(setMatters)
      .catch(() => setMatters({ items: [], due_cards: 0, minutes_per_concept: minutes }));
  }, [courseId, minutes]);

  const deepAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeNote(null);
    try {
      await api(`/courses/${courseId}/analyze`, { method: 'POST' });
      setSummaries({});
      await loadSummary(level);
      setAnalyzeNote(t.analyzedWith);
    } catch (e: any) {
      setAnalyzeNote(e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const ask = async (q?: string) => {
    const query = (q ?? question).trim();
    if (!query) return;
    setAskBusy(true);
    setAskError(null);
    setAskAnswer(null);
    setAskCitations([]);
    try {
      const d = await api<{ answer: string; citations?: any[] }>(`/courses/${courseId}/ask`, { method: 'POST', body: { question: query } });
      setAskAnswer(d.answer);
      setAskCitations(d.citations || []);
    } catch (e: any) {
      setAskError(e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message);
    } finally {
      setAskBusy(false);
    }
  };

  // One-click repair for courses whose materials never got analyzed.
  const runRepair = async () => {
    setRepairBusy(true);
    setRepairNote(null);
    try {
      const r = await api<{ processed: number; remaining: number; extracted_any: boolean }>(`/courses/${courseId}/reextract`, { method: 'POST' });
      if (r.extracted_any) {
        setRepairNote(r.remaining > 0 ? t.analysisRemaining.replace('{n}', String(r.remaining)) : t.analysisDone.replace('{n}', String(r.processed)));
        setSummaries({});
        setSummary(null);
        await loadSummary(level);
        setMatters(null);
        api<WhatMatters>(`/courses/${courseId}/what-matters?minutes=${minutes}`)
          .then(setMatters)
          .catch(() => setMatters({ items: [], due_cards: 0, minutes_per_concept: minutes }));
      } else {
        setRepairNote(t.empty);
      }
    } catch (e: any) {
      setRepairNote(e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message);
    } finally {
      setRepairBusy(false);
    }
  };

  const loadGuide = async () => {
    setGuideBusy(true);
    setGuideError(null);
    try {
      const d = await api<{ guide: any }>(`/courses/${courseId}/study-guide`);
      setGuide(d.guide);
    } catch (e: any) {
      setGuideError(e.message);
    } finally {
      setGuideBusy(false);
    }
  };

  const levelLabel: Record<Level, string> = {
    full: t.fullAnalysis,
    study: t.studySummary,
    quick: t.quickSummary,
    cram: t.examCram,
  };

  return (
    <div className="space-y-5">
      {/* One-click study guide */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-gradient-to-br from-violet-50 to-white px-5 py-4">
          <div>
            <h3 className="font-semibold text-slate-900">{t.studyGuide}</h3>
            <p className="mt-0.5 text-sm text-slate-500">{t.studyGuideHint}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={loadGuide} disabled={guideBusy}>
            {guideBusy ? t.processing : `✨ ${t.generateGuide}`}
          </Button>
        </div>
        {guideError && <div className="p-5"><ErrorNote>{guideError}</ErrorNote></div>}
        {guide && !guideError && (
          <div className="space-y-4 p-5">
            {guide.what_to_remember && (
              <section className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-500">{t.whatToRemember}</h4>
                <p className="mt-1 text-sm leading-relaxed text-slate-700">{guide.what_to_remember}</p>
              </section>
            )}
            {guide.must_know?.length > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t.mustKnow}</h4>
                <ul className="space-y-1.5">
                  {guide.must_know.map((c: any) => (
                    <li key={c.id} className="text-sm text-slate-700">
                      <span className="font-medium">{c.title}</span>
                      {c.summary && <span className="text-slate-500"> — {c.summary}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {guide.formulas?.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  {t.formulas} ({guide.formulas.length})
                </summary>
                <div className="mt-2 space-y-2">
                  {guide.formulas.map((f: any) => (
                    <div key={f.name} className="rounded-xl bg-slate-50 px-4 py-2.5">
                      <p className="text-sm font-medium text-slate-800">
                        {f.name} <code className="ms-1 rounded bg-white px-1.5 py-0.5 font-mono text-xs text-indigo-700">{f.expression}</code>
                      </p>
                      {f.explanation && <p className="mt-0.5 text-sm text-slate-500">{f.explanation}</p>}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {guide.commonly_confused?.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  {t.confusions} ({guide.commonly_confused.length})
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {guide.commonly_confused.map((p: any, i: number) => (
                    <li key={i} className="text-sm text-slate-700">
                      <span className="font-medium">{p.a}</span> ↔ <span className="font-medium">{p.b}</span>
                      {p.note && <span className="text-slate-500"> — {p.note}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {guide.self_test?.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  {t.selfTest} ({guide.self_test.length})
                </summary>
                <ol className="mt-2 space-y-2">
                  {guide.self_test.map((q: any, i: number) => (
                    <li key={i} className="rounded-xl bg-slate-50 px-4 py-2.5">
                      <p className="text-sm font-medium text-slate-800">{i + 1}. {q.question}</p>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-indigo-600">{t.answer}</summary>
                        <p className="mt-1 text-sm text-slate-600">{q.answer}</p>
                      </details>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {guide.review_next?.length > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t.reviewNext}</h4>
                <ul className="space-y-1">
                  {guide.review_next.map((w: any, i: number) => (
                    <li key={i} className="text-sm text-slate-700">• {w.title}</li>
                  ))}
                </ul>
              </section>
            )}
            {!guide.what_to_remember && (guide.must_know?.length || 0) === 0 && (guide.self_test?.length || 0) === 0 && (
              <p className="text-sm text-slate-500">{t.empty}</p>
            )}
          </div>
        )}
      </Card>

      {/* What actually matters */}
      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 bg-gradient-to-br from-indigo-50 to-white px-5 py-4">
          <h3 className="font-semibold text-slate-900">{t.whatMatters}</h3>
          <p className="mt-0.5 text-sm text-slate-500">{t.ifYouHave(minutes)}</p>
          <div className="mt-3 flex gap-1.5">
            {MINUTES_OPTIONS.map((m) => (
              <button
                key={m}
                onClick={() => setMinutes(m)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${minutes === m ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'}`}
              >
                {m} min
              </button>
            ))}
          </div>
        </div>
        <div className="divide-y divide-slate-100">
          {!matters ? (
            <div className="space-y-3 px-5 py-5">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : matters.items.length === 0 ? (
            needsAnalysis ? (
              <div className="px-5 py-5">
                <p className="text-sm font-medium text-slate-700">{t.notAnalyzedTitle}</p>
                <p className="mt-1 text-sm text-slate-500">{t.notAnalyzedHint}</p>
                {repairNote && <p className="mt-2 text-xs text-slate-500">{repairNote}</p>}
                <Button size="sm" variant="secondary" className="mt-3" onClick={runRepair} disabled={repairBusy}>
                  {repairBusy ? t.processing : `✨ ${t.runAnalysis}`}
                </Button>
              </div>
            ) : (
              <p className="px-5 py-6 text-sm text-slate-500">{t.empty}</p>
            )
          ) : (
            matters.items.map((item, i) => (
              <div key={item.conceptId} className="flex items-start gap-3 px-5 py-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-bold text-indigo-600">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-slate-900">{item.title}</p>
                    <Badge tone={item.priority}>{item.priority.replace('_', ' ')}</Badge>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {item.reasons.map((r, j) => (
                      <li key={j} className="text-xs text-slate-500">• {r}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))
          )}
          {matters && matters.items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-5 py-2.5 text-xs text-slate-500">
              <span>{t.minutesEach(matters.minutes_per_concept)}</span>
              {matters.due_cards > 0 && <span className="font-medium text-indigo-600">{matters.due_cards} {t.dueCards}</span>}
            </div>
          )}
        </div>
      </Card>

      {/* Summary with level switcher */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          <div className="flex flex-wrap gap-1.5">
            {LEVELS.map((lv) => (
              <button
                key={lv}
                onClick={() => setLevel(lv)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${level === lv ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {levelLabel[lv]}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={deepAnalyze} disabled={analyzing}>
            {analyzing ? t.processing : summary?.meta.ai_analyzed ? `✓ ${t.analyzedWith}` : `✨ ${t.deepAnalysis}`}
          </Button>
        </div>
        {analyzeNote && <div className="px-5 pt-3"><p className="text-xs text-slate-500">{analyzeNote}</p></div>}
        {summaryError ? (
          <div className="p-5"><ErrorNote>{summaryError}</ErrorNote></div>
        ) : !summary ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-16" />
            <Skeleton className="h-5 w-1/4" />
            <Skeleton className="h-28" />
          </div>
        ) : (
          <div className="space-y-5 p-5">
            {/* Overview */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t.courseAbout}</h4>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-700">{summary.overview}</p>
            </section>

            {/* What to remember */}
            {summary.what_to_remember && (
              <section className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-500">{t.whatToRemember}</h4>
                <p className="mt-1 text-sm leading-relaxed text-slate-700">{summary.what_to_remember}</p>
              </section>
            )}

            {/* MUST KNOW */}
            {summary.must_know.length > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">MUST KNOW</h4>
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  {summary.must_know.map((c) => <ConceptRow key={c.id} c={c} />)}
                </div>
              </section>
            )}

            {/* SHOULD KNOW */}
            {summary.should_know.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  SHOULD KNOW ({summary.should_know.length})
                </summary>
                <div className="mt-2 overflow-hidden rounded-xl border border-slate-200">
                  {summary.should_know.map((c) => <ConceptRow key={c.id} c={c} />)}
                </div>
              </details>
            )}

            {/* Definitions */}
            {summary.definitions.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  {t.keyDefinitions} ({summary.definitions.length})
                </summary>
                <dl className="mt-2 space-y-2">
                  {summary.definitions.map((d) => (
                    <div key={d.title} className="rounded-xl bg-slate-50 px-4 py-2.5">
                      <dt className="text-sm font-medium text-slate-800">{d.title}</dt>
                      <dd className="mt-0.5 text-sm text-slate-600">{d.definition}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}

            {/* Formulas */}
            {summary.formulas.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  {t.formulas} ({summary.formulas.length})
                </summary>
                <div className="mt-2 space-y-2">
                  {summary.formulas.map((f) => (
                    <div key={f.name} className="rounded-xl bg-slate-50 px-4 py-2.5">
                      <p className="text-sm font-medium text-slate-800">
                        {f.name} <code className="ms-1 rounded bg-white px-1.5 py-0.5 font-mono text-xs text-indigo-700">{f.expression}</code>
                      </p>
                      {f.explanation && <p className="mt-0.5 text-sm text-slate-500">{f.explanation}</p>}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Exam relevant */}
            {summary.exam_relevant.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  {t.examRelevant} ({summary.exam_relevant.length})
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {summary.exam_relevant.map((e) => (
                    <li key={e.title} className="text-sm text-slate-700">
                      <span className="font-medium">{e.title}</span>
                      <span className="text-slate-500"> — {e.evidence.join(' · ')}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {/* Commonly confused (AI analysis only) */}
            {summary.commonly_confused.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  {t.commonlyConfused} ({summary.commonly_confused.length})
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {summary.commonly_confused.map((p, i) => (
                    <li key={i} className="text-sm text-slate-700">
                      <span className="font-medium">{p.a}</span> ↔ <span className="font-medium">{p.b}</span>
                      {p.note && <span className="text-slate-500"> — {p.note}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {/* Sources */}
            {summary.sources.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
                  {t.sources} ({summary.sources.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {summary.sources.map((s) => (
                    <li key={s.material_id} className="truncate text-sm text-slate-600">
                      📄 {s.filename}
                      {s.concepts.length > 0 && <span className="text-slate-400"> — {s.concepts.slice(0, 3).join(', ')}{s.concepts.length > 3 ? '…' : ''}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Card>

      {/* Ask my course */}
      <Card className="p-5">
        <h3 className="font-semibold text-slate-900">{t.askMine}</h3>
        <p className="mt-0.5 text-xs text-slate-400">{t.askHint}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            placeholder={t.askPlaceholder}
            className="flex-1"
          />
          <Button onClick={() => ask()} disabled={askBusy || !question.trim()}>{askBusy ? t.processing : t.send}</Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[
            'What are the most important topics?',
            'What formulas do I need to know?',
            'What am I weak at?',
            'If I have 30 minutes, what should I study?',
          ].map((q) => (
            <button
              key={q}
              onClick={() => { setQuestion(q); ask(q); }}
              disabled={askBusy}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 transition-colors hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>
        {askError && <div className="mt-3"><ErrorNote>{askError}</ErrorNote></div>}
        {askAnswer && (
          <div className="mt-3 rounded-xl bg-slate-50 px-4 py-3">
            <Markdownish text={askAnswer} />
            {askCitations.length > 0 && (
              <details className="mt-2 border-t border-slate-200 pt-2">
                <summary className="cursor-pointer select-none text-xs font-medium text-slate-400 hover:text-slate-600">
                  {t.evidence} ({askCitations.length})
                </summary>
                <ul className="mt-1.5 space-y-1.5">
                  {askCitations.map((c: any, j: number) => (
                    <li key={c.chunkId || j} className="rounded-lg bg-white px-2.5 py-1.5">
                      <span className="text-xs font-semibold text-indigo-600">[{j + 1}]</span>{' '}
                      <span className="text-xs font-medium text-slate-600">{c.source || 'material'}</span>
                      {typeof c.page === 'number' && <span className="text-xs text-slate-400"> · {t.page} {c.page}</span>}
                      {c.snippet && <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-slate-500">{c.snippet}</p>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
