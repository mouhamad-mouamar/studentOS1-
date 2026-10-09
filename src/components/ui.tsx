import { createContext, useCallback, useContext, ReactNode, useState } from 'react';

/* ---------------- Logo ---------------- */

export function LogoMark({ size = 32, thinking = false, className = '' }: { size?: number; thinking?: boolean; className?: string }) {
  return (
    <span
      className={`logo-hover inline-grid shrink-0 place-items-center rounded-xl shadow-sm shadow-indigo-600/30 ${thinking ? 'logo-thinking' : ''} ${className}`}
      style={{ width: size, height: size, background: 'linear-gradient(135deg, #e6d09c 0%, #c9a86a 55%, #a5813c 100%)' }}
      aria-hidden
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none">
        <path d="M12 4.5 20 8.5 12 12.5 4 8.5Z" fill="white" />
        <path d="M7 11.4v4.1c0 1.9 2.2 3.4 5 3.4s5-1.5 5-3.4v-4.1l-5 2.5Z" fill="white" opacity="0.85" />
      </svg>
    </span>
  );
}

/* ---------------- Icons (dependency-free, stroke style) ---------------- */

const ICON_PATHS: Record<string, ReactNode> = {
  home: (
    <>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10.5V20h13v-9.5" />
      <path d="M10 20v-5.5h4V20" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>
  ),
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </>
  ),
  layers: (
    <>
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </>
  ),
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  cards: (
    <>
      <rect x="3" y="5" width="13" height="16" rx="2" />
      <path d="M8 3h11a2 2 0 0 1 2 2v13" />
    </>
  ),
  sigma: (
    <>
      <path d="M18 7V4H6l6.5 8L6 20h12v-3" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3l1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8L12 3z" />
      <path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  back: <path d="M19 12H5m7-7-7 7 7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.2" />
    </>
  ),
  trending: (
    <>
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 4v6h-6" />
      <path d="M3 20v-6h6" />
      <path d="M20 10a8 8 0 0 0-14.9-3M4 14a8 8 0 0 0 14.9 3" />
    </>
  ),
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
    </>
  ),
};

export function Icon({ name, className = 'h-4 w-4' }: { name: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {ICON_PATHS[name] ?? null}
    </svg>
  );
}

/* ---------------- Primitives ---------------- */

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
  const base =
    'inline-flex touch-manipulation select-none items-center justify-center gap-2 rounded-xl font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50';
  const sizes = size === 'sm' ? 'min-h-9 px-3 py-1.5 text-sm' : 'min-h-11 px-4 py-2.5 text-sm';
  const variants = {
    primary: 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/25 hover:bg-indigo-700 hover:shadow',
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

export function Skeleton({ className = 'h-4' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/* ---------------- Empty state ---------------- */

export function Empty({ title, hint, action, icon = 'sparkles' }: { title: string; hint?: string; action?: ReactNode; icon?: string }) {
  return (
    <div className="animate-fade-up flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-gradient-to-b from-slate-50 to-white px-6 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-indigo-50 text-indigo-500">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="max-w-md text-sm text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="animate-fade-up flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <div className="animate-fade-up flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
      <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/* ---------------- Toasts ---------------- */

type Toast = { id: number; message: string; tone: 'success' | 'error' | 'info' };
const ToastCtx = createContext<{ show: (message: string, tone?: Toast['tone']) => void }>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6" dir="ltr">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex max-w-md items-center gap-2 rounded-full border px-4 py-2.5 text-sm shadow-lg backdrop-blur"
            style={{
              animation: 'toast-in 0.3s cubic-bezier(0.16,1,0.3,1) both',
              background: t.tone === 'error' ? 'rgb(42 21 24 / 95%)' : t.tone === 'success' ? 'rgb(15 36 26 / 95%)' : 'rgb(28 28 34 / 95%)',
              borderColor: t.tone === 'error' ? '#52262a' : t.tone === 'success' ? '#1c4634' : '#2a2a32',
              color: t.tone === 'error' ? '#f3a8a8' : t.tone === 'success' ? '#7ce3a8' : '#d9d9e0',
            }}
          >
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} className="h-4 w-4 shrink-0" />
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/* ---------------- AI thinking indicator ---------------- */

export function ThinkingDots({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-label="AI is thinking">
      <span className="think-dot" />
      <span className="think-dot" />
      <span className="think-dot" />
    </span>
  );
}

/* ---------------- Markdown (unchanged renderer, small visual polish) ---------------- */

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
