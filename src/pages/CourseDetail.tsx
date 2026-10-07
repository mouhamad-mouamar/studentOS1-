import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { rememberCourse } from '../lib/activity';
import { useI18n } from '../lib/i18n';
import { Badge, Button, Empty, ErrorNote, Icon, Skeleton } from '../components/ui';
import { MaterialsTab } from '../components/course/MaterialsTab';
import { OverviewTab } from '../components/course/OverviewTab';
import { ConceptsTab } from '../components/course/ConceptsTab';
import { NotesTab } from '../components/course/NotesTab';
import { FlashcardsTab } from '../components/course/FlashcardsTab';
import { QuizzesTab } from '../components/course/QuizzesTab';
import { TutorTab } from '../components/course/TutorTab';
import { ExamsTab } from '../components/course/ExamsTab';
import { FormulasTab } from '../components/course/FormulasTab';
import { PlanTab } from '../components/course/PlanTab';

const TABS = ['overview', 'materials', 'concepts', 'notes', 'flashcards', 'quizzes', 'tutor', 'exams', 'formulas', 'plan'] as const;
type Tab = (typeof TABS)[number];

const TAB_ICONS: Record<Tab, string> = {
  overview: 'sparkles',
  materials: 'file',
  concepts: 'layers',
  notes: 'book',
  flashcards: 'cards',
  quizzes: 'check',
  tutor: 'chat',
  exams: 'calendar',
  formulas: 'sigma',
  plan: 'zap',
};

export function CourseDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { t } = useI18n();
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const q = searchParams.get('tab') as Tab | null;
    return q && TABS.includes(q) ? q : 'overview';
  });
  const [cramData, setCramData] = useState<any | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api(`/courses/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);
  useEffect(() => {
    if (data?.course?.id) rememberCourse(data.course.id, data.course.name);
  }, [data?.course?.id]);
  useEffect(() => {
    if (tab === 'plan' && id && !cramData) {
      api(`/courses/${id}/cram`).then((d) => setCramData(d)).catch(() => setCramData(null));
    }
  }, [tab, id, cramData]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-10 rounded-xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }
  if (!data.course) return <Empty title={t.noCourses} icon="book" />;

  const { course, counts } = data;
  const tabLabels: Record<Tab, string> = {
    overview: t.overview,
    materials: t.materials,
    concepts: t.concepts,
    notes: t.notes,
    flashcards: t.flashcards,
    quizzes: t.quizzes,
    tutor: t.tutor,
    exams: t.exams,
    formulas: t.formulas,
    plan: t.plan,
  };
  const tabCounts: Partial<Record<Tab, string>> = {
    materials: String(data.materials.length),
    concepts: String(data.concepts.length),
    flashcards: counts.due ? String(counts.due) : undefined,
  };

  return (
    <div className="space-y-4">
      <div>
        <Link to="/courses" className="inline-flex items-center gap-1 text-sm text-slate-400 transition-colors hover:text-indigo-600">
          <Icon name="back" className="h-3.5 w-3.5 rtl:rotate-180" />
          {t.courses}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{course.name}</h1>
          {course.code && <span className="text-sm text-slate-500">{course.code}</span>}
          {course.exam_date && (
            <Badge tone={course.exam_days_away != null && course.exam_days_away <= 7 ? 'MUST_KNOW' : 'SHOULD_KNOW'}>
              {course.exam_date}
            </Badge>
          )}
          <span className="flex-1" />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await api(`/courses/${course.id}/recompute-priority`, { method: 'POST' });
                load();
              }}
            >
              <Icon name="refresh" className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t.priorityEngine}</span>
            </Button>
            <Button size="sm" onClick={() => setTab('plan')}>
              <Icon name="zap" className="h-3.5 w-3.5" />
              {t.quickStudy}
            </Button>
          </div>
        </div>
      </div>

      <div className="sticky top-14 z-20 -mx-4 border-b border-slate-200/80 bg-slate-50/90 px-4 py-2 backdrop-blur-sm">
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
          {TABS.map((tb) => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              className={`flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-sm font-medium transition-all active:scale-[0.97] ${
                tab === tb
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/25'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Icon name={TAB_ICONS[tb]} className="h-3.5 w-3.5" />
              {tabLabels[tb]}
              {tabCounts[tb] && (
                <span
                  className={`rounded-full px-1.5 text-[11px] font-semibold ${
                    tab === tb ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {tabCounts[tb]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && <OverviewTab courseId={course.id} />}
      {tab === 'materials' && <MaterialsTab courseId={course.id} materials={data.materials} onChanged={load} />}
      {tab === 'concepts' && <ConceptsTab courseId={course.id} />}
      {tab === 'notes' && <NotesTab courseId={course.id} />}
      {tab === 'flashcards' && <FlashcardsTab courseId={course.id} />}
      {tab === 'quizzes' && <QuizzesTab courseId={course.id} />}
      {tab === 'tutor' && <TutorTab courseId={course.id} />}
      {tab === 'exams' && <ExamsTab courseId={course.id} />}
      {tab === 'formulas' && <FormulasTab courseId={course.id} />}
      {tab === 'plan' && <PlanTab courseId={course.id} cramData={cramData} />}
    </div>
  );
}
