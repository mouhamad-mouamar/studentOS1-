import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Card, Empty, ErrorNote, Icon, Skeleton, useToast } from '../ui';

export function FlashcardsTab({ courseId }: { courseId: string }) {
  const { t } = useI18n();
  const { show } = useToast();
  const [cards, setCards] = useState<any[] | null>(null);
  const [due, setDue] = useState<any[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [flipped, setFlipped] = useState(false);

  const load = async () => {
    const [all, dueData] = await Promise.all([
      api<{ cards: any[] }>(`/courses/${courseId}/flashcards`),
      api<{ cards: any[] }>(`/courses/${courseId}/flashcards?due=1`),
    ]);
    setCards(all.cards);
    setDue(dueData.cards);
  };

  useEffect(() => {
    load().catch(() => setCards([]));
  }, [courseId]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/courses/${courseId}/flashcards/generate`, { method: 'POST', body: { count: 8 } });
      await load();
      show(t.ready, 'success');
    } catch (e: any) {
      setError(e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message);
    } finally {
      setBusy(false);
    }
  };

  const addManual = async () => {
    if (!front.trim() || !back.trim()) return;
    await api('/flashcards', { method: 'POST', body: { course_id: courseId, front, back } });
    setFront('');
    setBack('');
    setAdding(false);
    await load();
  };

  const remove = async (id: string) => {
    await api(`/flashcards/${id}`, { method: 'DELETE' });
    if (reviewing) setDue(due.filter((c) => c.id !== id));
    await load();
  };

  const review = async (result: 'again' | 'hard' | 'good' | 'easy') => {
    const card = due[0];
    if (!card) return;
    await api(`/flashcards/${card.id}/review`, { method: 'POST', body: { result } });
    setDue(due.slice(1));
    setFlipped(false);
  };

  if (!cards) return <Skeleton className="h-64 rounded-2xl" />;

  if (reviewing) {
    const card = due[0];
    const total = due.length;
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div className="flex items-center justify-between">
          <Button size="sm" variant="ghost" onClick={() => { setReviewing(false); setFlipped(false); load(); }}>
            <Icon name="back" className="h-3.5 w-3.5 rtl:rotate-180" />
            {t.courses}
          </Button>
          <span className="text-sm text-slate-500">{t.left(total)}</span>
        </div>
        {total > 1 && (
          <div className="flex gap-1">
            {due.map((_, i) => (
              <div key={i} className={`h-1 flex-1 rounded-full ${i === 0 ? 'bg-indigo-500' : 'bg-slate-200'}`} />
            ))}
          </div>
        )}
        {!card ? (
          <Empty title={t.allDone} hint={t.noMoreDue} action={<Button onClick={() => { setReviewing(false); load(); }}>{t.dashboard}</Button>} icon="check" />
        ) : (
          <Card className="min-h-64 p-8 text-center shadow-md">
            <p className="text-lg font-medium leading-relaxed text-slate-900">{card.front}</p>
            {flipped && (
              <div className="animate-flip-reveal mt-4 border-t border-slate-100 pt-4">
                <p className="leading-relaxed text-slate-700">{card.back}</p>
                {card.concepts?.title && <p className="mt-2 text-xs text-slate-400">{card.concepts.title}</p>}
              </div>
            )}
            <div className="mt-8">
              {!flipped ? (
                <Button onClick={() => setFlipped(true)} className="min-w-32">
                  {t.flip}
                </Button>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-center">
                  <Button variant="danger" onClick={() => review('again')}>{t.again}</Button>
                  <Button variant="secondary" onClick={() => review('hard')}>{t.hard}</Button>
                  <Button onClick={() => review('good')}>{t.good}</Button>
                  <Button variant="secondary" onClick={() => review('easy')}>{t.easy}</Button>
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={generate} disabled={busy}>
          {busy ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              {t.processing}
            </>
          ) : (
            <>
              <Icon name="sparkles" className="h-4 w-4" />
              {t.generateCards}
            </>
          )}
        </Button>
        <Button variant="secondary" onClick={() => setAdding(!adding)}>
          <Icon name="plus" className="h-4 w-4" />
          {t.addCard}
        </Button>
        {due.length > 0 && <Button variant="secondary" onClick={() => setReviewing(true)}>{t.reviewDue} ({due.length})</Button>}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {adding && (
        <Card className="animate-fade-up space-y-3 p-4">
          <input placeholder={t.front} value={front} onChange={(e) => setFront(e.target.value)} />
          <input placeholder={t.back} value={back} onChange={(e) => setBack(e.target.value)} />
          <div className="flex gap-2">
            <Button onClick={addManual} disabled={!front.trim() || !back.trim()}>{t.save}</Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>{t.cancel}</Button>
          </div>
        </Card>
      )}
      {cards.length === 0 ? (
        <Empty title={t.empty} hint={t.noCoursesHint} icon="cards" />
      ) : (
        <div className="stagger grid gap-3 sm:grid-cols-2">
          {cards.map((c) => (
            <Card key={c.id} className="flex flex-col justify-between p-4">
              <div>
                <p className="font-medium leading-relaxed text-slate-900">{c.front}</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.back}</p>
                {c.concepts?.title && <p className="mt-2 text-xs text-slate-400">{c.concepts.title}</p>}
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                <span>
                  {c.reps > 0 ? `rep ${c.reps} · int ${c.interval_days}d` : 'new'} · due {new Date(c.due_at).toLocaleDateString()}
                </span>
                <button
                  onClick={() => remove(c.id)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
                  aria-label={t.delete}
                >
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
