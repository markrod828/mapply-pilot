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

    // Closed shadow roots are, by design, unreachable from page scripts - a form
    // inside one is invisible no matter how carefully it is searched for. Asking
    // for them open at document start costs the page nothing and is the only way
    // to fill a component that hides its own inputs. Safe here because these are
    // application forms, not sites looking for automation.
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function attachShadowOpen(this: Element, init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'open' });
    };
  });
}
