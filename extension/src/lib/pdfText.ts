/** Extracts plain text from a resume file. Supports PDF and plain text. */
export async function extractResumeText(file: File): Promise<string> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return extractPdfText(await file.arrayBuffer());
  }
  if (file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)) {
    return (await file.text()).trim();
  }
  throw new Error('Unsupported file type. Upload a PDF or paste your resume text.');
}

async function extractPdfText(data: ArrayBuffer): Promise<string> {
  // Loaded on demand: pdf.js is far bigger than the rest of the side panel.
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(joinTextItems(content.items));
  }
  await doc.destroy();

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
