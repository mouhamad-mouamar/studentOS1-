import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Card, Empty, ErrorNote, Badge } from '../ui';

export function QuizzesTab({ courseId }: { courseId: string }) {
  const { t } = useI18n();
  const [quizzes, setQuizzes] = useState<any[] | null>(null);
  const [active, setActive] = useState<{ quizId: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'course' | 'weak'>('course');
  const [difficulty, setDifficulty] = useState<'mixed' | 'easy' | 'medium' | 'hard'>('mixed');

  const load = () => api<{ quizzes: any[] }>(`/courses/${courseId}/quizzes`).then((d) => setQuizzes(d.quizzes)).catch(() => setQuizzes([]));
  useEffect(() => {
    load();
  }, [courseId]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const { quiz } = await api<{ quiz: any }>(`/courses/${courseId}/quizzes/generate`, { method: 'POST', body: { scope, count: 6, difficulty } });
      setActive({ quizId: quiz.id, title: quiz.title });
      await load();
    } catch (e: any) {
      setError(e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!quizzes) return null;

  return (
    <div className="space-y-4">
      {active ? (
        <QuizRunner quizId={active.quizId} title={active.title} onDone={() => { setActive(null); load(); }} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select value={scope} onChange={(e) => setScope(e.target.value as any)} className="w-auto">
              <option value="course">{t.courses}</option>
              <option value="weak">{t.weakTopics}</option>
            </select>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as any)} className="w-auto">
              <option value="mixed">Mixed difficulty</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
            <Button onClick={generate} disabled={busy}>{busy ? t.processing : t.generateQuiz}</Button>
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          {quizzes.length === 0 ? (
            <Empty title={t.empty} hint={t.noCoursesHint} />
          ) : (
            <Card className="divide-y divide-slate-100">
              {quizzes.map((q) => {
                const best = (q.quiz_attempts || []).sort((a: any, b: any) => b.created_at.localeCompare(a.created_at))[0];
                return (
                  <div key={q.id} className="flex items-center justify-between px-4 py-3">
                    <button className="text-start" onClick={() => setActive({ quizId: q.id, title: q.title })}>
                      <p className="text-sm font-medium text-slate-800 hover:text-indigo-600">{q.title}</p>
                      {best && (
                        <p className="text-xs text-slate-400">
                          {t.score}: {best.score}/{best.total} · {new Date(best.created_at).toLocaleDateString()}
                        </p>
                      )}
                    </button>
                    <Badge tone={q.status === 'completed' ? 'NICE_TO_KNOW' : 'SHOULD_KNOW'}>{q.status}</Badge>
                  </div>
                );
              })}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function QuizRunner({ quizId, title, onDone }: { quizId: string; title: string; onDone: () => void }) {
  const { t } = useI18n();
  const [questions, setQuestions] = useState<any[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ questions: any[] }>(`/quizzes/${quizId}`).then((d) => setQuestions(d.questions));
  }, [quizId]);

  const submit = async () => {
    setBusy(true);
    try {
      const body = { answers: Object.entries(answers).map(([questionId, given]) => ({ questionId, given })) };
      const res = await api<any>(`/quizzes/${quizId}/submit`, { method: 'POST', body });
      setResult(res);
    } finally {
      setBusy(false);
    }
  };

  if (!questions) return null;

  if (result) {
    return (
      <div className="space-y-4">
        <Card className="p-6 text-center">
          <p className="text-3xl font-bold text-slate-900">{result.attempt.score}/{result.attempt.total}</p>
          <Button className="mt-4" onClick={onDone}>{t.quizzes}</Button>
        </Card>
        {result.results.map((r: any, i: number) => (
          <Card key={i} className="p-4">
            <p className="text-sm font-medium text-slate-900">
              {r.correct ? '✓' : '✗'} {questions.find((q) => q.id === r.question_id)?.question || ''}
            </p>
            {!r.correct && (
              <p className="mt-2 text-sm text-slate-600">
                {t.yourAnswer}: {r.given || '—'} · {t.correctAnswer}: <strong>{r.expected}</strong>
              </p>
            )}
            {r.explanation && <p className="mt-1 text-sm text-slate-500">{t.explanation}: {r.explanation}</p>}
          </Card>
        ))}
      </div>
    );
  }

  const answered = questions.filter((q) => (answers[q.id] || '').trim()).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">{title}</h3>
        <span className="text-sm text-slate-500">{answered}/{questions.length}</span>
      </div>
      {questions.map((q, i) => (
        <Card key={q.id} className="p-4">
          <p className="text-sm font-medium text-slate-900">{i + 1}. {q.question}</p>
          {q.options ? (
            <div className="mt-3 space-y-2">
              {(q.options as string[]).map((opt: string, j: number) => (
                <label key={j} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name={`q-${q.id}`}
                    checked={answers[q.id] === opt}
                    onChange={() => setAnswers({ ...answers, [q.id]: opt })}
                    className="h-4 w-4"
                  />
                  {opt}
                </label>
              ))}
            </div>
          ) : (
            <input
              className="mt-3"
              placeholder={t.yourAnswer}
              value={answers[q.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            />
          )}
        </Card>
      ))}
      <Button onClick={submit} disabled={busy || answered < questions.length}>
        {busy ? t.processing : `${t.submit} (${answered}/${questions.length})`}
      </Button>
    </div>
  );
}
