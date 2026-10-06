import { useI18n } from '../lib/i18n';
import { auth } from '../lib/supabase';
import { Button } from '../components/ui';

export function Login() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-indigo-50 via-slate-50 to-slate-50 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-indigo-600 text-xl font-bold text-white">S</span>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{t.appName}</h1>
          <p className="mt-2 text-slate-500">{t.tagline}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <Button className="w-full" onClick={() => auth.openSignInModal()}>
            {t.signIn}
          </Button>
          <p className="mt-4 text-center text-xs text-slate-400">
            Google or email — your courses stay private to your account.
          </p>
        </div>
      </div>
    </div>
  );
}
