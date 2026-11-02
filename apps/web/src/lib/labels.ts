export function prefLabel(k: string): string {
  return (
    {
      firstVerifiedView: 'first verified view',
      firstDownload: 'first / all-files download',
      everyDownload: 'every download',
      expiringSoon: 'expiring soon',
      expiredWithoutDownload: 'expired without download',
      deletionCompleted: 'deletion completed',
    } as Record<string, string>
  )[k] ?? k;
}

/** Short reference shown to users and useful for support ("ref 4A647BA1"). */
export function refCode(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

/** "sam@example.com" → "Sam"; falls back to the address. Only used for friendly button text. */
export function firstName(email: string): string {
  const local = email.split('@')[0] ?? email;
  const part = local.split(/[._-]/)[0] ?? local;
  if (!/^[a-z]{2,}$/i.test(part)) return email;
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

export function peopleLabel(emails: string[]): string {
  if (emails.length === 0) return 'recipients';
  if (emails.length === 1) return firstName(emails[0]!);
  if (emails.length === 2) return `${firstName(emails[0]!)} and ${firstName(emails[1]!)}`;
  return `${emails.length} people`;
}
