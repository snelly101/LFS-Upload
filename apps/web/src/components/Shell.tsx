import { Suspense, useEffect, useRef } from 'react';
import { NavLink, Outlet, Navigate, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { get } from '../api';
import { Brand } from './Brand';
import { Icon, Avatar } from './Icon';
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
  // The account menu closes when you go somewhere, click away or press Escape.
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [loc.pathname]);
  useEffect(() => {
    const away = (e: Event) => {
      const m = menu.current;
      if (!m?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !m.contains(e.target as Node)) m.open = false;
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', away);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', away);
    };
  }, []);
  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => get<{ unread: number }>('/api/notifications'), enabled: signedIn, refetchInterval: poll });
  // The "Request" destination only exists while the administrator allows file requests.
  const policy = useQuery({ queryKey: ['transfer-policy'], queryFn: () => get<{ transferPolicy: { allowFileRequests?: boolean } }>('/api/transfers/policy'), enabled: signedIn && me?.user?.role !== 'auditor', staleTime: 60_000 });
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
        <div className="strip-in">
        <NavLink to={canSend ? '/' : '/activity'} className="brand" aria-label={`${options?.productName ?? 'Secure File Send'} home`}>
          <Brand productName={options?.productName ?? 'Secure File Send'} organisationName={options?.organisationName ?? ''} logoDataUrl={options?.logoDataUrl} />
        </NavLink>
        <nav className="strip-nav" aria-label="Main">
          {canSend && <NavLink to="/" end><Icon name="send" /><span>Send</span></NavLink>}
          {canSend && policy.data?.transferPolicy.allowFileRequests !== false && policy.data && <NavLink to="/request"><Icon name="inbox" /><span>Request</span></NavLink>}
          {canSend && <NavLink to="/sent"><Icon name="list" /><span>Sent</span></NavLink>}
          {!canSend && <NavLink to="/activity"><Icon name="activity" /><span>Activity</span></NavLink>}
          {user.role === 'admin' && <NavLink to="/admin" aria-current={isAdminArea ? 'page' : undefined}><Icon name="sliders" /><span>Admin</span></NavLink>}
        </nav>
        <div className="strip-end">
          <NavLink to="/notifications" className="icon-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
            <Icon name="bell" size={20} />
            {unread > 0 && <span className="badge-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
          </NavLink>
          <details className="user-menu" ref={menu}>
            <summary aria-label="Account menu">
              <span className="avatar" aria-hidden="true">{initials || '?'}</span>
            </summary>
            <div className="menu">
              <div className="who">
                <Avatar text={user.displayName || user.email} />
                <span>
                  <strong>{user.displayName || user.email}</strong>
                  {user.email}
                </span>
              </div>
              <NavLink to="/notifications"><Icon name="bell" />Notifications {unread > 0 && <span className="badge-count">{unread}</span>}</NavLink>
              {canSend && <NavLink to="/activity"><Icon name="activity" />Activity log</NavLink>}
              <NavLink to="/account/security"><Icon name="shield" />Account & security</NavLink>
              <button type="button" onClick={() => void logout()}><Icon name="logout" />Sign out</button>
            </div>
          </details>
        </div>
        </div>
      </header>
      <main id="main" className={`content ${width}`} tabIndex={-1}>
        <Suspense fallback={<div className="loading" role="status">Loading…</div>}>
          <div key={isAdminArea ? '/admin' : loc.pathname} className="page-in">
            <Outlet />
          </div>
        </Suspense>
      </main>
    </div>
  );
}
