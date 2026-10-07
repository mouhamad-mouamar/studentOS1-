import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Card, ErrorNote, Icon, LogoMark, Markdownish, ThinkingDots } from '../ui';

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
          <div className="animate-fade-up flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
            <LogoMark size={44} thinking />
            <p className="text-sm font-medium text-slate-600">{t.tutor}</p>
            <p className="max-w-sm text-sm text-slate-400">{t.askPlaceholder}</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`animate-fade-up flex ${m.role === 'user' ? 'justify-end' : 'items-start gap-2.5'}`}>
            {m.role === 'assistant' && <LogoMark size={28} className="mt-0.5 hidden sm:inline-grid" />}
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                m.role === 'user'
                  ? 'rounded-ee-md bg-indigo-600 text-white'
                  : 'rounded-es-md border border-slate-200 bg-white'
              }`}
            >
              {m.role === 'user' ? m.content : <Markdownish text={m.content} />}
              {m.role === 'assistant' && m.citations?.length > 0 && (
                <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-400">
                  {t.sources}: {[...new Set(m.citations.map((c: any) => c.source || 'material'))].join(', ')}
                </p>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2.5">
            <LogoMark size={28} thinking />
            <div className="rounded-2xl rounded-es-md border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
              <ThinkingDots className="text-indigo-400" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5">
        {quickChips.map((chip) => (
          <button
            key={chip.mode}
            onClick={() => {
              const focus = latestConcept(messages);
              send(chip.mode === 'why_wrong' ? chip.label : `${chip.label}: ${focus || 'the most important course concept'}`, chip.mode);
            }}
            disabled={busy}
            className="min-h-9 shrink-0 whitespace-nowrap rounded-full border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-600 transition-all hover:border-indigo-300 hover:text-indigo-600 active:scale-[0.97] disabled:opacity-50"
          >
            {chip.label}
          </button>
        ))}
      </div>
      <div className="sticky bottom-16 flex gap-2 sm:bottom-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={t.askPlaceholder}
          disabled={busy}
        />
        <Button onClick={() => send()} disabled={busy || !input.trim()} aria-label={t.send} className="px-4">
          <Icon name="send" className="h-4 w-4 rtl:-scale-x-100" />
          <span className="hidden sm:inline">{t.send}</span>
        </Button>
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
