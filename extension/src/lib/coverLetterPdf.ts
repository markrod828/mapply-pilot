import { TEMPLATES } from './resumePdf';
import type { JobPosting, Profile, ResumeTemplate } from './types';

const MARGIN = 64;

/**
 * A plain business letter in the same type as the resume, so the two documents look
 * like a set. Single column, no graphics - some ATS parse the attachment too.
 */
export async function buildCoverLetterPdf(
  profile: Profile,
  job: Pick<JobPosting, 'company' | 'title'>,
  letter: string,
  template: ResumeTemplate = 'classic',
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const style = TEMPLATES[template].style;

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;
  const lineHeight = style.bodySize * 1.5;
  let y = MARGIN;

  const write = (
    text: string,
    options: { size?: number; weight?: 'normal' | 'bold' | 'italic'; color?: [number, number, number] } = {},
  ) => {
    const size = options.size ?? style.bodySize + 0.5;
    doc.setFont(style.font, options.weight ?? 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...(options.color ?? [15, 23, 42]));

    for (const line of doc.splitTextToSize(text, contentWidth) as string[]) {
      if (y + lineHeight > pageHeight - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(line, MARGIN, y);
      y += lineHeight;
    }
  };

  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  if (fullName) {
    write(fullName, { size: style.nameSize - 2, weight: 'bold', color: style.accent });
  }

  const contact = [
    profile.email,
    profile.phone,
    [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
    profile.linkedin,
  ]
    .filter(Boolean)
    .join('  ·  ');
  if (contact) {
    write(contact, { size: style.bodySize - 0.75, color: style.muted });
  }

  y += 6;
  const heading = [job.title, job.company].filter(Boolean).join(' — ');
  if (heading) {
    write(`Re: ${heading}`, { weight: 'bold' });
    y += 4;
  }

  // Blank lines in the letter separate paragraphs; keep that spacing in the PDF.
  for (const paragraph of letter.split(/\n\s*\n/)) {
    const text = paragraph.replace(/\s*\n\s*/g, ' ').trim();
    if (!text) continue;
    write(text);
    y += lineHeight * 0.45;
  }

  return doc.output('blob');
}
