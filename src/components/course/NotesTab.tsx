import { useState } from 'react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button, Card, Empty, Markdownish } from '../ui';

export function NotesTab({ courseId }: { courseId: string }) {
  const { t } = useI18n();
  const [notes, setNotes] = useState<any[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  if (notes === null) {
    api<{ notes: any[] }>(`/courses/${courseId}/notes`).then((d) => setNotes(d.notes)).catch(() => setNotes([]));
  }

  const open = async (id: string) => {
    if (openId === id) return setOpenId(null);
    setOpenId(id);
    setContent(null);
    const { note } = await api<{ note: any }>(`/notes/${id}`);
    setContent(note.content);
  };

  const remove = async (id: string) => {
    await api(`/notes/${id}`, { method: 'DELETE' });
    setNotes(notes!.filter((n) => n.id !== id));
    if (openId === id) setOpenId(null);
  };

  if (!notes) return null;
  if (notes.length === 0) return <Empty title={t.empty} hint={`${t.concepts} → ${t.generateNotes}`} />;

  return (
    <div className="space-y-3">
      {notes.map((n) => (
        <Card key={n.id} className="p-4">
          <div className="flex items-center justify-between gap-2">
            <button className="text-start font-medium text-slate-900 hover:text-indigo-600" onClick={() => open(n.id)}>
              {n.title}
            </button>
            <Button size="sm" variant="danger" onClick={() => remove(n.id)}>
              {t.delete}
            </Button>
          </div>
          {openId === n.id && <div className="mt-3 border-t border-slate-100 pt-3">{content ? <Markdownish text={content} /> : t.loading}</div>}
        </Card>
      ))}
    </div>
  );
}
