import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Card, ErrorNote, Markdownish } from '../ui';

export function TutorTab({ courseId }: { courseId: string }) {
  const { t, lang } = useI18n();
  const [messages, setMessages] = useState<any[] | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const quickChips: { mode: string; label: string }[] =
    lang === 'ar'
      ? [
          { mode: 'simplify', label: 'اشرح ببساطة' },
          { mode: 'example', label: 'أعطني مثالاً' },
          { mode: 'test', label: 'اختبرني' },
          { mode: 'why_wrong', label: 'لماذا إجابتي خاطئة؟' },
        ]
      : [
          { mode: 'simplify', label: 'Explain simply' },
          { mode: 'example', label: 'Give me an example' },
          { mode: 'test', label: 'Test me' },
          { mode: 'why_wrong', label: 'Why is my answer wrong?' },
        ];

  useEffect(() => {
    api<{ messages: any[] }>(`/courses/${courseId}/tutor`).then((d) => setMessages(d.messages)).catch(() => setMessages([]));
  }, [courseId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages?.length, busy]);

  const send = async (questionOverride?: string, mode = 'free') => {
    const question = (questionOverride ?? input).trim();
    if (!question || busy) return;
    if (!questionOverride) setInput('');
    setError(null);
    setMessages((m) => [...(m || []), { role: 'user', content: question }]);
    setBusy(true);
    try {
      const res = await api<{ answer: string; citations: any[] }>(`/courses/${courseId}/tutor`, { method: 'POST', body: { question, mode } });
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
      <div className="flex flex-wrap gap-1.5">
        {quickChips.map((chip) => (
          <button
            key={chip.mode}
            onClick={() => {
              const focus = latestConcept(messages);
              send(chip.mode === 'why_wrong' ? chip.label : `${chip.label}: ${focus || 'the most important course concept'}`, chip.mode);
            }}
            disabled={busy}
            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50"
          >
            {chip.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={t.askPlaceholder}
          disabled={busy}
        />
        <Button onClick={() => send()} disabled={busy || !input.trim()}>{t.send}</Button>
      </div>
    </div>
  );
}

function latestConcept(messages: any[] | null): string {
  if (!messages) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content) {
      const match = m.content.match(/"([^"]{3,60})"/);
      if (match) return match[1];
    }
  }
  return '';
}
