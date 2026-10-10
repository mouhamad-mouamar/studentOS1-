import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Icon, LogoMark, Markdownish, ThinkingDots } from '../ui';

export function TutorTab({ courseId }: { courseId: string }) {
  const { t, lang } = useI18n();
  const [messages, setMessages] = useState<any[] | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedQuestion, setFailedQuestion] = useState<string | null>(null);
  const [materials, setMaterials] = useState<any[]>([]);
  const [scopeIds, setScopeIds] = useState<string[] | null>(null); // null = All materials
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
    api<{ materials: any[] }>(`/courses/${courseId}/materials`)
      .then((d) => setMaterials((d.materials || []).filter((m: any) => m.status === 'ready')))
      .catch(() => setMaterials([]));
  }, [courseId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages?.length, busy]);

  const send = async (questionOverride?: string, mode = 'free') => {
    const question = (questionOverride ?? input).trim();
    if (!question || busy) return;
    if (!questionOverride) setInput('');
    else if (input.trim() === question) setInput(''); // retry: don't leave the stale question in the composer
    setError(null);
    setFailedQuestion(null);
    setMessages((m) => [...(m || []), { role: 'user', content: question }]);
    setBusy(true);
    try {
      const res = await api<{ answer: string; citations: any[]; coverageNotice?: string | null }>(`/courses/${courseId}/tutor`, {
        method: 'POST',
        body: { question, mode, materialIds: scopeIds ?? undefined },
      });
      setMessages((m) => [...(m || []), { role: 'assistant', content: res.answer, citations: res.citations, coverageNotice: res.coverageNotice || undefined }]);
    } catch (e: any) {
      const msg = e instanceof ApiError && e.code === 'AI_NOT_CONFIGURED' ? t.aiNotConfigured : e.message;
      setError(msg);
      // Keep the student's question: restore it into the composer (unless they
      // already typed something new) and offer a one-tap Retry.
      setFailedQuestion(question);
      if (!questionOverride) setInput((cur) => (cur.trim() ? cur : question));
    } finally {
      setBusy(false);
    }
  };

  if (!messages) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Source scope selector */}
      {materials.length > 0 && (
        <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4">
          <button
            onClick={() => setScopeIds(null)}
            className={`min-h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-xs font-medium transition-colors ${
              scopeIds === null ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.allMaterials}
          </button>
          {materials.map((m) => {
            const active = scopeIds !== null && scopeIds.includes(m.id);
            return (
              <button
                key={m.id}
                onClick={() =>
                  setScopeIds((cur) => {
                    const base = cur === null ? materials.map((x) => x.id) : cur;
                    return active ? base.filter((id) => id !== m.id) : [...base, m.id];
                  })
                }
                title={m.filename}
                className={`min-h-9 flex max-w-48 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-xs font-medium transition-colors ${
                  active ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Icon name="file" className="h-3 w-3 shrink-0" />
                <span className="truncate">{m.filename}</span>
              </button>
            );
          })}
        </div>
      )}

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
              {m.role === 'assistant' && (m as any).coverageNotice && (
                <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs leading-relaxed text-slate-500">{(m as any).coverageNotice}</p>
              )}
              {m.role === 'assistant' && (m.citations?.length > 0 ? (
                <details className="mt-2 border-t border-slate-100 pt-2">
                  <summary className="cursor-pointer select-none text-xs font-medium text-slate-400 hover:text-slate-600">
                    {t.evidence} ({m.citations.length})
                  </summary>
                  <ul className="mt-1.5 space-y-1.5">
                    {m.citations.map((c: any, j: number) => (
                      <li key={c.chunkId || j} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                        <span className="text-xs font-semibold text-indigo-600">[{j + 1}]</span>{' '}
                        <span className="text-xs font-medium text-slate-600">{c.source || 'material'}</span>
                        {typeof c.page === 'number' && <span className="text-xs text-slate-400"> · {t.page} {c.page}</span>}
                        {c.snippet && <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-slate-500">{c.snippet}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-400">{t.noEvidence}</p>
              ))}
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
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-red-700">{error}</p>
            {failedQuestion && <p className="mt-0.5 text-xs text-red-600/80">{t.retryHint}</p>}
          </div>
          {failedQuestion && (
            <Button size="sm" variant="secondary" onClick={() => send(failedQuestion)} disabled={busy}>
              {t.retry}
            </Button>
          )}
        </div>
      )}
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
