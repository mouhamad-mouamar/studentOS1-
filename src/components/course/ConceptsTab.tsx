import { useState } from 'react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Badge, Button, Card, Empty, ErrorNote, Spinner } from '../ui';

const PRIORITY_KEY: Record<string, string> = {
  MUST_KNOW: 'mustKnow',
  SHOULD_KNOW: 'shouldKnow',
  NICE_TO_KNOW: 'niceToKnow',
  LOW_PRIORITY: 'lowPriority',
};

export function ConceptsTab({ courseId }: { courseId: string }) {
  const { t } = useI18n();
  const [concepts, setConcepts] = useState<any[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteDone, setNoteDone] = useState<string | null>(null);

  if (concepts === null) {
    api<{ concepts: any[] }>(`/courses/${courseId}/concepts`)
      .then((d) => setConcepts(d.concepts))
      .catch((e) => setError(e.message));
  }

  const genNotes = async (conceptId: string) => {
    setBusyId(conceptId);
    setError(null);
    setNoteDone(null);
    try {
      await api(`/courses/${courseId}/concepts/${conceptId}/notes`, { method: 'POST' });
      setNoteDone(conceptId);
    } catch (e: any) {
      setError(e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message);
    } finally {
      setBusyId(null);
    }
  };

  if (concepts === null && !error) return <Spinner label={t.loading} />;
  if (concepts?.length === 0) return <Empty title={t.empty} hint={t.noCoursesHint} />;

  return (
    <div className="space-y-3">
      {error && <ErrorNote>{error}</ErrorNote>}
      {noteDone && <div className="rounded-xl bg-green-50 px-4 py-2 text-sm text-green-700">{t.generateNotes} ✓</div>}
      {(concepts || []).map((c) => (
        <Card key={c.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-medium text-slate-900">{c.title}</h3>
              {c.summary && <p className="mt-1 text-sm text-slate-600">{c.summary}</p>}
              {c.definition && <p className="mt-1 text-sm text-slate-500 italic">{c.definition}</p>}
              {c.professor_emphasis && (
                <p className="mt-2 text-xs font-medium text-purple-700">
                  ★ {t.professorEmphasis}
                  {c.emphasis_phrases?.length ? ` — ${c.emphasis_phrases.slice(0, 2).join(' · ')}` : ''}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <Badge tone={c.priority}>{t[PRIORITY_KEY[c.priority] as keyof typeof t] as string || c.priority}</Badge>
              <span className="text-xs text-slate-400">score {c.importance_score}</span>
              {c.mastery != null && (
                <span className={`text-xs font-medium ${c.mastery_state === 'mastered' ? 'text-green-600' : c.mastery_state === 'review' ? 'text-sky-600' : 'text-amber-600'}`}>
                  {c.mastery}% {c.mastery_state}
                  {c.quiz_accuracy != null ? ` · ${c.quiz_accuracy}% quiz` : ''}
                </span>
              )}
              {c.weakness_score != null && c.weakness_score > 0 && <span className="text-xs font-medium text-red-500">weak {c.weakness_score}/100</span>}
            </div>
          </div>
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={() => genNotes(c.id)} disabled={busyId === c.id}>
              {busyId === c.id ? t.processing : t.generateNotes}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
