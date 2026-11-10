import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes } from '@securesend/shared';
import { get, post, patch, errorMessage } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { fmt } from '../../lib/time';
import { Badge } from '../../components/Status';
import { Dialog } from '../../components/Dialog';

interface U {
  id: string;
  email: string;
  displayName: string;
  role: 'sender' | 'auditor' | 'admin';
  authKind: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  quotaBytes: number | null;
  mfaEnrolled: boolean;
}

export function UsersPage() {
  const qc = useQueryClient();
  const { withStepUp, me } = useAuth();
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => get<{ users: U[] }>('/api/admin/users') });
  const [invite, setInvite] = useState({ email: '', displayName: '', role: 'sender' });
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [edit, setEdit] = useState<U | null>(null);
  const [form, setForm] = useState({ role: 'sender', status: 'active', quota: '', reason: '' });
  const [resetReason, setResetReason] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-users'] });
  const run = (fn: () => Promise<unknown>, ok: string) => withStepUp(fn).then(() => { setMsg({ tone: 'ok', text: ok }); refresh(); }).catch((e) => setMsg({ tone: 'err', text: errorMessage(e) }));
  const doInvite = (e: FormEvent) => {
    e.preventDefault();
    void withStepUp(() => post<{ invitationLink?: string }>('/api/admin/users/invite', invite)).then((r) => {
      setMsg({ tone: 'info', text: `Invitation queued for ${invite.email}.${r.invitationLink ? ` Development link: ${r.invitationLink}` : ''}` });
      setInvite({ email: '', displayName: '', role: 'sender' });
      refresh();
    }).catch((e) => setMsg({ tone: 'err', text: errorMessage(e) }));
  };
  const openEdit = (u: U) => {
    setEdit(u);
    setForm({ role: u.role, status: u.status === 'disabled' ? 'disabled' : 'active', quota: u.quotaBytes === null ? '' : String(Math.round(u.quotaBytes / 1024 ** 3)), reason: '' });
    setResetReason('');
  };
  const saveEdit = (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const body: Record<string, unknown> = { reason: form.reason };
    if (form.role !== edit.role) body.role = form.role;
    if (form.status !== (edit.status === 'disabled' ? 'disabled' : 'active')) body.status = form.status;
    const quotaBytes = form.quota === '' ? null : Number(form.quota) * 1024 ** 3;
    if (quotaBytes !== edit.quotaBytes) body.quotaBytes = quotaBytes;
    void run(() => patch(`/api/admin/users/${edit.id}`, body), 'User updated.').then(() => setEdit(null));
  };
  return (
    <>
      {msg && <div className={`notice notice-${msg.tone}`} role={msg.tone === 'err' ? 'alert' : 'status'} style={{ overflowWrap: 'anywhere' }}>{msg.text}</div>}
      <div className="page-head"><div><h1>People</h1><p>Everyone who can sign in. People using single sign-on appear here after their first sign-in.</p></div></div>
      <form className="card settings" onSubmit={doInvite} aria-labelledby="inv-h">
        <h2 id="inv-h" style={{ fontSize: '1.2rem' }}>Invite someone with a local account</h2>
        <p className="intro">They choose a password and must set up a passkey or authenticator app before they can send anything. Not needed for people who use single sign-on.</p>
        <div className="row">
          <div className="field"><label htmlFor="i-email">Email</label><input id="i-email" className="input" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="i-name">Display name</label><input id="i-name" className="input" value={invite.displayName} onChange={(e) => setInvite({ ...invite, displayName: e.target.value })} /></div>
          <div className="field"><label htmlFor="i-role">Role</label><select id="i-role" className="select" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}><option value="sender">Sender</option><option value="auditor">Auditor</option><option value="admin">Administrator</option></select></div>
          <div className="field" style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}><button className="btn btn-primary">Send invitation</button></div>
        </div>
      </form>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last signed in</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
          <tbody>
            {q.data?.users.map((u) => (
              <tr key={u.id}>
                <td style={{ overflowWrap: 'anywhere' }}><strong>{u.displayName || '—'}</strong><div className="small muted">{u.email}</div></td>
                <td>
                  {u.role === 'admin' ? 'Administrator' : u.role === 'auditor' ? 'Auditor' : 'Sender'}
                  <div className="small muted">{u.authKind === 'sso' ? 'Single sign-on' : 'Local account'}{u.quotaBytes !== null && ` · ${formatBytes(u.quotaBytes, 0)} allowance`}</div>
                </td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    {u.status === 'disabled' ? <Badge tone="err" label="Disabled" /> : u.status === 'invited' ? <Badge tone="neutral" label="Invited" /> : <Badge tone="ok" label="Active" />}
                    {u.authKind !== 'sso' && !u.mfaEnrolled && <Badge tone="warn" label="No second factor yet" />}
                  </div>
                </td>
                <td className="small num">{u.lastLoginAt ? fmt(u.lastLoginAt) : 'Never'}</td>
                <td><div className="row" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end', gap: 6 }}><button className="btn btn-sm" onClick={() => openEdit(u)}>Edit</button>{u.id !== me?.user?.id && <button className="btn btn-sm" onClick={() => void run(() => post(`/api/admin/users/${u.id}/revoke-sessions`), `${u.email} has been signed out everywhere.`)}>Sign out everywhere</button>}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog title={edit ? `Edit ${edit.email}` : ''} open={!!edit} onClose={() => setEdit(null)}>
        {edit && (
          <form onSubmit={saveEdit} id="u-form">
            <div className="field"><label htmlFor="u-role">Role</label><select id="u-role" className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="sender">Sender</option><option value="auditor">Auditor</option><option value="admin">Administrator</option></select><span className="hint">Changing role signs the user out everywhere and sends a security notice.</span></div>
            <div className="field"><label htmlFor="u-status">Status</label><select id="u-status" className="select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="active">Active</option><option value="disabled">Disabled</option></select></div>
            <div className="field"><label htmlFor="u-quota">Storage allowance in GiB <span className="muted" style={{ fontWeight: 400 }}>(empty for the standard allowance)</span></label><input id="u-quota" className="input" type="number" min={0} value={form.quota} onChange={(e) => setForm({ ...form, quota: e.target.value })} /></div>
            <div className="field"><label htmlFor="u-reason">Why? <span className="muted" style={{ fontWeight: 400 }}>Kept in the audit log.</span></label><input id="u-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary">Save</button></div>
            {edit.authKind === 'local' && (
              <>
                <hr className="divider" />
                <h3>They have lost their second factor</h3>
                <p className="small muted">Removes their passkeys, authenticator app and recovery codes, signs them out and emails them a security notice. They set up a new one at their next sign-in. Confirm the request is really from them first, by phone or in person.</p>
                <div className="field"><label htmlFor="u-rr">Reason (required)</label><input id="u-rr" className="input" value={resetReason} onChange={(e) => setResetReason(e.target.value)} /></div>
                <button type="button" className="btn btn-danger" disabled={!resetReason.trim()} onClick={() => void run(() => post(`/api/admin/users/${edit.id}/reset-mfa`, { reason: resetReason }), 'Second factor reset.').then(() => setEdit(null))}>Reset second factor</button>
              </>
            )}
          </form>
        )}
      </Dialog>
    </>
  );
}
