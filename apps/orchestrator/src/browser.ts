import { chromium, type Browser, type BrowserContext } from 'playwright';
import { prepareContext } from '@mapply/filler';
import { paths } from './paths';

export interface LaunchOptions {
  headless?: boolean;
  /**
   * Name of a persistent profile under data/profiles. Use one for anything that
   * needs to stay logged in - jobright above all. ATS application forms need no
   * login, so those run in a throwaway context.
   */
  profile?: string;
}

export interface LaunchedBrowser {
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * Opens a browser, preferring the Chrome that is already installed.
 *
 * Playwright ships its own Chromium, but using the real Chrome is better here on
 * both counts that matter: it is the browser whose profile holds the jobright
 * session, and it is an ordinary consumer build rather than an automation one.
 * The bundled Chromium stays as a fallback for a machine without Chrome.
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const headless = options.headless ?? false;
  const viewport = { width: 1440, height: 960 };

  if (options.profile) {
    // A persistent context is its own browser - it cannot be created from one,
    // and two of them cannot share a directory.
    const dir = `${paths.profiles}/${options.profile}`;
    const context = await withChromeFallback((channel) =>
      chromium.launchPersistentContext(dir, { headless, viewport, channel }),
    );
    await prepareContext(context);
    return { context, close: () => context.close() };
  }

  const browser: Browser = await withChromeFallback((channel) =>
    chromium.launch({ headless, channel }),
  );
  const context = await browser.newContext({ viewport });
  await prepareContext(context);
  return { context, close: () => browser.close() };
}

/**
 * Tries the installed Chrome, then Playwright's own build.
 *
 * Worth the retry rather than picking one: a machine with no Chrome and a
 * machine with no downloaded Chromium both otherwise fail at the first
 * application, with an error about browsers rather than about the job.
 */
async function withChromeFallback<T>(open: (channel?: string) => Promise<T>): Promise<T> {
  try {
    return await open('chrome');
  } catch (chromeError) {
    try {
      return await open(undefined);
    } catch {
      throw new Error(
        `Could not start a browser. Install Google Chrome, or run "npx playwright install chromium".\n${
          (chromeError as Error).message
        }`,
      );
    }
  }
}
