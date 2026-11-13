/**
 * Light / dark / auto switch in the header.
 *
 * The choice lives in localStorage and is applied as data-theme on <html>.
 * Each page's <head> applies it before first paint, so this module only builds
 * the button and handles clicks. "auto" removes the attribute and the CSS
 * follows the device again.
 */

export const THEME_KEY = 'bb.theme.v1';
const ORDER = ['auto', 'light', 'dark'];
// Drawn icons: the text glyphs (◐ ☀ ☾) render tiny or not at all in some fonts.
const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  auto: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  dark: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
};
const LABEL = { auto: 'Theme: match device', light: 'Theme: light', dark: 'Theme: dark' };

export function readTheme() {
  try {
    const t = globalThis.localStorage?.getItem(THEME_KEY);
    return ORDER.includes(t) ? t : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  try {
    if (theme === 'auto') globalThis.localStorage?.removeItem(THEME_KEY);
    else globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

export const nextTheme = (theme) => ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];

function paint(btn, theme) {
  btn.innerHTML = ICON[theme]; // fixed strings above, never user data
  btn.title = `${LABEL[theme]} (click to change)`;
  btn.setAttribute('aria-label', LABEL[theme]);
}

function mount() {
  const nav = document.querySelector('.site-header .site-nav');
  if (!nav || nav.querySelector('.theme-toggle')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';
  let theme = readTheme();
  paint(btn, theme);
  btn.addEventListener('click', () => {
    theme = nextTheme(theme);
    applyTheme(theme);
    paint(btn, theme);
  });
  nav.append(btn);
}

if (typeof document !== 'undefined') mount();
