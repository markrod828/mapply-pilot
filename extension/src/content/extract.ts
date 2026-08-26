import type { JobPosting } from '../lib/types';

const SECTION_HINTS = /responsibilit|qualification|requirement|what you|about the role|benefits|experience/i;
const MAX_DESCRIPTION = 20000;
/** "Retell · 1 hour ago", "Acme • Posted 3 days ago" - the tail is not the company. */
const META_TAIL = /\s*[·•|]\s*(posted\s+)?\d+\s*\w+\s+ago.*$/i;

export function extractJob(): JobPosting | null {
  const head = readHead();
  const fromJsonLd = head.stale ? null : extractFromJsonLd();
  const dom = extractDescriptionFromDom();

  const description = fromJsonLd?.description || dom.text;
  if (!description || description.length < 200) return null;

  /*
   * Everything else is read from inside the block the description came from. Jobright
   * keeps the list you clicked from mounted behind the detail, and a plain
   * document-wide querySelector returns whichever heading, company or location node
   * comes first in the document - which is a card for some other job entirely.
   */
  const scope = detailScope(dom.element);

  const titleGuess = fromJsonLd?.title || extractTitle(scope) || head.title;
  const companyGuess = fromJsonLd?.company || extractCompany(scope, titleGuess) || head.company;

  return {
    jobKey: buildJobKey(titleGuess, companyGuess),
    url: location.href,
    title: titleGuess,
    company: companyGuess,
    location: fromJsonLd?.location || extractLocation(scope),
    description: description.slice(0, MAX_DESCRIPTION),
    capturedAt: Date.now(),
  };
}

/** Stable per-posting id: prefer /jobs/info/{id}, then query params, then title slug. */
export function buildJobKey(title: string, company: string): string {
  const url = new URL(location.href);
  const infoId = jobInfoIdFromUrl(url.href);
  if (infoId) return `${url.hostname}:${infoId}`;

  const idParam = url.searchParams.get('jobId') ?? url.searchParams.get('id');
  if (idParam) return `${url.hostname}:${idParam}`;

  const pathId = url.pathname.match(/[0-9a-f]{8,}|\d{5,}/i)?.[0];
  if (pathId) return `${url.hostname}:${pathId}`;

  const slug = `${title}|${company}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
  return `${url.hostname}:${slug || url.pathname}`;
}

/** Jobright detail id from `/jobs/info/{id}`. */
export function jobInfoIdFromUrl(href: string = location.href): string | null {
  try {
    const path = new URL(href).pathname;
    const match = path.match(/^\/jobs\/info\/([^/]+)\/?$/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

interface HeadMeta {
  title: string;
  company: string;
  /** The head still describes the posting we just navigated away from. */
  stale: boolean;
}

/**
 * `<title>`, og:title and the JSON-LD block are all managed by the framework's head
 * handling, which re-renders a beat after the route changes. Until it does they all
 * describe the previous posting, so they are checked against the canonical URL and
 * dropped together when they disagree with the address bar.
 */
function readHead(): HeadMeta {
  const empty = { title: '', company: '', stale: false };
  if (headIsStale()) return { ...empty, stale: true };

  const raw = meta('og:title') || document.title;
  if (!raw) return empty;

  // "Senior Software Engineer, Backend @ Retell | Jobright.ai"
  const withoutSite = raw.split(/\s[|·—]\s/)[0]?.trim() ?? '';
  const split = withoutSite.match(/^(.*?)\s+(?:@|\bat\b)\s+(.+)$/i);

  return {
    title: (split?.[1] ?? withoutSite).trim().slice(0, 120),
    company: (split?.[2] ?? '').trim().slice(0, 80),
    stale: false,
  };
}

function headIsStale(): boolean {
  const current = jobInfoIdFromUrl(location.href);
  // Only jobright's detail URLs carry an id to check against; elsewhere, trust the head.
  if (!current) return false;

  const canonical =
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || meta('og:url');
  if (!canonical) return false;

  const declared = jobInfoIdFromUrl(canonical);
  return declared !== null && declared !== current;
}

function meta(property: string): string {
  const node = document.querySelector<HTMLMetaElement>(
    `meta[property="${property}"], meta[name="${property}"]`,
  );
  return node?.content?.trim() ?? '';
}

interface JsonLdJob {
  title: string;
  company: string;
  location: string;
  description: string;
}

function extractFromJsonLd(): JsonLdJob | null {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      const job = node as Record<string, unknown>;
      if (job?.['@type'] !== 'JobPosting') continue;
      return {
        title: asText(job.title),
        company: asText((job.hiringOrganization as Record<string, unknown>)?.name),
        location: readJsonLdLocation(job.jobLocation),
        description: htmlToText(asText(job.description)),
      };
    }
  }
  return null;
}

function readJsonLdLocation(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  const address = (first as Record<string, unknown>)?.address as Record<string, unknown> | undefined;
  if (!address) return '';
  return [address.addressLocality, address.addressRegion, address.addressCountry]
    .map(asText)
    .filter(Boolean)
    .join(', ');
}

interface DomDescription {
  text: string;
  /** The block the text came from, used to scope every other DOM read. */
  element: HTMLElement | null;
}

function extractDescriptionFromDom(): DomDescription {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('main, article, section, div[class*="detail" i], div[class*="description" i], div[class*="job" i]'),
  );

  let best: { text: string; score: number; element: HTMLElement } | null = null;
  for (const element of candidates) {
    // textContent is cheap; innerText forces layout, so filter on length first.
    const rawLength = element.textContent?.length ?? 0;
    if (rawLength < 300 || rawLength > MAX_DESCRIPTION * 2) continue;
    if (!isVisible(element)) continue;

    const text = normalize(element.innerText ?? '');
    if (text.length < 300 || text.length > MAX_DESCRIPTION * 2) continue;
    // Prefer compact blocks that read like a job description.
    const score = text.length * (SECTION_HINTS.test(text) ? 2 : 1) - element.querySelectorAll('a').length * 40;
    if (!best || score > best.score) best = { text, score, element };
  }

  if (best) return { text: best.text, element: best.element };
  return { text: normalize(document.body?.innerText ?? ''), element: null };
}

/**
 * The smallest block holding both the description and the posting's `h1`, which on a
 * detail page is the panel for this posting alone. Walking up stops there rather than
 * at `<body>`, so anything rendered beside the detail stays out of range.
 */
function detailScope(description: HTMLElement | null): HTMLElement {
  const body = document.body;
  for (let node = description; node && node !== body; node = node.parentElement) {
    if (node.querySelector('h1')) return node;
  }
  // No h1 anywhere above the description: keep the reads inside the description block
  // rather than widening to the whole page, and let the head supply the title.
  return description ?? body;
}

function extractTitle(scope: HTMLElement): string {
  // An h1 is the posting's own title on every ATS and job board worth naming.
  const heading =
    scope.querySelector<HTMLElement>('h1') ??
    scope.querySelector<HTMLElement>('[class*="job-title" i], [class*="jobtitle" i], [data-testid*="title" i]');

  const text = firstLine(heading);
  return text && text.length < 120 ? text : '';
}

function extractCompany(scope: HTMLElement, title: string): string {
  const nodes = scope.querySelectorAll<HTMLElement>(
    '[class*="company-name" i], [class*="companyname" i], [data-testid*="company" i], [class*="company" i]',
  );

  for (const node of nodes) {
    const text = firstLine(node).replace(META_TAIL, '').trim();
    // A wrapper around the whole header repeats the title; that is not a company name.
    if (!text || text.length >= 80 || text === title) continue;
    return text;
  }
  return '';
}

function extractLocation(scope: HTMLElement): string {
  const node = scope.querySelector<HTMLElement>('[class*="location" i], [data-testid*="location" i]');
  const text = firstLine(node);
  return text.length > 0 && text.length < 120 ? text : '';
}

function firstLine(node: HTMLElement | null): string {
  return normalize(node?.innerText ?? '').split('\n')[0]?.trim() ?? '';
}

function isVisible(element: HTMLElement): boolean {
  return element.offsetParent !== null || element.getClientRects().length > 0;
}

function normalize(text: string): string {
  return text.replace(/\r/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function htmlToText(html: string): string {
  if (!html.includes('<')) return normalize(html);
  const container = document.createElement('div');
  container.innerHTML = html;
  return normalize(container.textContent ?? '');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
