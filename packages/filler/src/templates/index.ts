import type { Frame, Page } from 'playwright';
import { GREENHOUSE } from './greenhouse';
import type { FormTemplate } from './types';

export * from './types';
export { GREENHOUSE };

/** Every template we have, tried in order. */
export const TEMPLATES: readonly FormTemplate[] = [GREENHOUSE];

/**
 * Where a form lives: the page itself, or the frame holding it.
 *
 * Page and Frame expose the same locator API, so everything downstream can take
 * one of these and never ask which it got.
 */
export type FormRoot = Page | Frame;

export interface TemplateMatch {
  template: FormTemplate;
  root: FormRoot;
}

/**
 * Finds the template for a page, and the frame its form is actually in.
 *
 * Both halves matter. A company that runs its careers page on its own domain
 * usually embeds the ATS in an iframe, so the URL says nothing and the fields
 * are not in the top document - searching only the page finds an empty form and
 * reports the ATS as unsupported.
 */
export async function findTemplate(page: Page): Promise<TemplateMatch | undefined> {
  // Frames first so the outer document, which merely contains the iframe, never
  // wins on a URL match while the fields live one level down.
  const roots: FormRoot[] = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];

  for (const template of TEMPLATES) {
    for (const root of roots) {
      const url = 'url' in root ? root.url() : page.url();
      if (template.urlPattern.test(url)) return { template, root };
    }
  }

  for (const template of TEMPLATES) {
    for (const root of roots) {
      const found = await root.locator(template.domSignature).count().catch(() => 0);
      if (found > 0) return { template, root };
    }
  }
  return undefined;
}
