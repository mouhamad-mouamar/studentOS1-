import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Badge, Button, Card, Empty, Spinner } from '../components/ui';

interface Recommendation {
  action: string;
  courseId: string | null;
  courseName: string | null;
  kind: string;
  minutes: number;
  reasons: string[];
  detail: string;
}

interface Dash {
  courses: { id: string; name: string; color: string | null; code: string | null; due_cards: number; exam_days_away: number | null }[];
  weaknesses: { score: number; concept_id: string; course_id: string; concepts: { title: string } | null }[];
  recent_attempts: { score: number; total: number; created_at: string; quizzes: { title: string } | null }[];
  recommendations: Recommendation[];
  ai_configured: boolean;
}

export function Dashboard() {
  const { t } = useI18n();
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Dash>('/dashboard')
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  if (error) return <Empty title={error} />;
  if (!data) return <Spinner label={t.loading} />;

  return (
    <div className="space-y-6">
      {!data.ai_configured && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{t.aiNotConfigured}</div>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">{t.recommended}</h2>
        {data.recommendations.length === 0 ? (
          <Empty title={t.empty} hint={t.noCoursesHint} action={<Link to="/courses"><Button>{t.createCourse}</Button></Link>} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.recommendations.map((r, i) => (
              <Card key={i} className={`p-4 ${i === 0 ? 'ring-2 ring-indigo-500' : ''}`}>
                {i === 0 && <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-indigo-600">{t.nextAction}</p>}
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium text-slate-900">{r.action}</h3>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{r.minutes}m</span>
                </div>
                {r.courseName && <p className="mt-0.5 text-sm text-slate-500">{r.courseName}</p>}
                <p className="mt-2 text-sm text-slate-600">{r.detail}</p>
                <ul className="mt-2 space-y-0.5">
                  {r.reasons.map((reason, j) => (
                    <li key={j} className="text-xs text-slate-400">• {reason}</li>
                  ))}
                </ul>
                {r.courseId && (
                  <Link to={`/courses/${r.courseId}`} className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:underline">
                    {t.start} →
                  </Link>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{t.courses}</h2>
          <Link to="/courses" className="text-sm font-medium text-indigo-600 hover:underline">{t.courses} →</Link>
        </div>
        {data.courses.length === 0 ? (
          <Empty title={t.noCourses} hint={t.noCoursesHint} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.courses.map((c) => (
              <Link key={c.id} to={`/courses/${c.id}`}>
                <Card className="p-4 transition-shadow hover:shadow-md">
                  <h3 className="font-medium text-slate-900">{c.name}</h3>
                  {c.code && <p className="text-sm text-slate-500">{c.code}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    {c.due_cards > 0 && <Badge tone="MUST_KNOW">{c.due_cards} {t.dueCards}</Badge>}
                    {c.exam_days_away != null && (
                      <Badge tone={c.exam_days_away <= 7 ? 'MUST_KNOW' : 'SHOULD_KNOW'}>
                        {c.exam_days_away >= 0 ? t.examIn(c.exam_days_away) : t.examPassed}
                      </Badge>
                    )}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">{t.weakTopics}</h2>
          {data.weaknesses.length === 0 ? (
            <Card className="p-4 text-sm text-slate-500">{t.empty}</Card>
          ) : (
            <Card className="divide-y divide-slate-100">
              {data.weaknesses.map((w) => (
                <div key={w.concept_id} className="flex items-center justify-between px-4 py-3">
                  <Link to={`/courses/${w.course_id}`} className="text-sm font-medium text-slate-800 hover:text-indigo-600">
                    {w.concepts?.title || '—'}
                  </Link>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-red-400" style={{ width: `${Math.min(100, w.score)}%` }} />
                    </div>
                    <span className="w-8 text-right text-xs text-slate-500">{w.score}</span>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">{t.quizzes}</h2>
          {data.recent_attempts.length === 0 ? (
            <Card className="p-4 text-sm text-slate-500">{t.empty}</Card>
          ) : (
            <Card className="divide-y divide-slate-100">
              {data.recent_attempts.map((a, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="text-slate-700">{a.quizzes?.title || 'Quiz'}</span>
                  <span className="font-medium text-slate-900">{a.score}/{a.total}</span>
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
