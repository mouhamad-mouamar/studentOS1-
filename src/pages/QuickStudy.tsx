import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Button, Card, Empty, Spinner } from '../components/ui';

const DURATIONS = [5, 10, 15, 30, 60];

interface Rec {
  action: string;
  courseId: string | null;
  courseName: string | null;
  kind: string;
  minutes: number;
  reasons: string[];
  detail: string;
}

export function QuickStudy() {
  const { t } = useI18n();
  const [minutes, setMinutes] = useState<number | null>(null);
  const [recs, setRecs] = useState<Rec[] | null>(null);
  const [loading, setLoading] = useState(false);

  const ask = async (m: number) => {
    setMinutes(m);
    setLoading(true);
    try {
      const { recommendations } = await api<{ recommendations: Rec[] }>(`/recommendations?minutes=${m}`);
      setRecs(recommendations);
    } catch {
      setRecs([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{t.quickStudy}</h1>
        <p className="mt-1 text-sm text-slate-500">{t.recommended}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {DURATIONS.map((d) => (
          <button
            key={d}
            onClick={() => ask(d)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${minutes === d ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'}`}
          >
            {t.minutesHave(d)}
          </button>
        ))}
      </div>

      {loading && <Spinner />}

      {minutes != null && !loading && recs && (
        <div className="space-y-3">
          {recs.length === 0 ? (
            <Empty title={t.noCourses} hint={t.noCoursesHint} action={<Link to="/courses"><Button>{t.createCourse}</Button></Link>} />
          ) : (
            recs.map((r, i) => (
              <Card key={i} className={`p-4 ${i === 0 ? 'ring-2 ring-indigo-500' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium text-slate-900">{r.action}</h3>
                    {r.courseName && <p className="text-sm text-slate-500">{r.courseName}</p>}
                  </div>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{r.minutes}m</span>
                </div>
                <p className="mt-2 text-sm text-slate-600">{r.detail}</p>
                {r.reasons.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {r.reasons.map((reason, j) => (
                      <li key={j} className="text-xs text-slate-400">• {reason}</li>
                    ))}
                  </ul>
                )}
                {r.courseId && (
                  <Link to={`/courses/${r.courseId}`} className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:underline">
                    {t.start} →
                  </Link>
                )}
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
