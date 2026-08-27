import type { BrowserContext } from 'playwright';

/**
 * Makes a context safe for the functions handed to page.evaluate.
 *
 * TypeScript is stripped at run time by esbuild, which - to keep function names
 * intact for stack traces - rewrites every function through a __name helper it
 * defines per module. A function passed to page.evaluate is serialised and run in
 * the browser, where that helper does not exist, so the call throws
 * "__name is not defined" before any of our own code runs. Defining it as
 * identity at document start costs nothing and makes the two worlds agree.
 */
export async function prepareContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scope = globalThis as unknown as { __name?: unknown };
    if (!scope.__name) scope.__name = (fn: unknown) => fn;
  });
}
