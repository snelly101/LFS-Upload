import { useEffect, useState } from 'react';

/**
 * QR code rendered as inline SVG rects (no images, no data: URLs, nothing leaves the browser).
 * Always drawn dark-on-white with a quiet zone so phone cameras can read it in either colour scheme.
 */
export function Qr({ value, caption }: { value: string; caption?: string }) {
  const [cells, setCells] = useState<boolean[][] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('qrcode-generator').then((m) => {
      const qrcode = m.default;
      const qr = qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      const n = qr.getModuleCount();
      const grid: boolean[][] = [];
      for (let r = 0; r < n; r++) {
        const row: boolean[] = [];
        for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
        grid.push(row);
      }
      if (!cancelled) setCells(grid);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [value]);
  if (!cells) return null;
  const n = cells.length;
  const quiet = 4;
  const size = n + quiet * 2;
  // One path per row run keeps the DOM small.
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!cells[r]![c]) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < n && cells[r]![c + run]) run++;
      d += `M${c + quiet} ${r + quiet}h${run}v1h-${run}z`;
      c += run;
    }
  }
  return (
    <figure className="qr">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code to add this account to an authenticator app" shapeRendering="crispEdges">
        <rect width={size} height={size} fill="#ffffff" />
        <path d={d} fill="#000000" />
      </svg>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Shared block for authenticator enrolment: QR first, link and manual key as fallbacks. */
export function TotpSetup({ otpauthUrl, secretBase32 }: { otpauthUrl: string; secretBase32: string }) {
  return (
    <>
      <Qr value={otpauthUrl} caption="Scan with your authenticator app" />
      <details style={{ marginBottom: 14 }}>
        <summary className="small">Can't scan it?</summary>
        <p className="small" style={{ marginTop: 8 }}>
          On the phone that has the app, <a href={otpauthUrl}>open this link</a>, or type this key into the app:
        </p>
        <p className="secret-key" aria-label="Setup key">{secretBase32.match(/.{1,4}/g)?.join(' ')}</p>
      </details>
    </>
  );
}
