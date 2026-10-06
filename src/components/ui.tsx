import { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled,
  className = '',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const sizes = size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2.5 text-sm';
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
    ghost: 'text-slate-600 hover:bg-slate-100',
    danger: 'bg-red-50 text-red-600 hover:bg-red-100',
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${sizes} ${variants} ${className}`}>
      {children}
    </button>
  );
}

const priorityStyles: Record<string, string> = {
  MUST_KNOW: 'bg-red-100 text-red-700',
  SHOULD_KNOW: 'bg-amber-100 text-amber-700',
  NICE_TO_KNOW: 'bg-sky-100 text-sky-700',
  LOW_PRIORITY: 'bg-slate-100 text-slate-600',
};

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: string }) {
  const cls = priorityStyles[tone] || 'bg-slate-100 text-slate-600';
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-slate-500">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="max-w-md text-sm text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{children}</div>;
}

export function Markdownish({ text }: { text: string }) {
  // Minimal, safe markdown rendering (no HTML injection): headings, bold, code, lists.
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      out.push(
        <ul key={`ul-${out.length}`} className="my-2 list-disc space-y-1 ps-6">
          {list.map((li, i) => (
            <li key={i}>{inline(li)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const line of lines) {
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    flush();
    if (/^#{1,6}\s/.test(line)) {
      out.push(
        <h3 key={out.length} className="mt-4 mb-1 text-lg font-semibold text-slate-900">
          {inline(line.replace(/^#{1,6}\s/, ''))}
        </h3>,
      );
    } else if (line.trim() === '') {
      out.push(<div key={out.length} className="h-2" />);
    } else {
      out.push(
        <p key={out.length} className="my-1 leading-relaxed">
          {inline(line)}
        </p>,
      );
    }
  }
  flush();
  return <div className="text-slate-700">{out}</div>;
}

function inline(s: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) parts.push(<code key={k++} className="rounded bg-slate-100 px-1 py-0.5 text-sm">{tok.slice(1, -1)}</code>);
    else parts.push(<sup key={k++} className="mx-0.5 rounded bg-indigo-50 px-1 text-xs font-medium text-indigo-600">{tok.slice(1, -1)}</sup>);
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
