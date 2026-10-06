import { useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { api, uploadMaterialFile } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Badge, Button, Card, Empty, ErrorNote } from '../ui';

const ACCEPT = '.pdf,.pptx,.ppt,.docx,.doc,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.mp4,.mkv,.mov';

export function MaterialsTab({ courseId, materials, onChanged }: { courseId: string; materials: any[]; onChanged: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pastExam, setPastExam] = useState(false);

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
    if (m.status === 'processing' || m.status === 'uploaded') return <Badge tone="SHOULD_KNOW">{t.processing}</Badge>;
    return <Badge tone="MUST_KNOW">{t.failed}: {m.error}</Badge>;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer">
          <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => upload(e.target.files)} disabled={busy} />
          <span className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">
            {busy ? t.processing : t.upload}
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={pastExam} onChange={(e) => setPastExam(e.target.checked)} className="h-4 w-4" />
          {t.markPastExam}
        </label>
        <p className="text-xs text-slate-400">PDF · PPTX · DOCX · TXT · images · audio · video</p>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      {materials.length === 0 ? (
        <Empty title={t.empty} hint={t.noCoursesHint} />
      ) : (
        <Card className="divide-y divide-slate-100">
          {materials.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">
                  {m.is_past_exam && <span className="me-1.5 rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">{t.markPastExam}</span>}
                  {m.filename}
                </p>
                <p className="text-xs text-slate-400">
                  {m.kind} · {m.char_count ? `${m.char_count.toLocaleString()} chars` : m.size_bytes ? `${Math.round(m.size_bytes / 1024)} KB` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {statusBadge(m)}
                {m.status === 'failed' && (
                  <Button size="sm" variant="secondary" onClick={() => reprocess(m.id)}>
                    ↻
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={() => remove(m.id)}>
                  {t.delete}
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
