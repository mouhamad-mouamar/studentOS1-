import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Card, ErrorNote, Markdownish } from '../ui';

export function TutorTab({ courseId }: { courseId: string }) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<any[] | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ messages: any[] }>(`/courses/${courseId}/tutor`).then((d) => setMessages(d.messages)).catch(() => setMessages([]));
  }, [courseId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages?.length, busy]);

  const send = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput('');
    setError(null);
    setMessages((m) => [...(m || []), { role: 'user', content: question }]);
    setBusy(true);
    try {
      const res = await api<{ answer: string; citations: any[] }>(`/courses/${courseId}/tutor`, { method: 'POST', body: { question } });
      setMessages((m) => [...(m || []), { role: 'assistant', content: res.answer, citations: res.citations }]);
    } catch (e: any) {
      const msg = e instanceof ApiError && e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message;
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  if (!messages) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-3">
        {messages.length === 0 && (
          <p className="rounded-xl bg-slate-100 px-4 py-6 text-center text-sm text-slate-500">{t.askPlaceholder}</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white'}`}>
              {m.role === 'user' ? m.content : <Markdownish text={m.content} />}
              {m.role === 'assistant' && m.citations?.length > 0 && (
                <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-400">
                  {t.sources}: {[...new Set(m.citations.map((c: any) => c.source || 'material'))].join(', ')}
                </p>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="text-sm text-slate-400">…</div>}
        <div ref={bottomRef} />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={t.askPlaceholder}
          disabled={busy}
        />
        <Button onClick={send} disabled={busy || !input.trim()}>{t.send}</Button>
      </div>
    </div>
  );
}
