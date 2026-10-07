import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Button, Card, Empty, Icon, Skeleton } from '../components/ui';

export function Courses() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [courses, setCourses] = useState<any[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [examDate, setExamDate] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api<{ courses: any[] }>('/courses').then((d) => setCourses(d.courses));
  useEffect(() => {
    load().catch(() => setCourses([]));
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api('/courses', { method: 'POST', body: { name, code, exam_date: examDate || null } });
      setName('');
      setCode('');
      setExamDate('');
      setShowForm(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!courses) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">{t.courses}</h1>
        <Button onClick={() => setShowForm(!showForm)}>
          <Icon name={showForm ? 'x' : 'plus'} className="h-4 w-4" />
          {showForm ? t.cancel : t.createCourse}
        </Button>
      </div>

      {showForm && (
        <Card className="animate-fade-up space-y-3 p-4">
          <input placeholder={t.courseName} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="grid gap-3 sm:grid-cols-2">
            <input placeholder={t.courseCode} value={code} onChange={(e) => setCode(e.target.value)} />
            <input type="date" aria-label={t.examDate} value={examDate} onChange={(e) => setExamDate(e.target.value)} />
          </div>
          <Button onClick={create} disabled={busy || !name.trim()}>{busy ? t.processing : t.add}</Button>
        </Card>
      )}

      {courses.length === 0 ? (
        <Empty title={t.noCourses} hint={t.noCoursesHint} action={<Button onClick={() => setShowForm(true)}><Icon name="plus" className="h-4 w-4" />{t.createCourse}</Button>} icon="book" />
      ) : (
        <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((c) => (
            <Link key={c.id} to={`/courses/${c.id}`}>
              <Card className="press h-full p-4 transition-all hover:-translate-y-0.5 hover:shadow-md">
                <h3 className="font-medium text-slate-900">{c.name}</h3>
                {c.code && <p className="text-sm text-slate-500">{c.code}</p>}
                {c.exam_date && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
                    <Icon name="calendar" className="h-3.5 w-3.5" />
                    {t.examDate}: {c.exam_date}
                  </p>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
