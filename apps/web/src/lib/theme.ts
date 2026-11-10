/**
 * Theme application. Two themes ('civic', 'clear') × two schemes (light, dark) are defined as CSS
 * tokens in styles/tokens.css. The organisation's accent colour is the only runtime-computed part:
 * from one hex value we derive a button colour, a text-safe variant, a tint and the text colour to
 * put on top of it, each checked against WCAG AA for the active scheme.
 */
export type ThemeName = 'civic' | 'clear';
export type SchemePref = 'auto' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

export interface BrandOptions {
  theme?: ThemeName;
  colourScheme?: SchemePref;
  accentColour?: string;
}

type RGB = [number, number, number];

export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
export function luminance([r, g, b]: RGB): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/** Move a colour towards black or white until it reaches the wanted contrast against `against`. */
export function ensureContrast(c: RGB, against: RGB, want: number, towards: RGB): RGB {
  let out = c;
  for (let i = 0; i < 40 && contrast(out, against) < want; i++) out = mix(out, towards, 0.06);
  return out;
}

/** Surfaces per theme/scheme: [paper, surface]. Kept in step with tokens.css. */
const SURFACES: Record<ThemeName, Record<Scheme, [RGB, RGB]>> = {
  civic: { light: [[244, 240, 232], [255, 253, 248]], dark: [[22, 25, 26], [31, 35, 36]] },
  clear: { light: [[245, 246, 248], [255, 255, 255]], dark: [[15, 18, 22], [23, 27, 33]] },
};

export interface AccentTokens {
  accent: string;
  accentStrong: string;
  accentInk: string;
  accentTint: string;
  accentLine: string;
  onAccent: string;
  /** Contrast of the chosen on-accent text against the accent fill. */
  fillContrast: number;
  /** True when the supplied colour had to be adjusted to stay readable. */
  adjusted: boolean;
}

export function deriveAccent(hex: string, theme: ThemeName, scheme: Scheme): AccentTokens {
  const base = parseHex(hex) ?? [17, 102, 92];
  const [paper, surface] = SURFACES[theme][scheme];
  // Fill: must stand out from the surface (≥ 3:1 for UI components).
  const fill = ensureContrast(base, surface, 3, scheme === 'dark' ? WHITE : BLACK);
  const onWhite = contrast(fill, WHITE);
  const onBlack = contrast(fill, [17, 20, 22]);
  const on: RGB = onWhite >= 4.5 || onWhite >= onBlack ? WHITE : [17, 20, 22];
  // Accent used as text/links on paper and surface: ≥ 4.5:1 against both.
  let ink = ensureContrast(base, paper, 4.6, scheme === 'dark' ? WHITE : BLACK);
  ink = ensureContrast(ink, surface, 4.6, scheme === 'dark' ? WHITE : BLACK);
  const tint = mix(surface, fill, scheme === 'dark' ? 0.2 : 0.1);
  const strong = mix(fill, scheme === 'dark' ? WHITE : BLACK, 0.14);
  return {
    accent: toHex(fill),
    accentStrong: toHex(strong),
    accentInk: toHex(ensureContrast(ink, tint, 4.5, scheme === 'dark' ? WHITE : BLACK)),
    accentTint: toHex(tint),
    accentLine: toHex(mix(surface, fill, scheme === 'dark' ? 0.45 : 0.35)),
    onAccent: toHex(on),
    fillContrast: contrast(fill, on),
    adjusted: toHex(fill).toLowerCase() !== toHex(base).toLowerCase(),
  };
}

const STORE_KEY = 'securesend-appearance';
let current: Required<BrandOptions> = { theme: 'civic', colourScheme: 'auto', accentColour: '#11665C' };
let mq: MediaQueryList | null = null;

function resolveScheme(pref: SchemePref): Scheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function paint() {
  const root = document.documentElement;
  const scheme = resolveScheme(current.colourScheme);
  root.dataset.theme = current.theme;
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
  const a = deriveAccent(current.accentColour, current.theme, scheme);
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set('--accent', a.accent);
  set('--accent-strong', a.accentStrong);
  set('--accent-ink', a.accentInk);
  set('--accent-tint', a.accentTint);
  set('--accent-line', a.accentLine);
  set('--on-accent', a.onAccent);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--paper').trim() || '#ffffff');
}

/** Apply branding from the server (or from the last visit, before the server has answered). */
export function applyBrand(opts: BrandOptions, persist = true) {
  current = {
    theme: opts.theme === 'clear' ? 'clear' : opts.theme === 'civic' ? 'civic' : current.theme,
    colourScheme: opts.colourScheme ?? current.colourScheme,
    accentColour: opts.accentColour && parseHex(opts.accentColour) ? opts.accentColour : current.accentColour,
  };
  paint();
  if (!mq && typeof window !== 'undefined' && window.matchMedia) {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', () => current.colourScheme === 'auto' && paint());
  }
  if (persist) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(current));
    } catch {
      /* per-viewer convenience only */
    }
  }
}

/** Called once before first render so returning visitors do not see a flash of the wrong theme. */
export function applyRememberedBrand() {
  let remembered: BrandOptions = {};
  try {
    remembered = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as BrandOptions;
  } catch {
    /* ignore */
  }
  applyBrand(remembered, false);
}

export function currentScheme(): Scheme {
  return resolveScheme(current.colourScheme);
}

/** Static colours for the Branding preview panes (kept in step with tokens.css). */
export const PREVIEW: Record<ThemeName, Record<Scheme, { paper: string; surface: string; ink: string; muted: string; line: string; display: string; text: string }>> = {
  civic: {
    light: { paper: '#f4f0e8', surface: '#fffdf8', ink: '#1d2a2e', muted: '#636b66', line: '#dcd5c6', display: "'Fraunces', Georgia, serif", text: "'Atkinson Hyperlegible Next', system-ui, sans-serif" },
    dark: { paper: '#16191a', surface: '#1f2324', ink: '#ece7dc', muted: '#9a968c', line: '#353b3c', display: "'Fraunces', Georgia, serif", text: "'Atkinson Hyperlegible Next', system-ui, sans-serif" },
  },
  clear: {
    light: { paper: '#f5f6f8', surface: '#ffffff', ink: '#14181f', muted: '#5f6775', line: '#dee2e8', display: "'Inter', system-ui, sans-serif", text: "'Inter', system-ui, sans-serif" },
    dark: { paper: '#0f1216', surface: '#171b21', ink: '#e8ebf0', muted: '#8d95a3', line: '#2b323c', display: "'Inter', system-ui, sans-serif", text: "'Inter', system-ui, sans-serif" },
  },
};
