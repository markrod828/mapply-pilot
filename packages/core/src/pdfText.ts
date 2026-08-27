/**
 * Extracting plain text from a resume file.
 *
 * pdf.js is loaded through an injected loader rather than imported here, because
 * the two callers need genuinely different builds of it. In the extension, Vite
 * resolves the worker through a `?url` import and pdf.js runs off the main thread.
 * In Node there is no worker to point at, so the orchestrator loads the legacy
 * build, which runs in-process. Neither of those spellings compiles in the other
 * environment, so this module takes the loader as an argument and stays neutral.
 */

/** The slice of pdf.js this module actually uses, structurally typed so core
 *  carries no dependency on pdfjs-dist itself. */
export interface PdfjsLike {
  getDocument(source: { data: Uint8Array }): { promise: Promise<PdfDocumentLike> };
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
}

export type PdfjsLoader = () => Promise<PdfjsLike>;

/** Extracts plain text from a resume file. Supports PDF and plain text. */
export async function extractResumeText(file: File, loadPdfjs: PdfjsLoader): Promise<string> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return extractPdfText(new Uint8Array(await file.arrayBuffer()), loadPdfjs);
  }
  if (file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)) {
    return (await file.text()).trim();
  }
  throw new Error('Unsupported file type. Upload a PDF or paste your resume text.');
}

export async function extractPdfText(data: Uint8Array, loadPdfjs: PdfjsLoader): Promise<string> {
  const pdfjs = await loadPdfjs();

  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(joinTextItems(content.items));
    }
  } finally {
    // Releases the worker even when a page throws; a leaked document keeps a
    // worker alive, which matters once this runs hundreds of times a day.
    await doc.destroy();
  }

  const text = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    throw new Error('No selectable text found in that PDF. It may be a scan - paste the text instead.');
  }
  return text;
}

type TextItemLike = { str?: string; hasEOL?: boolean };

function joinTextItems(items: unknown[]): string {
  let out = '';
  for (const raw of items) {
    const item = raw as TextItemLike;
    if (typeof item.str !== 'string') continue;
    out += item.str;
    out += item.hasEOL ? '\n' : ' ';
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ \n/g, '\n');
}
