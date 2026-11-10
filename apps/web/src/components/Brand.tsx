import type { ReactNode } from 'react';

/** "Together Housing Secure File Send" + "Together Housing" → overline "Together Housing", name "Secure File Send". */
export function brandParts(productName: string, organisationName: string): { org: string | null; name: string } {
  const p = productName.trim();
  const o = organisationName.trim();
  if (o && p.toLowerCase().startsWith(o.toLowerCase()) && p.length > o.length + 1) return { org: o, name: p.slice(o.length).trim() };
  return { org: o && o.toLowerCase() !== p.toLowerCase() ? o : null, name: p || o };
}

export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const skip = new Set(['the', 'of', 'and', 'for', 'ltd', 'limited', 'plc', 'llp']);
  const picked = words.filter((w) => !skip.has(w.toLowerCase()));
  const src = picked.length ? picked : words;
  return src.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '•';
}

/** Monogram drawn from the organisation's initials; used whenever no logo has been uploaded. */
export function Monogram({ name, large }: { name: string; large?: boolean }) {
  return <span className={`monogram${large ? ' lg' : ''}`} aria-hidden="true">{initials(name)}</span>;
}

export function Brand({ productName, organisationName, logoDataUrl, large, children }: { productName: string; organisationName: string; logoDataUrl?: string | null; large?: boolean; children?: ReactNode }) {
  const { org, name } = brandParts(productName, organisationName);
  return (
    <>
      {logoDataUrl ? <img src={logoDataUrl} alt="" /> : <Monogram name={organisationName || productName} large={large} />}
      <span className="brand-text">
        {org && <span className="brand-org">{org}</span>}
        <span className="brand-name">{name}</span>
      </span>
      {children}
    </>
  );
}
