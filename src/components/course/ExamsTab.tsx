import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Badge, Button, Card, Empty, ErrorNote, Icon, Skeleton } from '../ui';

export function ExamsTab({ courseId }: { courseId: string }) {
  const { t, lang } = useI18n();
  const [exams, setExams] = useState<any[] | null>(null);
  const [activeExam, setActiveExam] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api<{ exams: any[] }>(`/courses/${courseId}/exams`).then((d) => setExams(d.exams)).catch(() => setExams([]));
  useEffect(() => {
    load();
  }, [courseId]);

  const analyze = async () => {
    setBusy('analyze');
    setError(null);
    try {
      await api(`/courses/${courseId}/exams/analyze-past`, { method: 'POST', body: { lang } });
      await load();
    } catch (e: any) {
      setError(e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message);
    } finally {
      setBusy(null);
    }
  };

  const simulate = async () => {
    setBusy('simulate');
    setError(null);
    try {
      const { exam } = await api<{ exam: any }>(`/courses/${courseId}/exams/simulate`, { method: 'POST', body: { count: 8, lang } });
      await load();
      setActiveExam(exam.id);
    } catch (e: any) {
      setError(e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message);
    } finally {
      setBusy(null);
    }
  };

  if (!exams) return <Skeleton className="h-64 rounded-2xl" />;

  if (activeExam) {
    const exam = exams.find((e) => e.id === activeExam);
    if (exam) return <ExamRunner examId={exam.id} title={exam.title} onDone={() => { setActiveExam(null); load(); }} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button onClick={analyze} disabled={busy === 'analyze'}>
          {busy === 'analyze' ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              {t.processing}
            </>
          ) : (
            <>
              <Icon name="target" className="h-4 w-4" />
              {t.analyzePast}
            </>
          )}
        </Button>
        <Button variant="secondary" onClick={simulate} disabled={busy === 'simulate'}>
          {busy === 'simulate' ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-slate-600" />
              {t.processing}
            </>
          ) : (
            <>
              <Icon name="sparkles" className="h-4 w-4" />
              {t.simulateExam}
            </>
          )}
        </Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {exams.length === 0 ? (
        <Empty title={t.empty} hint="Upload past exams in Materials (mark them as past exams), then analyze them here." icon="calendar" />
      ) : (
        <div className="stagger space-y-3">
          {exams.map((e) => (
            <Card key={e.id} className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-medium text-slate-900">{e.title}</h3>
                <Badge tone={e.kind === 'past' ? 'NICE_TO_KNOW' : 'SHOULD_KNOW'}>{e.kind}</Badge>
              </div>
              {e.kind === 'past' && e.analysis && (
                <div className="mt-3 space-y-2 text-sm">
                  {e.analysis.frequent_topics?.length > 0 && (
                    <div>
                      <p className="font-medium text-slate-700">Frequently tested in the provided exams:</p>
                      <ul className="mt-1 space-y-1">
                        {e.analysis.frequent_topics.map((ft: any, i: number) => (
                          <li key={i} className="text-slate-600">
                            • {ft.topic} {ft.appearances ? `(${ft.appearances}×)` : ''} {ft.note ? `— ${ft.note}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {e.analysis.question_patterns?.length > 0 && (
                    <p className="text-slate-600">Patterns: {e.analysis.question_patterns.join(', ')}</p>
                  )}
                  {e.analysis.difficulty && <p className="text-slate-500">Difficulty: {e.analysis.difficulty}</p>}
                  {e.analysis.notes && <p className="text-slate-500">{e.analysis.notes}</p>}
                  {e.analysis.high_value_areas?.length > 0 && (
                    <p className="text-slate-600">High-value areas: {e.analysis.high_value_areas.join(', ')}</p>
                  )}
                </div>
              )}
              {e.kind === 'simulated' && (
                <div className="mt-3">
                  {e.status === 'ready' ? (
                    <Button size="sm" onClick={() => setActiveExam(e.id)}>{t.start}</Button>
                  ) : (
                    <p className="text-sm text-slate-600">
                      {t.score}: <strong>{e.score}/{e.total}</strong>
                    </p>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ExamRunner({ examId, title, onDone }: { examId: string; title: string; onDone: () => void }) {
  const { t } = useI18n();
  const [exam, setExam] = useState<any | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ exam: any }>(`/exams/${examId}`).then((d) => setExam(d.exam));
  }, [examId]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api<any>(`/exams/${examId}/submit`, { method: 'POST', body: { answers } });
      setResult(res);
    } finally {
      setBusy(false);
    }
  };

  if (!exam) return <Skeleton className="h-64 rounded-2xl" />;

  if (result) {
    return (
      <div className="space-y-4">
        <Card className="p-6 text-center">
          <p className="text-sm text-slate-500">{title}</p>
          <p className="animate-score-pop text-4xl font-bold text-slate-900">{result.score}/{result.total}</p>
          <Button className="mt-5" onClick={onDone}>{t.exams}</Button>
        </Card>
        {result.results.map((r: any, i: number) => (
          <Card key={i} className="p-4">
            <p className="text-sm font-medium">{r.correct ? '✓' : '✗'} {exam.questions?.[i]?.question}</p>
            {!r.correct && <p className="mt-1 text-sm text-slate-600">{t.correctAnswer}: <strong>{r.expected}</strong></p>}
            {r.explanation && <p className="mt-1 text-sm text-slate-500">{r.explanation}</p>}
          </Card>
        ))}
      </div>
    );
  }

  const questions = exam.questions || [];
  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      {questions.map((q: any, i: number) => (
        <Card key={i} className="p-4">
          <p className="text-sm font-medium text-slate-900">{i + 1}. {q.question}</p>
          {q.options ? (
            <div className="mt-3 space-y-2">
              {(q.options as string[]).map((opt, j) => (
                <label key={j} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input type="radio" name={`eq-${i}`} checked={answers[String(i)] === opt} onChange={() => setAnswers({ ...answers, [String(i)]: opt })} className="h-4 w-4" />
                  {opt}
                </label>
              ))}
            </div>
          ) : (
            <input className="mt-3" value={answers[String(i)] || ''} onChange={(e) => setAnswers({ ...answers, [String(i)]: e.target.value })} placeholder={t.yourAnswer} />
          )}
        </Card>
      ))}
      <Button onClick={submit} disabled={busy}>{busy ? t.processing : t.submit}</Button>
    </div>
  );
}
