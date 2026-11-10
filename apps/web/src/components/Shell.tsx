import { Suspense } from 'react';
import { NavLink, Outlet, Navigate, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { get } from '../api';
import { Brand } from './Brand';
import { useLiveEvents, usePollInterval } from '../lib/live';

/**
 * Staff shell: a single top strip. Sending is the home page, so there is no navigation to "get to"
 * the main job. "Sent" is the history; Administration is one link for admins only.
 */
export function Shell() {
  const { me, loading, options, logout } = useAuth();
  const loc = useLocation();
  const qc = useQueryClient();
  const signedIn = !!me?.user && me.user.authLevel === 'full';
  useLiveEvents(qc, signedIn);
  const poll = usePollInterval(60_000);
  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => get<{ unread: number }>('/api/notifications'), enabled: signedIn, refetchInterval: poll });
  if (loading) return <div className="loading" role="status">Loading…</div>;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.user.authLevel !== 'full') return <Navigate to="/login" replace />;
  const user = me.user;
  const canSend = user.role === 'sender' || user.role === 'admin';
  const initials = (user.displayName || user.email).split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
  const unread = notif.data?.unread ?? 0;
  const isAdminArea = loc.pathname.startsWith('/admin');
  const width = isAdminArea ? 'wide' : loc.pathname.startsWith('/activity') || loc.pathname.startsWith('/account') || loc.pathname.startsWith('/notifications') ? 'mid' : 'narrow';
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="strip">
        <NavLink to={canSend ? '/' : '/activity'} className="brand" aria-label={`${options?.productName ?? 'Secure File Send'} home`}>
          <Brand productName={options?.productName ?? 'Secure File Send'} organisationName={options?.organisationName ?? ''} logoDataUrl={options?.logoDataUrl} />
        </NavLink>
        <nav className="strip-nav" aria-label="Main">
          {canSend && <NavLink to="/" end>Send</NavLink>}
          {canSend && <NavLink to="/sent">Sent</NavLink>}
          {!canSend && <NavLink to="/activity">Activity</NavLink>}
          {user.role === 'admin' && <NavLink to="/admin" aria-current={isAdminArea ? 'page' : undefined}>Admin</NavLink>}
        </nav>
        <details className="user-menu">
          <summary aria-label={`Account menu${unread ? `, ${unread} unread notifications` : ''}`}>
            <span className="avatar" aria-hidden="true">{initials || '?'}</span>
            {unread > 0 && <span className="badge-count">{unread}</span>}
          </summary>
          <div className="menu">
            <div className="who">
              <strong>{user.displayName || user.email}</strong>
              {user.email}
            </div>
            <NavLink to="/notifications">Notifications {unread > 0 && <span className="badge-count">{unread}</span>}</NavLink>
            {canSend && <NavLink to="/activity">Activity log</NavLink>}
            <NavLink to="/account/security">Account & security</NavLink>
            <button type="button" onClick={() => void logout()}>Sign out</button>
          </div>
        </details>
      </header>
      <main id="main" className={`content ${width}`} tabIndex={-1}>
        <Suspense fallback={<div className="loading" role="status">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
