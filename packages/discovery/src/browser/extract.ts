/**
 * Reading a job posting out of a page.
 *
 * Ported from the extension's extractor, which had already been through the
 * awkward parts: JSON-LD is preferred where a site publishes it, and the DOM
 * fallback scores candidate blocks by how much prose they hold against how many
 * links they contain, because a navigation column is long but is not a job
 * description.
 *
 * It lives as one self-contained function because it runs inside the page, where
 * nothing from this module's scope exists. `pageUrl` is passed in rather than
 * read from `location`, so the caller can be explicit about which URL the
 * content is supposed to belong to.
 */

export interface ExtractedJob {
  title: string;
  company: string;
  location: string;
  description: string;
  /** Fingerprint of what was read, for spotting a page that has not settled. */
  fingerprint: string;
  /** True when the page's own canonical URL disagrees with where we think we are. */
  stale: boolean;
}

export function extractJobInPage(pageUrl: string): ExtractedJob | null {
  const SECTION_HINTS =
    /responsibilit|qualification|requirement|what you|about the role|benefits|experience/i;
  const MAX_DESCRIPTION = 20000;
  const META_TAIL = /\s*[·•|]\s*(posted\s+)?\d+\s*\w+\s+ago.*$/i;

  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

  const htmlToText = (html: string): string => {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    return (holder.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  };

  const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

  const meta = (property: string): string =>
    document.querySelector<HTMLMetaElement>(
      `meta[property="${property}"], meta[name="${property}"]`,
    )?.content ?? '';

  const isVisible = (element: HTMLElement): boolean =>
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';

  /**
   * Whether the page's own canonical link disagrees with the address bar.
   *
   * A single-page job board swaps the URL first and the content after, so for a
   * moment the previous posting's title and JSON-LD sit under the new address.
   * Believing them is how the wrong job gets applied to.
   */
  const idOf = (href: string): string | null => {
    const match = href.match(/\/jobs\/info\/([^/?#]+)/i);
    return match ? match[1] : null;
  };
  const canonical =
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '';
  const wantedId = idOf(pageUrl);
  const stale = Boolean(wantedId && canonical && idOf(canonical) && idOf(canonical) !== wantedId);

  // --- JSON-LD, where the site publishes it ---------------------------------
  let title = '';
  let company = '';
  let where = '';
  let description = '';

  if (!stale) {
    for (const node of Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
    )) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(node.textContent ?? '');
      } catch {
        continue;
      }
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const raw of entries) {
        const entry = raw as Record<string, unknown>;
        const type = entry?.['@type'];
        const isPosting = Array.isArray(type)
          ? type.includes('JobPosting')
          : type === 'JobPosting';
        if (!isPosting) continue;

        title = asText(entry.title);
        const org = entry.hiringOrganization as Record<string, unknown> | undefined;
        company = asText(org?.name);

        const place = entry.jobLocation as Record<string, unknown> | undefined;
        const address = (Array.isArray(place) ? place[0] : place)?.address as
          | Record<string, unknown>
          | undefined;
        where = [
          asText(address?.addressLocality),
          asText(address?.addressRegion),
          asText(address?.addressCountry),
        ]
          .filter(Boolean)
          .join(', ');

        const body = asText(entry.description);
        if (body) description = htmlToText(body);
        break;
      }
      if (description) break;
    }
  }

  // --- DOM fallback ---------------------------------------------------------
  if (!description) {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        'main, article, section, div[class*="detail" i], div[class*="description" i], div[class*="job" i]',
      ),
    );

    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const element of candidates) {
      // textContent first: it needs no layout, and most candidates are rejected
      // on length alone.
      const rough = element.textContent?.length ?? 0;
      if (rough < 300 || rough > 40000) continue;
      if (!isVisible(element)) continue;

      const text = element.innerText ?? '';
      const score =
        text.length * (SECTION_HINTS.test(text) ? 2 : 1) -
        element.querySelectorAll('a').length * 40;
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }
    if (best) description = normalize(best.innerText).slice(0, MAX_DESCRIPTION);
  }

  description = description.slice(0, MAX_DESCRIPTION);

  // --- title, company, location --------------------------------------------
  if (!title) {
    title = normalize(
      document.querySelector('h1')?.textContent ?? (stale ? '' : meta('og:title')) ?? '',
    ).replace(META_TAIL, '');
  }
  if (!company) {
    company =
      normalize(
        document.querySelector('[class*="company" i], [data-testid*="company" i]')?.textContent ?? '',
      ) ||
      (stale ? '' : meta('og:site_name')) ||
      '';
  }
  if (!where) {
    where = normalize(
      document.querySelector('[class*="location" i], [data-testid*="location" i]')?.textContent ?? '',
    );
  }

  if (description.length < 200) return null;

  return {
    title: title.slice(0, 300),
    company: company.slice(0, 200),
    location: where.slice(0, 200),
    description,
    // Enough of the content to tell one posting from another, and short enough
    // that comparing two of them is cheap.
    fingerprint: `${title}|${company}|${where}|${description.length}|${description.slice(0, 400)}`,
    stale,
  };
}
