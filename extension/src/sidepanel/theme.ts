import type { Theme } from '../lib/types';

/**
 * Mirrored outside chrome.storage because that read is async: the inline script in
 * sidepanel.html reads this key synchronously and stamps <html> before first paint,
 * so a panel set to Light never flashes dark on a dark OS.
 */
export const THEME_KEY = 'applypilot-theme';

/** What "System" currently resolves to. */
export function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** What a light/dark toggle should switch to from here. */
export function nextTheme(theme: Theme): 'light' | 'dark' {
  const current = theme === 'system' ? systemTheme() : theme;
  return current === 'dark' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // No attribute means "follow the OS", which is what the media query already does.
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the theme still applies, it just may flash on the next open.
  }
}
