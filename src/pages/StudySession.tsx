import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { noteActivity, rememberCourse } from '../lib/activity';
import { Badge, Button, Card, Empty, ErrorNote, Icon, Skeleton, useToast } from '../components/ui';

type Step = 'study' | 'cards' | 'quiz' | 'done';

const PRIORITY_ORDER: Record<string, number> = { MUST_KNOW: 0, SHOULD_KNOW: 1, NICE_TO_KNOW: 2, LOW_PRIORITY: 3 };

export function StudySession() {
  const { courseId } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();

  const [course, setCourse] = useState<any | null>(null);
  const [concepts, setConcepts] = useState<any[] | null>(null);
  const [step, setStep] = useState<Step>('study');
  const [openConcept, setOpenConcept] = useState<string | null>(null);
  const [viewed, setViewed] = useState<Set<string>>(new Set());

  // course picker when no :courseId
  const [courses, setCourses] = useState<any[] | null>(null);

  // flashcards
  const [cards, setCards] = useState<any[] | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [cardsDone, setCardsDone] = useState(0);

  // quiz
  const [quiz, setQuiz] = useState<{ id: string; questions: any[] } | null>(null);
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizSkip, setQuizSkip] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [quizResult, setQuizResult] = useState<{ score: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<{ questions: number; correct: number; cards: number; topics: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (courseId) {
      api<{ course: any }>(`/courses/${courseId}`)
        .then((d) => {
          setCourse(d.course);
          if (d.course) rememberCourse(d.course.id, d.course.name);
        })
        .catch((e) => setError(e.message));
      api<{ concepts: any[] }>(`/courses/${courseId}/concepts`).then((d) => setConcepts(d.concepts)).catch(() => setConcepts([]));
    } else {
      api<{ courses: any[] }>('/courses').then((d) => setCourses(d.courses)).catch(() => setCourses([]));
    }
  }, [courseId]);

  const loadDueCards = useCallback(async () => {
    if (!courseId) return;
    try {
      const d = await api<{ cards: any[] }>(`/courses/${courseId}/flashcards?due=1`);
      setCards(d.cards);
    } catch {
      setCards([]);
    }
  }, [courseId]);

  const startCards = async () => {
    setStep('cards');
    setCards(null);
    await loadDueCards();
  };

  const reviewCard = async (result: 'again' | 'hard' | 'good' | 'easy') => {
    const card = cards?.[0];
    if (!card) return;
    try {
      await api(`/flashcards/${card.id}/review`, { method: 'POST', body: { result } });
    } catch {
      /* review persistence failed — continue session, card stays due */
    }
    noteActivity('cards');
    setCardsDone((n) => n + 1);
    setCards((cs) => (cs ? cs.slice(1) : cs));
    setFlipped(false);
  };

  const startQuiz = async () => {
    setStep('quiz');
    setQuizBusy(true);
    setError(null);
    try {
      const { quiz: q } = await api<{ quiz: any }>(`/courses/${courseId}/quizzes/generate`, { method: 'POST', body: { scope: 'course', count: 3 } });
      const d = await api<{ questions: any[] }>(`/quizzes/${q.id}`);
      setQuiz({ id: q.id, questions: d.questions });
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'AI_NOT_CONFIGURED') setQuizSkip(true);
      else setError(e.message);
    } finally {
      setQuizBusy(false);
    }
  };

  const submitQuiz = async () => {
    if (!quiz) return;
    setQuizBusy(true);
    try {
      const body = { answers: Object.entries(answers).map(([questionId, given]) => ({ questionId, given })) };
      const res = await api<{ attempt: { score: number; total: number } }>(`/quizzes/${quiz.id}/submit`, { method: 'POST', body });
      const answered = Object.keys(answers).length;
      noteActivity('quiz');
      setQuizResult({ score: res.attempt.score, total: res.attempt.total });
      finish({ questions: answered, correct: res.attempt.score });
    } catch (e: any) {
      setError(e.message);
      setQuizBusy(false);
    }
  };

  const finish = async (stats: { questions: number; correct: number }) => {
    setStep('done');
    setSaving(true);
    const topics = viewed.size;
    const cardsN = cardsDone;
    let sessionId: string | null = null;
    try {
      if (courseId) {
        const { session } = await api<{ session: any }>(`/courses/${courseId}/sessions`, { method: 'POST', body: { minutes: 15, mode: 'quick' } });
        sessionId = session.id;
      }
    } catch {
      /* session record is best-effort; study data itself is already saved */
    }
    try {
      if (sessionId) {
        await api(`/sessions/${sessionId}/complete`, {
          method: 'POST',
          body: { stats: { questions_answered: stats.questions, correct: stats.correct, cards_reviewed: cardsN, topics_reviewed: topics } },
        });
      }
    } catch {
      /* best-effort */
    }
    noteActivity('session');
    setSummary({ questions: stats.questions, correct: stats.correct, cards: cardsN, topics });
    setSaving(false);
  };

  /* ---------- course picker ---------- */
  if (!courseId) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900">
          <Icon name="zap" className="h-5 w-5 text-indigo-500" />
          {t.studySession}
        </h1>
        {!courses ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : courses.length === 0 ? (
          <Empty title={t.noCourses} hint={t.noCoursesHint} action={<Link to="/courses"><Button>{t.createCourse}</Button></Link>} icon="book" />
        ) : (
          <div className="stagger space-y-2">
            {courses.map((c) => (
              <Link key={c.id} to={`/session/${c.id}`}>
                <Card className="press flex items-center justify-between p-4 transition-shadow hover:shadow-md">
                  <div>
                    <p className="font-medium text-slate-900">{c.name}</p>
                    {c.code && <p className="text-sm text-slate-500">{c.code}</p>}
                  </div>
                  <Icon name="chevron" className="h-4 w-4 -rotate-90 text-slate-400 rtl:rotate-90" />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ---------- header ---------- */
  const stepIndex = { study: 0, cards: 1, quiz: 2, done: 3 }[step];
  const steps = [t.stepStudy, t.stepCards, t.stepQuiz];

  const topConcepts = (concepts || [])
    .slice()
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9))
    .slice(0, 5);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => navigate('/dashboard')} className="inline-flex min-h-9 items-center gap-1 text-sm text-slate-400 transition-colors hover:text-indigo-600">
          <Icon name="back" className="h-3.5 w-3.5 rtl:rotate-180" />
          {t.dashboard}
        </button>
        <span className="text-sm text-slate-500">{course?.name}</span>
      </div>

      {/* step tracker */}
      {step !== 'done' && (
        <div className="flex items-center gap-2">
          {steps.map((label, i) => (
            <div key={label} className="flex flex-1 items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span
                  className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold transition-colors ${
                    i < stepIndex ? 'bg-green-500 text-white' : i === stepIndex ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'
                  }`}
                >
                  {i < stepIndex ? '✓' : i + 1}
                </span>
                <span className={`hidden text-xs font-medium sm:inline ${i === stepIndex ? 'text-slate-900' : 'text-slate-400'}`}>{label}</span>
              </div>
              {i < steps.length - 1 && <div className={`h-0.5 flex-1 rounded ${i < stepIndex ? 'bg-green-400' : 'bg-slate-200'}`} />}
            </div>
          ))}
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* STEP 1 — study concepts */}
      {step === 'study' && (
        <div className="animate-fade-up space-y-3">
          <Card className="p-4">
            <h2 className="font-semibold text-slate-900">{t.stepStudy}</h2>
            <p className="mt-0.5 text-sm text-slate-500">{t.sessionStudyHint}</p>
          </Card>
          {!concepts ? (
            <Skeleton className="h-40 rounded-2xl" />
          ) : topConcepts.length === 0 ? (
            <Empty title={t.empty} hint={t.noCoursesHint} icon="layers" />
          ) : (
            <div className="stagger space-y-2">
              {topConcepts.map((c) => {
                const open = openConcept === c.id;
                return (
                  <Card key={c.id} className="p-4">
                    <button
                      className="flex min-h-9 w-full items-center justify-between gap-2 text-start"
                      onClick={() => {
                        setOpenConcept(open ? null : c.id);
                        if (!open) setViewed((s) => new Set(s).add(c.id));
                      }}
                    >
                      <span className="flex items-center gap-2 font-medium text-slate-900">
                        {c.title}
                        {viewed.has(c.id) && <Icon name="check" className="h-4 w-4 text-green-500" />}
                      </span>
                      {c.priority && <Badge tone={c.priority}>{t[PRIORITY_KEY(c.priority)]}</Badge>}
                    </button>
                    {open && (
                      <div className="animate-fade-in mt-2 border-t border-slate-100 pt-2 text-sm leading-relaxed text-slate-600">
                        {c.summary || c.description || '—'}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={startCards}>
              {t.stepCards} <Icon name="chevron" className="h-4 w-4 -rotate-90 rtl:rotate-90" />
            </Button>
            <Button variant="ghost" onClick={() => finish({ questions: 0, correct: 0 })}>
              {t.finishSession}
            </Button>
          </div>
        </div>
      )}

      {/* STEP 2 — flashcards */}
      {step === 'cards' && (
        <div className="animate-fade-up space-y-3">
          {!cards ? (
            <Skeleton className="h-56 rounded-2xl" />
          ) : !cards[0] ? (
            <Empty title={cardsDone > 0 ? t.allDone : t.noMoreDue} hint={t.sessionCardsDone(cardsDone)} icon="cards" />
          ) : (
            <>
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>{t.left(cards.length)}</span>
                <span>{t.sessionCardsDone(cardsDone)}</span>
              </div>
              <Card className="min-h-56 p-8 text-center shadow-md">
                <p className="text-lg font-medium leading-relaxed text-slate-900">{cards[0].front}</p>
                {flipped && (
                  <div className="animate-flip-reveal mt-4 border-t border-slate-100 pt-4">
                    <p className="leading-relaxed text-slate-700">{cards[0].back}</p>
                  </div>
                )}
              </Card>
              {!flipped ? (
                <Button className="w-full" onClick={() => setFlipped(true)}>
                  {t.flip}
                </Button>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-center">
                  <Button variant="danger" onClick={() => reviewCard('again')}>{t.again}</Button>
                  <Button variant="secondary" onClick={() => reviewCard('hard')}>{t.hard}</Button>
                  <Button onClick={() => reviewCard('good')}>{t.good}</Button>
                  <Button variant="secondary" onClick={() => reviewCard('easy')}>{t.easy}</Button>
                </div>
              )}
            </>
          )}
          <div className="flex gap-2">
            <Button onClick={startQuiz} disabled={quizBusy}>
              {quizBusy ? t.processing : `${t.stepQuiz} →`}
            </Button>
            <Button variant="ghost" onClick={() => finish({ questions: 0, correct: 0 })}>
              {t.finishSession}
            </Button>
          </div>
        </div>
      )}

      {/* STEP 3 — quiz */}
      {step === 'quiz' && (
        <div className="animate-fade-up space-y-3">
          {quizSkip ? (
            <Card className="p-5 text-center">
              <p className="text-sm text-slate-600">{t.aiNotConfigured}</p>
              <Button className="mt-4" onClick={() => finish({ questions: 0, correct: 0 })}>
                {t.finishSession}
              </Button>
            </Card>
          ) : !quiz ? (
            <Card className="flex flex-col items-center gap-3 p-8">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" />
              <p className="text-sm text-slate-500">{t.processing}</p>
              {error && <Button variant="ghost" onClick={() => finish({ questions: 0, correct: 0 })}>{t.finishSession}</Button>}
            </Card>
          ) : quizResult ? (
            <Card className="p-6 text-center">
              <p className="animate-score-pop text-3xl font-bold text-slate-900">{quizResult.score}/{quizResult.total}</p>
            </Card>
          ) : (
            <>
              {quiz.questions.map((q: any, i: number) => (
                <Card key={q.id} className="p-4">
                  <p className="text-sm font-medium leading-relaxed text-slate-900">{i + 1}. {q.question}</p>
                  {q.options ? (
                    <div className="mt-3 grid gap-2">
                      {(q.options as string[]).map((opt: string, j: number) => {
                        const selected = answers[q.id] === opt;
                        return (
                          <label
                            key={j}
                            className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition-all active:scale-[0.99] ${
                              selected ? 'border-indigo-400 bg-indigo-50 text-indigo-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                            }`}
                          >
                            <input type="radio" name={`sq-${q.id}`} checked={selected} onChange={() => setAnswers({ ...answers, [q.id]: opt })} className="h-4 w-4 accent-indigo-600" />
                            {opt}
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <input className="mt-3" placeholder={t.yourAnswer} value={answers[q.id] || ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                  )}
                </Card>
              ))}
              <Button className="w-full" onClick={submitQuiz} disabled={quizBusy || Object.keys(answers).length < quiz.questions.length}>
                {quizBusy ? t.processing : t.submit}
              </Button>
            </>
          )}
        </div>
      )}

      {/* DONE — summary */}
      {step === 'done' && (
        <div className="animate-fade-up space-y-3">
          <Card className="p-6 text-center">
            <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-green-100 text-green-600">
              <Icon name="check" className="h-6 w-6" />
            </span>
            <h2 className="text-lg font-bold text-slate-900">{t.sessionComplete}</h2>
            {saving && <p className="mt-1 text-xs text-slate-400">{t.processing}</p>}
            {summary && (
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-slate-50 px-2 py-3">
                  <p className="text-xl font-bold text-slate-900">{summary.questions}</p>
                  <p className="text-[11px] text-slate-500">{t.questionsAnswered}</p>
                </div>
                <div className="rounded-xl bg-slate-50 px-2 py-3">
                  <p className="text-xl font-bold text-slate-900">{summary.cards}</p>
                  <p className="text-[11px] text-slate-500">{t.cardsReviewed}</p>
                </div>
                <div className="rounded-xl bg-slate-50 px-2 py-3">
                  <p className="text-xl font-bold text-slate-900">{summary.topics}</p>
                  <p className="text-[11px] text-slate-500">{t.topicsReviewed}</p>
                </div>
              </div>
            )}
            <div className="mt-5 flex justify-center gap-2">
              <Button onClick={() => navigate('/dashboard')}>{t.dashboard}</Button>
              <Button variant="secondary" onClick={() => { setStep('study'); setQuiz(null); setQuizResult(null); setAnswers({}); setCardsDone(0); setViewed(new Set()); setFlipped(false); }}>
                {t.startSession}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function PRIORITY_KEY(p: string): 'mustKnow' | 'shouldKnow' | 'niceToKnow' | 'lowPriority' {
  return ({ MUST_KNOW: 'mustKnow', SHOULD_KNOW: 'shouldKnow', NICE_TO_KNOW: 'niceToKnow', LOW_PRIORITY: 'lowPriority' } as const)[p] || 'shouldKnow';
}
