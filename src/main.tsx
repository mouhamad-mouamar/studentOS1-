import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './style.css';
import { I18nProvider } from './lib/i18n';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Spinner, ToastProvider } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Courses } from './pages/Courses';
import { CourseDetail } from './pages/CourseDetail';
import { QuickStudy } from './pages/QuickStudy';

function Protected({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!session) return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
}

function AppRoutes() {
  const { session, loading } = useAuth();
  if (loading) return <Spinner />;
  return (
    <Routes>
      <Route path="/" element={session ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/courses" element={<Protected><Courses /></Protected>} />
      <Route path="/courses/:id" element={<Protected><CourseDetail /></Protected>} />
      <Route path="/quick" element={<Protected><QuickStudy /></Protected>} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  </I18nProvider>,
);
