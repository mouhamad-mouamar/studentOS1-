import { useState } from 'react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Card, ErrorNote, Icon } from '../ui';

const DURATIONS = [5, 10, 15, 30, 60];

export function PlanTab({ courseId, cramData }: { courseId: string; cramData: any | null }) {
  const { t } = useI18n();
  const [minutes, setMinutes] = useState(25);
  const [plan, setPlan] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (mode: 'quick' | 'cram') => {
    setBusy(true);
    setError(null);
    try {
      const { session } = await api<{ session: any }>(`/courses/${courseId}/sessions`, { method: 'POST', body: { minutes, mode } });
      setPlan(session);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (plan) {
    return (
      <Card className="mx-auto max-w-xl p-6">
        <p className="text-sm text-slate-500">{plan.kind === 'cram' ? t.cram : t.quickStudy} · {plan.duration_minutes} {t.minutes}</p>
        <ol className="mt-4 space-y-3">
          {plan.plan.steps.map((s: any, i: number) => (
            <li key={i} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-indigo-600 text-xs font-bold text-white">{i + 1}</span>
              <div>
                <p className="text-sm font-medium text-slate-800">{s.detail}</p>
                <p className="text-xs text-slate-500">{s.minutes} {t.minutes}</p>
              </div>
            </li>
          ))}
          {plan.plan.steps.length === 0 && <p className="text-sm text-slate-500">{t.empty}</p>}
        </ol>
        <Button
          className="mt-4"
          variant="secondary"
          onClick={async () => {
            await api(`/sessions/${plan.id}/complete`, { method: 'POST' });
            setPlan(null);
          }}
        >
          <Icon name="check" className="h-4 w-4" />
          Done
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="font-medium text-slate-900">{t.quickStudy}</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {DURATIONS.map((d) => (
            <button
              key={d}
              onClick={() => setMinutes(d)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${minutes === d ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {t.minutesHave(d)}
            </button>
          ))}
          <input
            type="number"
            min={5}
            max={180}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value) || 25)}
            className="w-24"
            aria-label={t.minutes}
          />
        </div>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => start('quick')} disabled={busy}>{t.start}</Button>
          <Button variant="secondary" onClick={() => start('cram')} disabled={busy}>{t.cram}</Button>
        </div>
        {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      </Card>

      {cramData && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="p-4">
            <h3 className="mb-2 font-medium text-slate-900">{t.mustKnow}</h3>
            {cramData.must_know.length === 0 ? (
              <p className="text-sm text-slate-500">{t.empty}</p>
            ) : (
              <ul className="space-y-1.5">
                {cramData.must_know.map((m: any) => (
                  <li key={m.id} className="text-sm text-slate-700">
                    • {m.title} <span className="text-xs text-slate-400">({m.priority.replace('_', ' ')})</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-4">
            <h3 className="mb-2 font-medium text-slate-900">{t.weakTopics}</h3>
            {cramData.weaknesses.length === 0 ? (
              <p className="text-sm text-slate-500">{t.empty}</p>
            ) : (
              <ul className="space-y-1.5">
                {cramData.weaknesses.map((w: any) => (
                  <li key={w.concept_id} className="text-sm text-slate-700">
                    • {w.concepts?.title} <span className="text-xs text-red-500">({w.score}/100)</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
