import { Navigate, Route, Routes, useParams } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/Login';
import { ForgotPasswordPage, InvitePage, ResetPasswordPage } from './pages/AccountPages';
import { HomePage } from './pages/Home';
import { SentPage } from './pages/Sent';
import { TransferDetailPage } from './pages/TransferDetail';
import { ActivityPage } from './pages/Activity';
import { NotificationsPage } from './pages/Notifications';
import { SecurityPage } from './pages/Security';
import { RecipientPage } from './pages/Recipient';
import { AdminLayout } from './pages/admin/common';
import { AuditSection, BrandingSection, IdentitySection, NotificationsSection, StorageSection, TransferPolicySection, VerificationSection } from './pages/admin/Settings';
import { HealthPage } from './pages/admin/Health';
import { UsersPage } from './pages/admin/Users';

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
    <Routes>
      <Route path="/r/:token" element={<RecipientPage />} />
      <Route
        path="/*"
        element={
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/invite/:token" element={<InvitePage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route element={<Shell />}>
                <Route index element={<HomeForRole />} />
                <Route path="/sent" element={<SentPage />} />
                <Route path="/sent/:id" element={<TransferDetailPage />} />
                <Route path="/transfers" element={<Navigate to="/sent" replace />} />
                <Route path="/transfers/:id" element={<LegacyTransferRedirect />} />
                <Route path="/activity" element={<ActivityPage />} />
                <Route path="/notifications" element={<NotificationsPage />} />
                <Route path="/account/security" element={<SecurityPage />} />
                <Route path="/admin" element={<AdminOnly><AdminLayout /></AdminOnly>}>
                  <Route index element={<BrandingSection />} />
                  <Route path="identity" element={<IdentitySection />} />
                  <Route path="transfer-policy" element={<TransferPolicySection />} />
                  <Route path="verification" element={<VerificationSection />} />
                  <Route path="notifications" element={<NotificationsSection />} />
                  <Route path="storage" element={<StorageSection />} />
                  <Route path="audit" element={<AuditSection />} />
                  <Route path="health" element={<HealthPage />} />
                  <Route path="users" element={<UsersPage />} />
                </Route>
                <Route path="*" element={<div className="empty"><h2>Page not found</h2></div>} />
              </Route>
            </Routes>
          </AuthProvider>
        }
      />
    </Routes>
  );
}
