import { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

export function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <button className="flex items-center gap-2" onClick={() => navigate('/dashboard')}>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white">S</span>
            <span className="font-semibold">{t.appName}</span>
          </button>
          <nav className="hidden items-center gap-1 sm:flex">
            <NavItem to="/dashboard">{t.dashboard}</NavItem>
            <NavItem to="/courses">{t.courses}</NavItem>
            <NavItem to="/quick">{t.quickStudy}</NavItem>
          </nav>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
              className="rounded-lg px-2 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              {lang === 'en' ? 'ع' : 'EN'}
            </button>
            {user && (
              <button onClick={() => signOut()} className="rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100">
                {t.signOut}
              </button>
            )}
          </div>
        </div>
        <nav className="flex items-center justify-around border-t border-slate-100 px-2 py-1.5 sm:hidden">
          <NavItem to="/dashboard">{t.dashboard}</NavItem>
          <NavItem to="/courses">{t.courses}</NavItem>
          <NavItem to="/quick">{t.quickStudy}</NavItem>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

function NavItem({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`
      }
    >
      {children}
    </NavLink>
  );
}
