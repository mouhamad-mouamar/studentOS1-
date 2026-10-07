import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Badge, Button, Card, Empty, Icon, Skeleton, useToast } from '../components/ui';

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
  courses: {
    id: string; name: string; color: string | null; code: string | null;
    due_cards: number; exam_days_away: number | null;
    knowledge: { new: number; learning: 0 | number; review: number; mastered: number };
  }[];
  weaknesses: { score: number; concept_id: string; course_id: string; concepts: { title: string } | null }[];
  recent_attempts: { score: number; total: number; created_at: string; quizzes: { title: string } | null }[];
  progress: { trend: { date: string; pct: number; title: string }[]; total_attempts: number };
  upcoming_exams: { id: string; name: string; exam_date: string; days_away: number | null }[];
  recommendations: Recommendation[];
  ai_configured: boolean;
  ai_engine?: 'local' | 'external' | 'none';
}

function KnowledgeBar({ k }: { k: { new: number; learning: number; review: number; mastered: number } }) {
  const total = k.new + k.learning + k.review + k.mastered;
  if (total === 0) return null;
  const seg = (n: number, cls: string) => (
    <div className={`${cls} h-1.5 transition-all`} style={{ width: `${(n / total) * 100}%` }} />
  );
  return (
    <div className="mt-3">
      <div className="flex overflow-hidden rounded-full bg-slate-100">
        {seg(k.mastered, 'bg-green-400')}
        {seg(k.review, 'bg-sky-400')}
        {seg(k.learning, 'bg-amber-400')}
        {seg(k.new, 'bg-slate-300')}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        {k.mastered} mastered · {k.review} reviewing · {k.learning} learning · {k.new} new
      </p>
    </div>
  );
}

function SectionTitle({ icon, children, action }: { icon: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-slate-500">
          <Icon name={icon} className="h-4 w-4" />
        </span>
        {children}
      </h2>
      {action}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-32 rounded-2xl" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    </div>
  );
}

export function Dashboard() {
  const { t } = useI18n();
  const { show } = useToast();
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Dash>('/dashboard')
      .then(setData)
      .catch((e: ApiError) => {
        setError(e.message);
        show(e.message, 'error');
      });
  }, []);

  if (error) return <Empty title={error} icon="alert" />;
  if (!data) return <DashboardSkeleton />;

  const trend = data.progress.trend;
  const avg = trend.length ? Math.round(trend.reduce((s, x) => s + x.pct, 0) / trend.length) : null;
  const recent = trend.length >= 2 ? trend[trend.length - 1].pct - trend[0].pct : null;

  return (
    <div className="space-y-8">
      {!data.ai_configured && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Icon name="alert" className="h-4 w-4 shrink-0" />
          {t.aiNotConfigured}
        </div>
      )}
      {data.ai_configured && data.ai_engine === 'local' && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          <Icon name="check" className="h-4 w-4 shrink-0" />
          {t.aiLocalEngine}
        </div>
      )}

      {/* TODAY — hero: the single best next action */}
      <section>
        {data.recommendations.length === 0 ? (
          <>
            <SectionTitle icon="target">{t.recommended}</SectionTitle>
            <Empty title={t.empty} hint={t.noCoursesHint} action={<Link to="/courses"><Button>{t.createCourse}</Button></Link>} icon="book" />
          </>
        ) : (
          <>
            {(() => {
              const hero = data.recommendations[0];
              const rest = data.recommendations.slice(1);
              return (
                <>
                  <div className="animate-fade-up overflow-hidden rounded-2xl border border-indigo-200 bg-white shadow-md shadow-indigo-600/10">
                    <div className="relative overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-600 to-violet-600 px-5 py-5">
                      <div
                        className="pointer-events-none absolute -right-10 -top-16 h-44 w-44 rounded-full opacity-25"
                        style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.55), transparent 70%)' }}
                      />
                      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-100">
                        <Icon name="sparkles" className="h-3.5 w-3.5" />
                        {t.recommended}
                      </p>
                      <h2 className="mt-1.5 text-xl font-bold leading-snug text-white sm:text-2xl">{hero.action}</h2>
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-indigo-100">
                        {hero.courseName && <span>{hero.courseName}</span>}
                        <span className="rounded-full bg-white/15 px-2.5 py-0.5 font-medium backdrop-blur-sm" dir="ltr">≈ {hero.minutes} min</span>
                      </div>
                    </div>
                    <div className="px-5 py-4">
                      <p className="text-sm leading-relaxed text-slate-700">{hero.detail}</p>
                      {hero.reasons.length > 0 && (
                        <div className="mt-3">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t.why}</p>
                          <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
                            {hero.reasons.map((reason, j) => (
                              <li key={j} className="text-xs text-slate-500">• {reason}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {hero.courseId && (
                        <Link
                          to={`/courses/${hero.courseId}`}
                          className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white shadow-sm shadow-indigo-600/25 transition-all hover:bg-indigo-700 hover:shadow active:scale-[0.97]"
                        >
                          {t.start} <Icon name="chevron" className="h-4 w-4 -rotate-90 rtl:rotate-90" />
                        </Link>
                      )}
                    </div>
                  </div>
                  {rest.length > 0 && (
                    <div className="stagger mt-3 grid gap-3 md:grid-cols-2">
                      {rest.map((r, i) => (
                        <Card key={i} className="press p-4">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-medium text-slate-900">{r.action}</h3>
                            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{r.minutes}m</span>
                          </div>
                          {r.courseName && <p className="mt-0.5 text-sm text-slate-500">{r.courseName}</p>}
                          <p className="mt-2 text-sm text-slate-600">{r.detail}</p>
                          {r.reasons.length > 0 && (
                            <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t.why}</p>
                              <ul className="mt-0.5 space-y-0.5">
                                {r.reasons.map((reason, j) => (
                                  <li key={j} className="text-xs text-slate-500">• {reason}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {r.courseId && (
                            <Link to={`/courses/${r.courseId}`} className="mt-3 inline-flex min-h-9 items-center text-sm font-medium text-indigo-600 hover:underline">
                              {t.start} →
                            </Link>
                          )}
                        </Card>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </>
        )}
      </section>

      {/* UPCOMING */}
      {data.upcoming_exams.length > 0 && (
        <section>
          <SectionTitle icon="calendar">{t.exams}</SectionTitle>
          <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.upcoming_exams.map((e) => (
              <Link key={e.id} to={`/courses/${e.id}`}>
                <Card className="press p-4 transition-shadow hover:shadow-md">
                  <p className="font-medium text-slate-900">{e.name}</p>
                  <p className={`mt-1 text-sm font-semibold ${(e.days_away ?? 99) <= 7 ? 'text-red-600' : 'text-slate-600'}`}>
                    {e.days_away === 0 ? 'Today' : t.examIn(e.days_away!)}
                  </p>
                  <p className="text-xs text-slate-400">{e.exam_date}</p>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* COURSES with knowledge bars */}
      <section>
        <SectionTitle
          icon="book"
          action={
            data.courses.length > 0 && (
              <Link to="/courses" className="text-sm font-medium text-indigo-600 hover:underline">{t.viewAll} →</Link>
            )
          }
        >
          {t.courses}
        </SectionTitle>
        {data.courses.length === 0 ? (
          <Empty title={t.noCourses} hint={t.noCoursesHint} icon="book" />
        ) : (
          <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.courses.map((c) => (
              <Link key={c.id} to={`/courses/${c.id}`}>
                <Card className="press h-full p-4 transition-all hover:-translate-y-0.5 hover:shadow-md">
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
                  <KnowledgeBar k={c.knowledge} />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        {/* WEAK AREAS */}
        <section>
          <SectionTitle icon="target">{t.weakTopics}</SectionTitle>
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
                      <div className="h-full rounded-full bg-gradient-to-r from-red-300 to-red-400 transition-all" style={{ width: `${Math.min(100, w.score)}%` }} />
                    </div>
                    <span className="w-8 text-right text-xs text-slate-500">{w.score}</span>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </section>

        {/* PROGRESS */}
        <section>
          <SectionTitle icon="trending">{t.score}</SectionTitle>
          {trend.length === 0 ? (
            <Card className="p-4 text-sm text-slate-500">{t.empty}</Card>
          ) : (
            <Card className="p-4">
              <div className="flex flex-wrap items-baseline gap-3">
                <p className="text-3xl font-bold text-slate-900">{avg}%</p>
                <span className="text-sm text-slate-500">avg accuracy · {data.progress.total_attempts} attempt(s)</span>
                {recent != null && recent !== 0 && (
                  <span className={`text-sm font-medium ${recent > 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {recent > 0 ? '▲' : '▼'} {Math.abs(recent)}%
                  </span>
                )}
              </div>
              <div className="mt-4 flex h-20 items-end gap-1.5">
                {trend.map((x, i) => (
                  <div key={i} className="group relative flex-1" title={`${x.title}: ${x.pct}%`}>
                    <div
                      className={`w-full rounded-t transition-all group-hover:opacity-80 ${x.pct >= 70 ? 'bg-green-400' : x.pct >= 50 ? 'bg-amber-400' : 'bg-red-400'}`}
                      style={{ height: `${Math.max(6, x.pct)}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 border-t border-slate-100 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t.quizzes}</p>
                {data.recent_attempts.slice(0, 3).map((a, i) => (
                  <div key={i} className="mt-1.5 flex items-center justify-between text-sm">
                    <span className="truncate text-slate-600">{a.quizzes?.title || 'Quiz'}</span>
                    <span className="font-medium text-slate-900">{a.score}/{a.total}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
