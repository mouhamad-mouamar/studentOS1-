import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { lastCourse, todayActivity } from '../lib/activity';
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
  weaknesses: { score: number; concept_id: string; course_id: string; signals: { wrong_quizzes?: number; failed_reviews?: number } | null; concepts: { title: string } | null }[];
  recent_attempts: { score: number; total: number; created_at: string; course_id: string; quizzes: { title: string } | null }[];
  progress: { trend: { date: string; pct: number; title: string }[]; total_attempts: number };
  stats: { sessions_done: number; cards_reviewed: number; topics_reviewed: number; materials: number; courses: number };
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
      {data.ai_configured && data.ai_engine === 'external' && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          <Icon name="check" className="h-4 w-4 shrink-0" />
          {t.aiCloudEngine}
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

      {/* TODAY — quick actions based on real data */}
      {data.courses.length > 0 && <TodaySection data={data} />}

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
        {/* SMART REVIEW — deterministic weak-topic detection */}
        <section>
          <SectionTitle icon="target">{t.smartReview}</SectionTitle>
          <SmartReview data={data} />
        </section>

        {/* PROGRESS */}
        <section>
          <SectionTitle icon="trending">{t.progressTitle}</SectionTitle>
          <ProgressStats data={data} avg={avg} />
          {trend.length > 0 && (
            <Card className="mt-3 p-4">
              <div className="flex flex-wrap items-baseline gap-3">
                <p className="text-2xl font-bold text-slate-900">{avg}%</p>
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

/* ---------------- Today: continue + quick actions + today's activity ---------------- */

function TodaySection({ data }: { data: Dash }) {
  const { t } = useI18n();
  const last = lastCourse();
  const continueCourse = last && data.courses.some((c) => c.id === last.id) ? last : null;
  const actionCourse = continueCourse || data.courses[0];
  const act = todayActivity();
  const hasActivity = act.quizzes > 0 || act.cards > 0 || act.sessions > 0;

  const actions = [
    { icon: 'zap', label: t.startSession, to: `/session/${actionCourse.id}`, primary: true },
    { icon: 'check', label: t.quickQuiz, to: `/courses/${actionCourse.id}?tab=quizzes` },
    { icon: 'cards', label: t.reviewCards, to: `/courses/${actionCourse.id}?tab=flashcards` },
  ];
  if (data.weaknesses.some((w) => w.course_id)) {
    actions.push({ icon: 'target', label: t.weakTopics, to: `/courses/${data.weaknesses[0].course_id}?tab=concepts`, primary: false });
  }

  return (
    <section>
      <SectionTitle icon="home">{t.today}</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        {continueCourse && (
          <Link to={`/courses/${continueCourse.id}`} className="sm:col-span-2">
            <Card className="press flex items-center justify-between gap-3 p-4 transition-shadow hover:shadow-md">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-500">
                  <Icon name="book" className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t.continueStudying}</p>
                  <p className="truncate font-medium text-slate-900">{continueCourse.name}</p>
                </div>
              </div>
              <Icon name="chevron" className="h-4 w-4 shrink-0 -rotate-90 text-slate-400 rtl:rotate-90" />
            </Card>
          </Link>
        )}
        <div className="grid grid-cols-2 gap-2 sm:col-span-2 sm:grid-cols-4">
          {actions.map((a) => (
            <Link
              key={a.label}
              to={a.to}
              className={`press flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2.5 text-center text-xs font-medium transition-all active:scale-[0.97] ${
                'primary' in a && a.primary
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Icon name={a.icon} className="h-4.5 w-4.5" />
              <span className="leading-tight">{a.label}</span>
            </Link>
          ))}
        </div>
        <p className="text-xs text-slate-400 sm:col-span-2">
          {t.today}:{' '}
          {hasActivity ? (
            <span className="font-medium text-slate-600">
              {act.quizzes > 0 && `${act.quizzes} ${t.todayQuiz}`}
              {act.quizzes > 0 && act.cards > 0 && ' · '}
              {act.cards > 0 && `${act.cards} ${t.todayCards}`}
              {act.cards > 0 && act.sessions > 0 && ' · '}
              {act.sessions > 0 && `${act.sessions} ${t.todaySessions}`}
            </span>
          ) : (
            t.nothingYet
          )}
        </p>
      </div>
    </section>
  );
}

/* ---------------- Smart Review: deterministic, real signals only ---------------- */

function SmartReview({ data }: { data: Dash }) {
  const { t } = useI18n();
  const courseName = (id: string) => data.courses.find((c) => c.id === id)?.name;

  const rows = data.weaknesses
    .filter((w) => w.score > 0)
    .map((w) => {
      const wrong = w.signals?.wrong_quizzes ?? 0;
      const failed = w.signals?.failed_reviews ?? 0;
      const parts: string[] = [];
      if (wrong > 0) parts.push(`${wrong} ${t.incorrectAnswers}`);
      if (failed > 0) parts.push(`${failed} ${t.failedReviews}`);
      return { key: w.concept_id, title: w.concepts?.title || '—', course: courseName(w.course_id), courseId: w.course_id, reason: parts.join(' · ') || t.review, score: w.score };
    });

  // Low recent quiz scores (deterministic: < 50% on a real attempt).
  const lowAttempts = data.recent_attempts
    .filter((a) => a.total > 0 && a.score / a.total < 0.5)
    .slice(0, 2)
    .map((a) => ({
      key: `attempt-${a.created_at}`,
      title: a.quizzes?.title || 'Quiz',
      course: courseName(a.course_id),
      courseId: a.course_id,
      reason: `${t.lowQuizScore}: ${a.score}/${a.total}`,
    }));

  const all = [...rows, ...lowAttempts];

  if (all.length === 0) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-green-50 text-green-500">
          <Icon name="check" className="h-4.5 w-4.5" />
        </span>
        <p className="text-sm text-slate-600">{t.noWeak}</p>
      </Card>
    );
  }

  return (
    <Card className="stagger divide-y divide-slate-100">
      {all.map((r) => (
        <div key={r.key} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-800">{r.title}</p>
            <p className="truncate text-xs text-slate-400">
              {r.course ? `${r.course} · ` : ''}
              <span className="text-red-500/90">{r.reason}</span>
            </p>
          </div>
          <Link
            to={`/courses/${r.courseId}?tab=concepts`}
            className="inline-flex min-h-9 shrink-0 items-center rounded-lg bg-indigo-50 px-3 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
          >
            {t.review}
          </Link>
        </div>
      ))}
    </Card>
  );
}

/* ---------------- Progress: lifetime stats from real data ---------------- */

function ProgressStats({ data, avg }: { data: Dash; avg: number | null }) {
  const { t } = useI18n();
  const s = data.stats;
  const tiles = [
    { label: t.statCourses, value: s.courses },
    { label: t.statMaterials, value: s.materials },
    { label: t.statTopics, value: s.topics_reviewed },
    { label: t.statCards, value: s.cards_reviewed },
    { label: t.statSessions, value: s.sessions_done },
    { label: t.statQuizAvg, value: avg != null ? `${avg}%` : '—' },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {tiles.map((x) => (
        <Card key={x.label} className="p-3 text-center">
          <p className="text-lg font-bold text-slate-900">{x.value}</p>
          <p className="text-[11px] leading-tight text-slate-500">{x.label}</p>
        </Card>
      ))}
    </div>
  );
}
