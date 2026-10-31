import { useState, type FormEvent } from 'react';
import { NavLink, Outlet, useNavigate, Navigate, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { get } from '../api';

export function Shell() {
  const { me, loading, options, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState('');
  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => get<{ unread: number }>('/api/notifications'), enabled: !!me?.user && me.user.authLevel === 'full', refetchInterval: 60_000 });
  if (loading) return <div className="content">Loading…</div>;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.user.authLevel !== 'full') return <Navigate to="/login" replace />;
  const user = me.user;
  const search = (e: FormEvent) => {
    e.preventDefault();
    nav(`/transfers?q=${encodeURIComponent(q)}`);
  };
  const isStaff = user.role === 'sender' || user.role === 'admin';
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <nav className="nav" aria-label="Main">
        <NavLink to="/transfers" className="nav-brand">
          {options?.logoDataUrl ? <img src={options.logoDataUrl} alt="" /> : <span className="mark" aria-hidden="true" />}
          <span>{options?.productName ?? 'Snelson Send'}</span>
        </NavLink>
        {isStaff && (
          <NavLink to="/transfers" className="nav-link">Transfers</NavLink>
        )}
        {isStaff && (
          <NavLink to="/transfers/new" className="nav-link">New transfer</NavLink>
        )}
        <NavLink to="/activity" className="nav-link">Activity</NavLink>
        <NavLink to="/notifications" className="nav-link">
          Notifications {notif.data?.unread ? <span className="badge-count" aria-label={`${notif.data.unread} unread`}>{notif.data.unread}</span> : null}
        </NavLink>
        {user.role === 'admin' && (
          <>
            <div className="nav-section">Administration</div>
            <NavLink to="/admin" className="nav-link">Settings</NavLink>
            <NavLink to="/admin/users" className="nav-link">Users</NavLink>
            <NavLink to="/admin/health" className="nav-link">System health</NavLink>
          </>
        )}
        <div className="nav-foot">{options?.organisationName}</div>
      </nav>
      <div className="main">
        <header className="topbar">
          {isStaff && (
            <form role="search" onSubmit={search}>
              <label htmlFor="global-search" className="visually-hidden">Search transfers</label>
              <input id="global-search" className="input" type="search" placeholder="Search transfers by title or recipient" value={q} onChange={(e) => setQ(e.target.value)} />
            </form>
          )}
          {isStaff && (
            <NavLink to="/transfers/new" className="btn btn-primary">New transfer</NavLink>
          )}
          <details className="user-menu">
            <summary aria-label="Account menu">
              <span>{user.displayName || user.email}</span>
              <span aria-hidden="true">▾</span>
            </summary>
            <div className="menu">
              <div className="who">
                {user.email}
                <br />
                Role: {user.role}
              </div>
              <NavLink to="/account/security">Account security</NavLink>
              <NavLink to="/notifications">Notification preferences</NavLink>
              <button type="button" onClick={() => void logout()}>Sign out</button>
            </div>
          </details>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
