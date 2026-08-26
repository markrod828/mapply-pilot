import type { JobPosting } from '../lib/types';

const SECTION_HINTS = /responsibilit|qualification|requirement|what you|about the role|benefits|experience/i;
const MAX_DESCRIPTION = 20000;

export function extractJob(): JobPosting | null {
  const fromJsonLd = extractFromJsonLd();
  const description = fromJsonLd?.description || extractDescriptionFromDom();
  if (!description || description.length < 200) return null;

  const titleGuess = fromJsonLd?.title || extractTitle();
  const companyGuess = fromJsonLd?.company || extractCompany();

  return {
    jobKey: buildJobKey(titleGuess, companyGuess),
    url: location.href,
    title: titleGuess,
    company: companyGuess,
    location: fromJsonLd?.location || extractLocation(),
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

function extractDescriptionFromDom(): string {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('main, article, section, div[class*="detail" i], div[class*="description" i], div[class*="job" i]'),
  );

  let best: { text: string; score: number } | null = null;
  for (const element of candidates) {
    // textContent is cheap; innerText forces layout, so filter on length first.
    const rawLength = element.textContent?.length ?? 0;
    if (rawLength < 300 || rawLength > MAX_DESCRIPTION * 2) continue;
    if (!isVisible(element)) continue;

    const text = normalize(element.innerText ?? '');
    if (text.length < 300 || text.length > MAX_DESCRIPTION * 2) continue;
    // Prefer compact blocks that read like a job description.
    const score = text.length * (SECTION_HINTS.test(text) ? 2 : 1) - element.querySelectorAll('a').length * 40;
    if (!best || score > best.score) best = { text, score };
  }

  if (best) return best.text;
  return normalize(document.body?.innerText ?? '');
}

function extractTitle(): string {
  const heading = document.querySelector<HTMLElement>('h1, [class*="title" i] h2, h2');
  const headingText = normalize(heading?.innerText ?? '');
  if (headingText && headingText.length < 120) return headingText;

  const docTitle = document.title.split(/\||·|—/)[0]?.trim() ?? '';
  return docTitle.split(/\bat\b/i)[0]?.trim() ?? docTitle;
}

function extractCompany(): string {
  const atMatch = document.title.match(/\bat\s+([^|·—]+)/i);
  if (atMatch?.[1]) return atMatch[1].trim().slice(0, 80);

  const node = document.querySelector<HTMLElement>('[class*="company" i], [data-testid*="company" i]');
  const text = normalize(node?.innerText ?? '');
  return text.length > 0 && text.length < 80 ? text.split('\n')[0] : '';
}

function extractLocation(): string {
  const node = document.querySelector<HTMLElement>('[class*="location" i], [data-testid*="location" i]');
  const text = normalize(node?.innerText ?? '');
  return text.length > 0 && text.length < 120 ? text.split('\n')[0] : '';
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
