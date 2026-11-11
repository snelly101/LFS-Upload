import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { SentPage } from './pages/Sent';
import { TransferDetailPage } from './pages/TransferDetail';

// Less-travelled pages load on demand; the admin console is a chunk only administrators ever fetch.
const AccountPages = () => import('./pages/AccountPages');
const InvitePage = lazy(() => AccountPages().then((m) => ({ default: m.InvitePage })));
const ForgotPasswordPage = lazy(() => AccountPages().then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => AccountPages().then((m) => ({ default: m.ResetPasswordPage })));
const ActivityPage = lazy(() => import('./pages/Activity').then((m) => ({ default: m.ActivityPage })));
const NotificationsPage = lazy(() => import('./pages/Notifications').then((m) => ({ default: m.NotificationsPage })));
const SecurityPage = lazy(() => import('./pages/Security').then((m) => ({ default: m.SecurityPage })));
const AdminArea = lazy(() => import('./pages/admin/AdminArea'));
const RequestPage = lazy(() => import('./pages/Request'));

const Loading = () => <div className="loading" role="status">Loading…</div>;

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  if (me?.user?.role !== 'admin') return <div className="notice notice-err">Administrators only.</div>;
  return <>{children}</>;
}

/** Auditors have no composer; their home is the activity log. */
function HomeForRole() {
  const { me } = useAuth();
  if (me?.user?.role === 'auditor') return <Navigate to="/activity" replace />;
  return <HomePage />;
}

function LegacyTransferRedirect() {
  const { id } = useParams();
  return <Navigate to={id === 'new' ? '/' : `/sent/${id}`} replace />;
}

export function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<Shell />}>
            <Route index element={<HomeForRole />} />
            <Route path="/request" element={<RequestPage />} />
            <Route path="/sent" element={<SentPage />} />
            <Route path="/sent/:id" element={<TransferDetailPage />} />
            <Route path="/transfers" element={<Navigate to="/sent" replace />} />
            <Route path="/transfers/:id" element={<LegacyTransferRedirect />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/account/security" element={<SecurityPage />} />
            <Route path="/admin/*" element={<AdminOnly><AdminArea /></AdminOnly>} />
            <Route path="*" element={<div className="empty"><h2>Page not found</h2></div>} />
          </Route>
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
