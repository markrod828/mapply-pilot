import { stripBulletPrefix } from './resumeFormat';
import type {
  EducationEntry,
  ExperienceEntry,
  Profile,
  ProjectEntry,
  ResumeTemplate,
  SkillGroup,
  TailoredResume,
} from './types';

interface TemplateStyle {
  font: 'times' | 'helvetica';
  align: 'center' | 'left';
  nameSize: number;
  headingSize: number;
  bodySize: number;
  bullet: string;
  headingRule: boolean;
  accent: [number, number, number];
  muted: [number, number, number];
}

export const TEMPLATES: Record<ResumeTemplate, { label: string; description: string; style: TemplateStyle }> = {
  classic: {
    label: 'Classic',
    description: 'Centred serif header with ruled section headings. Safe for conservative industries.',
    style: {
      font: 'times',
      align: 'center',
      nameSize: 18,
      headingSize: 10.5,
      bodySize: 9.5,
      bullet: '\u2022',
      headingRule: true,
      accent: [15, 23, 42],
      muted: [71, 85, 105],
    },
  },
  modern: {
    label: 'Modern',
    description: 'Left-aligned sans-serif with a coloured role headline. Reads well for tech and startups.',
    style: {
      font: 'helvetica',
      align: 'left',
      nameSize: 20,
      headingSize: 10,
      bodySize: 9.25,
      bullet: '\u2013',
      headingRule: false,
      accent: [2, 132, 199],
      muted: [100, 116, 139],
    },
  },
};

const MARGIN = 48;

/**
 * Renders a single-column, recruiter-readable PDF. Both templates stay
 * parser-friendly: no tables, columns, text boxes or graphics.
 */
export async function buildResumePdf(
  profile: Profile,
  resume: TailoredResume,
  template: ResumeTemplate = 'classic',
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const style = TEMPLATES[template].style;

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;
  const lineHeight = style.bodySize * 1.32;
  let y = MARGIN;

  const newPageIfNeeded = (needed: number) => {
    if (y + needed > pageHeight - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };

  const write = (
    text: string,
    options: {
      size?: number;
      weight?: 'normal' | 'bold' | 'italic';
      align?: 'left' | 'center';
      color?: [number, number, number];
      indent?: number;
      gap?: number;
    } = {},
  ) => {
    const size = options.size ?? style.bodySize;
    const align = options.align ?? 'left';
    const indent = options.indent ?? 0;
    const color = options.color ?? [15, 23, 42];
    const gap = options.gap ?? size * 1.32;

    doc.setFont(style.font, options.weight ?? 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);

    const lines = doc.splitTextToSize(text, contentWidth - indent) as string[];
    for (const line of lines) {
      newPageIfNeeded(gap);
      doc.text(line, align === 'center' ? pageWidth / 2 : MARGIN + indent, y, {
        align: align === 'center' ? 'center' : undefined,
      });
      y += gap;
    }
  };

  /** Height of `text` at a given size, so a block can reserve room for what follows it. */
  const measure = (text: string, size: number, weight: 'normal' | 'bold', gap: number) => {
    doc.setFont(style.font, weight);
    doc.setFontSize(size);
    return (doc.splitTextToSize(text, contentWidth) as string[]).length * gap;
  };

  const sectionHeading = (text: string) => {
    y += 8;
    // Reserve the heading, its rule, and one line of whatever follows, so a heading
    // never ends up stranded at the foot of a page.
    newPageIfNeeded(style.headingSize * 1.15 + (style.headingRule ? 5 : 1) + lineHeight);
    write(text.toUpperCase(), {
      size: style.headingSize,
      weight: 'bold',
      color: style.accent,
      gap: style.headingSize * 1.15,
    });
    if (style.headingRule) {
      doc.setDrawColor(...style.accent);
      doc.setLineWidth(0.6);
      doc.line(MARGIN, y - 1, pageWidth - MARGIN, y - 1);
      y += 4;
    } else {
      y += 1;
    }
  };

  const writeBullet = (text: string) => {
    const clean = stripBulletPrefix(text);
    if (!clean) return;
    const lines = doc.splitTextToSize(clean, contentWidth - 14) as string[];
    newPageIfNeeded(lineHeight);
    doc.setFont(style.font, 'normal');
    doc.setFontSize(style.bodySize);
    doc.setTextColor(15, 23, 42);
    doc.text(style.bullet, MARGIN + 2, y);
    for (const line of lines) {
      newPageIfNeeded(lineHeight);
      doc.text(line, MARGIN + 14, y);
      y += lineHeight;
    }
  };

  const writeRole = (role: ExperienceEntry) => {
    y += 3;
    const titleLine = [role.title, role.company].filter(Boolean).join('  |  ');
    // Keep the title, its dates and at least the first bullet together.
    newPageIfNeeded(
      measure(titleLine, style.bodySize + 0.5, 'bold', lineHeight) +
        (role.dates ? lineHeight : 0) +
        (role.bullets.length ? lineHeight : 0),
    );
    write(titleLine, { weight: 'bold', size: style.bodySize + 0.5, gap: lineHeight });
    if (role.dates) {
      write(role.dates, {
        weight: 'italic',
        size: style.bodySize - 0.5,
        color: style.muted,
        gap: lineHeight,
      });
    }
    for (const bullet of role.bullets) writeBullet(bullet);
  };

  const writeProject = (project: ProjectEntry) => {
    y += 2;
    newPageIfNeeded(
      measure(project.name, style.bodySize + 0.25, 'bold', lineHeight) +
        (project.bullets.length ? lineHeight : 0),
    );
    write(project.name, { weight: 'bold', size: style.bodySize + 0.25, gap: lineHeight });
    for (const bullet of project.bullets.slice(0, 3)) writeBullet(bullet);
  };

  const writeEducation = (entry: EducationEntry) => {
    y += 2;
    const schoolLine = [entry.school, entry.location].filter(Boolean).join('  —  ');
    const degreeText = [entry.degree, entry.year].filter(Boolean).join(', ');
    if (schoolLine) {
      newPageIfNeeded(
        measure(schoolLine, style.bodySize, 'bold', lineHeight) + (degreeText ? lineHeight : 0),
      );
      write(schoolLine, { weight: 'bold', gap: lineHeight });
    }
    if (degreeText) write(degreeText, { gap: lineHeight });
    for (const detail of entry.details.slice(0, 2)) writeBullet(detail);
  };

  const writeSkillGroups = (groups: SkillGroup[]) => {
    for (const group of groups) {
      newPageIfNeeded(lineHeight);
      doc.setFont(style.font, 'bold');
      doc.setFontSize(style.bodySize);
      doc.setTextColor(15, 23, 42);
      const label = `${group.category}: `;
      const labelWidth = doc.getTextWidth(label);
      doc.text(label, MARGIN, y);

      doc.setFont(style.font, 'normal');
      const restLines = doc.splitTextToSize(group.items.join(', '), contentWidth - labelWidth) as string[];
      doc.text(restLines[0] ?? '', MARGIN + labelWidth, y);
      y += lineHeight;
      for (const continuation of restLines.slice(1)) {
        newPageIfNeeded(lineHeight);
        doc.text(continuation, MARGIN + labelWidth, y);
        y += lineHeight;
      }
    }
  };

  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  if (fullName) {
    write(fullName, { size: style.nameSize, weight: 'bold', align: style.align, gap: style.nameSize * 1.1 });
    y += 1;
  }

  if (resume.headline) {
    write(resume.headline, {
      size: style.bodySize + 0.5,
      weight: style.font === 'times' ? 'italic' : 'bold',
      align: style.align,
      color: style.accent,
      gap: lineHeight,
    });
  }

  const contactLine = [
    profile.email,
    profile.phone,
    [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
    profile.linkedin,
    profile.github,
    profile.portfolio,
  ]
    .filter(Boolean)
    .join('  ·  ');
  if (contactLine) {
    write(contactLine, { size: style.bodySize - 0.75, align: style.align, color: style.muted, gap: lineHeight });
  }

  if (style.align === 'left') {
    y += 5;
    doc.setDrawColor(...style.accent);
    doc.setLineWidth(1.2);
    doc.line(MARGIN, y, pageWidth - MARGIN, y);
    y += 3;
  }

  if (resume.summary) {
    sectionHeading('Summary');
    write(resume.summary, { gap: lineHeight });
  }

  const skillGroups =
    resume.skillGroups?.length > 0
      ? resume.skillGroups
      : resume.skills?.length
        ? [{ category: 'Skills', items: resume.skills }]
        : [];
  if (skillGroups.length) {
    sectionHeading('Skills');
    writeSkillGroups(skillGroups);
  }

  if (resume.experience?.length) {
    sectionHeading('Experience');
    for (const role of resume.experience) writeRole(role);
  }

  if (resume.projects?.length) {
    sectionHeading('Projects');
    for (const project of resume.projects) writeProject(project);
  }

  if (resume.education?.length) {
    sectionHeading('Education');
    for (const entry of resume.education) writeEducation(entry);
  }

  if (resume.certifications?.length) {
    sectionHeading('Certifications');
    write(resume.certifications.map(stripBulletPrefix).filter(Boolean).join('  ·  '), { gap: lineHeight });
  }

  for (const section of resume.sections ?? []) {
    sectionHeading(section.heading);
    for (const bullet of section.bullets) writeBullet(bullet);
  }

  return doc.output('blob');
}

export function resumeFileName(profile: Profile, company: string): string {
  const name = `${profile.firstName}${profile.lastName}`.replace(/[^a-z0-9]/gi, '') || 'Resume';
  const org = company.replace(/[^a-z0-9]/gi, '').slice(0, 24);
  return org ? `${name}-${org}-Resume.pdf` : `${name}-Resume.pdf`;
}

export function coverLetterPdfName(profile: Profile, company: string): string {
  const name = `${profile.firstName}${profile.lastName}`.replace(/[^a-z0-9]/gi, '') || 'Cover';
  const org = company.replace(/[^a-z0-9]/gi, '').slice(0, 24);
  return org ? `${name}-${org}-CoverLetter.pdf` : `${name}-CoverLetter.pdf`;
}
