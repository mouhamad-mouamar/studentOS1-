import { useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { api, uploadMaterialFile } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Badge, Button, Card, Empty, ErrorNote, Icon, useToast } from '../ui';

const ACCEPT = '.pdf,.pptx,.ppt,.docx,.doc,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.mp4,.mkv,.mov';

export function MaterialsTab({ courseId, materials, onChanged }: { courseId: string; materials: any[]; onChanged: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const { show } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pastExam, setPastExam] = useState(false);
  const [insightsFor, setInsightsFor] = useState<string | null>(null);
  const [insights, setInsights] = useState<any | null>(null);
  const [insightsBusy, setInsightsBusy] = useState(false);

  const toggleInsights = async (id: string) => {
    if (insightsFor === id) {
      setInsightsFor(null);
      setInsights(null);
      return;
    }
    setInsightsFor(id);
    setInsights(null);
    setInsightsBusy(true);
    try {
      const d = await api<any>(`/materials/${id}/insights`);
      setInsights(d);
    } catch {
      setInsights({ error: true });
    } finally {
      setInsightsBusy(false);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files || !user) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const path = await uploadMaterialFile(user.id, courseId, file);
        await api(`/courses/${courseId}/materials`, {
          method: 'POST',
          body: { filename: file.name, storage_path: path, mime: file.type, size: file.size, is_past_exam: pastExam },
        });
      }
      onChanged();
      show(t.uploaded, 'success');
    } catch (e: any) {
      setError(e.message || 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (id: string) => {
    await api(`/materials/${id}`, { method: 'DELETE' });
    onChanged();
  };

  const reprocess = async (id: string) => {
    await api(`/materials/${id}/reprocess`, { method: 'POST' });
    onChanged();
  };

  const statusBadge = (m: any) => {
    if (m.status === 'ready') return <Badge tone="NICE_TO_KNOW">{t.ready}</Badge>;
    if (m.status === 'processing' || m.status === 'uploaded')
      return (
        <Badge tone="SHOULD_KNOW">
          <span className="me-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          {t.processing}
        </Badge>
      );
    return <Badge tone="MUST_KNOW">{t.failed}: {m.error}</Badge>;
  };

  return (
    <div className="space-y-4">
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="animate-fade-up flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white px-6 py-8 text-center transition-colors hover:border-indigo-400 hover:bg-indigo-50/40 active:scale-[0.99] disabled:opacity-60"
      >
        <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => upload(e.target.files)} disabled={busy} />
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-indigo-50 text-indigo-500">
          {busy ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" /> : <Icon name="upload" className="h-6 w-6" />}
        </span>
        <span className="text-sm font-medium text-slate-700">{busy ? t.processing : t.upload}</span>
        <span className="text-xs text-slate-400">PDF · PPTX · DOCX · TXT · images · audio · video</span>
      </button>
      <label className="flex min-h-11 items-center gap-2.5 text-sm text-slate-600">
        <input type="checkbox" checked={pastExam} onChange={(e) => setPastExam(e.target.checked)} className="h-4 w-4 accent-indigo-600" />
        {t.markPastExam}
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}

      {materials.length === 0 ? (
        <Empty title={t.empty} hint={t.noCoursesHint} icon="file" />
      ) : (
        <Card className="stagger divide-y divide-slate-100">
          {materials.map((m) => (
            <div key={m.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-400">
                    <Icon name="file" className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {m.is_past_exam && <span className="me-1.5 rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">{t.markPastExam}</span>}
                      {m.filename}
                    </p>
                    <p className="text-xs text-slate-400">
                      {m.kind} · {m.char_count ? `${m.char_count.toLocaleString()} chars` : m.size_bytes ? `${Math.round(m.size_bytes / 1024)} KB` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {statusBadge(m)}
                  {m.status === 'ready' && (
                    <Button size="sm" variant="ghost" onClick={() => toggleInsights(m.id)} aria-label={t.insights}>
                      <Icon name="sparkles" className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{t.insights}</span>
                    </Button>
                  )}
                  {m.status === 'failed' && (
                    <Button size="sm" variant="secondary" onClick={() => reprocess(m.id)} aria-label="Reprocess">
                      <Icon name="refresh" className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button size="sm" variant="danger" onClick={() => remove(m.id)}>
                    {t.delete}
                  </Button>
                </div>
              </div>
              {insightsFor === m.id && (
                <div className="mt-3 rounded-xl bg-slate-50 px-4 py-3">
                  {insightsBusy ? (
                    <p className="text-xs text-slate-400">{t.loading}</p>
                  ) : !insights || insights.error ? (
                    <p className="text-xs text-slate-500">{t.noInsights}</p>
                  ) : (insights.concepts?.length || 0) === 0 && (insights.formulas?.length || 0) === 0 ? (
                    <p className="text-xs text-slate-500">{t.noInsights}</p>
                  ) : (
                    <div className="space-y-3">
                      {insights.emphasis?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {insights.emphasis.slice(0, 6).map((e: string, i: number) => (
                            <span key={i} className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-600">⚠ {e}</span>
                          ))}
                        </div>
                      )}
                      {insights.concepts?.length > 0 && (
                        <div>
                          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t.keyConcepts}</h4>
                          <ul className="mt-1 space-y-1">
                            {insights.concepts.slice(0, 8).map((c: any) => (
                              <li key={c.id} className="text-xs text-slate-600">
                                <span className="font-medium text-slate-800">{c.title}</span>
                                {c.summary && <span className="text-slate-400"> — {c.summary}</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {insights.formulas?.length > 0 && (
                        <div>
                          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t.formulas}</h4>
                          <ul className="mt-1 space-y-1">
                            {insights.formulas.slice(0, 6).map((f: any) => (
                              <li key={f.id} className="text-xs text-slate-600">
                                {f.name} <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-indigo-700">{f.expression}</code>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
