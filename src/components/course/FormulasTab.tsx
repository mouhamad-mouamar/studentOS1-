import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Card, Empty, Skeleton } from '../ui';

export function FormulasTab({ courseId }: { courseId: string }) {
  const { t } = useI18n();
  const [formulas, setFormulas] = useState<any[] | null>(null);

  useEffect(() => {
    api<{ formulas: any[] }>(`/courses/${courseId}/formulas`).then((d) => setFormulas(d.formulas)).catch(() => setFormulas([]));
  }, [courseId]);

  if (!formulas) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
    );
  }
  if (formulas.length === 0) return <Empty title={t.empty} hint="Formulas found in your material appear here after processing." icon="sigma" />;

  return (
    <div className="stagger grid gap-3 sm:grid-cols-2">
      {formulas.map((f) => (
        <Card key={f.id} className="p-4">
          <p className="font-medium text-slate-900">{f.name}</p>
          <p className="mt-2 rounded-lg bg-gradient-to-r from-indigo-50 to-slate-50 px-3 py-2.5 font-mono text-sm text-indigo-700" dir="ltr" style={{ textAlign: 'start' }}>
            {f.expression}
          </p>
          {f.explanation && <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.explanation}</p>}
          {f.concepts?.title && <p className="mt-2 text-xs text-slate-400">{f.concepts.title}</p>}
        </Card>
      ))}
    </div>
  );
}
