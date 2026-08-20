/**
 * Theme preference.
 *
 * This is the one setting that stays in the browser rather than on the server:
 * it changes nothing about what the server does, and a phone at night and a
 * laptop in daylight should be allowed to disagree.
 *
 * "auto" means "no choice recorded" — the attribute is removed entirely so the
 * `prefers-color-scheme` rules in the stylesheet decide.
 */

export type Theme = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'agentdeck.theme';

/** Kept in sync with the palettes in styles.css. */
const THEME_COLOR: Record<'light' | 'dark', string> = {
  dark: '#0b0d10',
  light: '#f6f7f9',
};

export function currentTheme(): Theme {
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* private browsing; auto is a fine answer */
  }
  return 'auto';
}

/** Which palette "auto" actually resolves to right now. */
export function resolvedTheme(theme: Theme = currentTheme()): 'light' | 'dark' {
  if (theme !== 'auto') return theme;
  return window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  // Safari tints the status bar from this, so it has to track the palette or
  // the notch area stays the wrong colour in an installed PWA.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolvedTheme(theme)]);
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === 'auto') window.localStorage?.removeItem(STORAGE_KEY);
    else window.localStorage?.setItem(STORAGE_KEY, theme);
  } catch {
    /* the choice still applies for this session */
  }
  applyTheme(theme);
}

/**
 * Apply the stored choice and keep "auto" tracking the device. Call once at
 * startup, before the first render, so there is no flash of the wrong palette.
 */
export function initTheme(): void {
  applyTheme(currentTheme());
  window
    .matchMedia?.('(prefers-color-scheme: light)')
    ?.addEventListener?.('change', () => {
      if (currentTheme() === 'auto') applyTheme('auto');
    });
}
