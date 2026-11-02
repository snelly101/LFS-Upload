import { NavLink, Outlet, Navigate, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { get } from '../api';

/**
 * Staff shell: a single top strip. Sending is the home page, so there is no navigation to "get to"
 * the main job. "Sent" is the history; Administration is one link for admins only.
 */
export function Shell({ width = 'narrow' }: { width?: 'narrow' | 'wide' }) {
  const { me, loading, options, logout } = useAuth();
  const loc = useLocation();
  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => get<{ unread: number }>('/api/notifications'), enabled: !!me?.user && me.user.authLevel === 'full', refetchInterval: 60_000 });
  if (loading) return <div className="content">Loading…</div>;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.user.authLevel !== 'full') return <Navigate to="/login" replace />;
  const user = me.user;
  const canSend = user.role === 'sender' || user.role === 'admin';
  const initials = (user.displayName || user.email).split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
  const unread = notif.data?.unread ?? 0;
  const isAdminArea = loc.pathname.startsWith('/admin');
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="strip">
        <NavLink to={canSend ? '/' : '/activity'} className="strip-brand">
          {options?.logoDataUrl ? <img src={options.logoDataUrl} alt="" /> : <span className="mark" aria-hidden="true" />}
          <span>{options?.productName ?? 'Together Housing Secure File Send'}</span>
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
              {user.displayName || user.email}
              <br />
              {user.email}
            </div>
            <NavLink to="/notifications">Notifications {unread > 0 && <span className="badge-count">{unread}</span>}</NavLink>
            {canSend && <NavLink to="/activity">Activity log</NavLink>}
            <NavLink to="/account/security">Account & security</NavLink>
            <button type="button" onClick={() => void logout()}>Sign out</button>
          </div>
        </details>
      </header>
      <main id="main" className={`content ${isAdminArea || width === 'wide' ? 'wide' : 'narrow'}`} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
