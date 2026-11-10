import { Suspense } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { AuditSection, BrandingSection, IdentitySection, NotificationsSection, StorageSection, TransferPolicySection, VerificationSection } from './Settings';
import { HealthPage } from './Health';
import { UsersPage } from './Users';

/** Administration: its own chunk, grouped by what an administrator is trying to do. */
export default function AdminArea() {
  return (
    <div className="admin-layout">
      <nav className="subnav" aria-label="Administration">
        <span className="group">Day to day</span>
        <NavLink to="/admin" end>System health</NavLink>
        <NavLink to="/admin/users">People</NavLink>
        <span className="group">Rules</span>
        <NavLink to="/admin/transfer-policy">What can be sent</NavLink>
        <NavLink to="/admin/verification">Recipient verification</NavLink>
        <NavLink to="/admin/identity">Sign-in</NavLink>
        <span className="group">Messages</span>
        <NavLink to="/admin/notifications">Email and notices</NavLink>
        <span className="group">Data</span>
        <NavLink to="/admin/storage">Storage and deletion</NavLink>
        <NavLink to="/admin/audit">Audit and privacy</NavLink>
        <span className="group">Appearance</span>
        <NavLink to="/admin/branding">Branding</NavLink>
      </nav>
      <div style={{ minWidth: 0 }}>
        <Suspense fallback={<div className="loading" role="status">Loading…</div>}>
          <Routes>
            <Route index element={<HealthPage />} />
            <Route path="health" element={<HealthPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="transfer-policy" element={<TransferPolicySection />} />
            <Route path="verification" element={<VerificationSection />} />
            <Route path="identity" element={<IdentitySection />} />
            <Route path="notifications" element={<NotificationsSection />} />
            <Route path="storage" element={<StorageSection />} />
            <Route path="audit" element={<AuditSection />} />
            <Route path="branding" element={<BrandingSection />} />
            <Route path="*" element={<div className="empty"><h2>Page not found</h2></div>} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
