import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Spinner, Badge, Empty, Button, ErrorNote } from '../components/ui';
import { MaterialsTab } from '../components/course/MaterialsTab';
import { ConceptsTab } from '../components/course/ConceptsTab';
import { NotesTab } from '../components/course/NotesTab';
import { FlashcardsTab } from '../components/course/FlashcardsTab';
import { QuizzesTab } from '../components/course/QuizzesTab';
import { TutorTab } from '../components/course/TutorTab';
import { ExamsTab } from '../components/course/ExamsTab';
import { FormulasTab } from '../components/course/FormulasTab';
import { PlanTab } from '../components/course/PlanTab';

const TABS = ['materials', 'concepts', 'notes', 'flashcards', 'quizzes', 'tutor', 'exams', 'formulas', 'plan'] as const;
type Tab = (typeof TABS)[number];

export function CourseDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('materials');
  const [cramData, setCramData] = useState<any | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api(`/courses/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);
  useEffect(() => {
    if (tab === 'plan' && id && !cramData) {
      api(`/courses/${id}/cram`).then((d) => setCramData(d)).catch(() => setCramData(null));
    }
  }, [tab, id, cramData]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner label={t.loading} />;
  if (!data.course) return <Empty title={t.noCourses} />;

  const { course, counts } = data;
  const tabLabels: Record<Tab, string> = {
    materials: `${t.materials} (${data.materials.length})`,
    concepts: `${t.concepts} (${data.concepts.length})`,
    notes: t.notes,
    flashcards: `${t.flashcards}${counts.due ? ` · ${counts.due}` : ''}`,
    quizzes: t.quizzes,
    tutor: t.tutor,
    exams: t.exams,
    formulas: t.formulas,
    plan: t.plan,
  };

  return (
    <div className="space-y-4">
      <div>
        <Link to="/courses" className="text-sm text-slate-400 hover:text-indigo-600">← {t.courses}</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-slate-900">{course.name}</h1>
          {course.code && <span className="text-sm text-slate-500">{course.code}</span>}
          {course.exam_date && (
            <Badge tone={course.exam_days_away != null && course.exam_days_away <= 7 ? 'MUST_KNOW' : 'SHOULD_KNOW'}>
              {course.exam_date}
            </Badge>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api(`/courses/${course.id}/recompute-priority`, { method: 'POST' });
              load();
            }}
          >
            ⚡ {t.priorityEngine}
          </Button>
          <Button size="sm" onClick={() => setTab('plan')}>
            ▶ {t.quickStudy}
          </Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {TABS.map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`whitespace-nowrap rounded-xl px-3 py-1.5 text-sm font-medium ${tab === tb ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'}`}
          >
            {tabLabels[tb]}
          </button>
        ))}
      </div>

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
