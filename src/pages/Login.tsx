import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { auth } from '../lib/supabase';
import { Button, Icon, LogoMark } from '../components/ui';

export function Login() {
  const { t } = useI18n();
  const [authError, setAuthError] = useState('');

  const openSignIn = () => {
    setAuthError('');
    try {
      auth.openSignInModal({
        redirectTo: window.location.origin,
        onError: (e) => {
          setAuthError(e instanceof Error ? e.message : 'Sign-in failed. Please try again.');
        },
      });
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : 'Sign-in failed. Please try again.');
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-indigo-50 via-slate-50 to-slate-50 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="logo-enter mx-auto mb-5 w-fit">
            <LogoMark size={64} />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{t.appName}</h1>
          <p className="mt-2 text-slate-500">{t.tagline}</p>
        </div>

        <div className="animate-fade-up rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" style={{ animationDelay: '0.15s' }}>
          <Button className="w-full" onClick={openSignIn}>
            {t.signIn}
          </Button>
          {authError && (
            <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {authError}
            </p>
          )}
          <p className="mt-4 text-center text-xs text-slate-400">
            Google or email — your courses stay private to your account.
          </p>
        </div>

        <div
          className="animate-fade-up mt-6 grid gap-3 text-sm text-slate-600"
          style={{ animationDelay: '0.3s' }}
        >
          {[
            { icon: 'upload', text: 'Upload your lecture notes, slides and past exams' },
            { icon: 'target', text: 'StudyOS finds what actually matters and what to study first' },
            { icon: 'zap', text: 'Practice with quizzes, flashcards and an AI tutor that knows your course' },
          ].map((f) => (
            <div key={f.icon} className="flex items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-indigo-500 shadow-sm">
                <Icon name={f.icon} className="h-4.5 w-4.5" />
              </span>
              <span>{f.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
