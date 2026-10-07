import { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Icon, LogoMark } from './ui';

export function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <button className="flex items-center gap-2.5" onClick={() => navigate('/dashboard')} aria-label={t.appName}>
            <LogoMark size={32} />
            <span className="text-[15px] font-bold tracking-tight">{t.appName}</span>
          </button>
          <nav className="hidden items-center gap-1 sm:flex">
            <NavItem to="/dashboard" icon="home">{t.dashboard}</NavItem>
            <NavItem to="/courses" icon="book">{t.courses}</NavItem>
            <NavItem to="/quick" icon="zap">{t.quickStudy}</NavItem>
          </nav>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
              className="flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              aria-label="Language"
            >
              <Icon name="globe" className="h-4 w-4" />
              {lang === 'en' ? 'ع' : 'EN'}
            </button>
            {user && (
              <button
                onClick={() => signOut()}
                className="flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
                aria-label={t.signOut}
              >
                <Icon name="logout" className="h-4 w-4" />
                <span className="hidden sm:inline">{t.signOut}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/90 backdrop-blur-md sm:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="grid grid-cols-3">
          <TabItem to="/dashboard" icon="home">{t.dashboard}</TabItem>
          <TabItem to="/courses" icon="book">{t.courses}</TabItem>
          <TabItem to="/quick" icon="zap">{t.quickStudy}</TabItem>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-6 pb-28 sm:pb-8">{children}</main>
    </div>
  );
}

function NavItem({ to, children, icon }: { to: string; children: ReactNode; icon: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
          isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`
      }
    >
      <Icon name={icon} className="h-4 w-4" />
      {children}
    </NavLink>
  );
}

function TabItem({ to, children, icon }: { to: string; children: ReactNode; icon: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
          isActive ? 'text-indigo-600' : 'text-slate-400 active:text-slate-600'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span className={`grid h-7 w-12 place-items-center rounded-lg transition-colors ${isActive ? 'bg-indigo-50' : ''}`}>
            <Icon name={icon} className="h-5 w-5" />
          </span>
          <span className="truncate">{children}</span>
        </>
      )}
    </NavLink>
  );
}
