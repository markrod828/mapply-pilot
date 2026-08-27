import { formatLocation } from './profile';
import { formatDateRange, stripBulletPrefix } from './resumeFormat';
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
  /** Job titles, project names and degrees set in caps, the way a traditional resume does. */
  caps: boolean;
  accent: [number, number, number];
  /** Dates, locations and the contact line. */
  meta: [number, number, number];
}

export const TEMPLATES: Record<ResumeTemplate, { label: string; description: string; style: TemplateStyle }> = {
  classic: {
    label: 'Classic',
    description:
      'Centred serif header, ruled headings, dates and locations pinned right. Safe for conservative industries.',
    style: {
      font: 'times',
      align: 'center',
      nameSize: 22,
      headingSize: 12,
      bodySize: 9.5,
      bullet: '•',
      headingRule: true,
      caps: true,
      accent: [15, 23, 42],
      // The classic sheet is all one ink; only the modern template greys its meta down.
      meta: [15, 23, 42],
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
      bullet: '–',
      headingRule: false,
      caps: false,
      accent: [2, 132, 199],
      meta: [100, 116, 139],
    },
  },
};

const MARGIN = 46;
const TEXT: [number, number, number] = [15, 23, 42];

/**
 * Renders a single-column, recruiter-readable PDF. Both templates stay
 * parser-friendly: no tables, columns, text boxes or graphics. The right-hand dates
 * and locations are right-aligned text on the same baseline rather than a table, so
 * a parser still reads each entry as one continuous run.
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
  const rightEdge = pageWidth - MARGIN;
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
    const color = options.color ?? TEXT;
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

  /**
   * One entry line with its meta pinned to the right margin — "TITLE ....... dates".
   * The right column's width is reserved before the left text wraps, so a long title
   * breaks onto a second line instead of colliding with the dates.
   */
  const row = (
    left: string,
    right: string,
    options: {
      size?: number;
      leftWeight?: 'normal' | 'bold' | 'italic';
      rightWeight?: 'normal' | 'bold' | 'italic';
      color?: [number, number, number];
    } = {},
  ) => {
    if (!left && !right) return;
    const size = options.size ?? style.bodySize;
    const gap = size * 1.32;
    const leftWeight = options.leftWeight ?? 'bold';
    const rightWeight = options.rightWeight ?? 'normal';

    doc.setFontSize(size);
    doc.setTextColor(...(options.color ?? TEXT));

    doc.setFont(style.font, rightWeight);
    const rightWidth = right ? doc.getTextWidth(right) + 14 : 0;

    doc.setFont(style.font, leftWeight);
    const lines = left ? (doc.splitTextToSize(left, contentWidth - rightWidth) as string[]) : [];
    newPageIfNeeded(gap * Math.max(lines.length, 1));

    if (right) {
      doc.setFont(style.font, rightWeight);
      doc.text(right, rightEdge, y, { align: 'right' });
    }

    doc.setFont(style.font, leftWeight);
    for (const line of lines) {
      doc.text(line, MARGIN, y);
      y += gap;
    }
    if (!lines.length) y += gap;
  };

  /**
   * Mixed-weight text flowing on one wrapping line, e.g. a bold label followed by
   * normal content. Laid out token by token because jsPDF only wraps a single font.
   */
  const writeRich = (
    segments: { text: string; weight: 'normal' | 'bold' | 'italic' }[],
    size = style.bodySize,
  ) => {
    const gap = size * 1.32;
    doc.setFontSize(size);
    doc.setTextColor(...TEXT);
    newPageIfNeeded(gap);
    let x = MARGIN;

    for (const segment of segments) {
      doc.setFont(style.font, segment.weight);
      for (const token of segment.text.split(/(\s+)/)) {
        if (!token) continue;
        const width = doc.getTextWidth(token);
        if (x + width > rightEdge && x > MARGIN) {
          y += gap;
          x = MARGIN;
          newPageIfNeeded(gap);
          // A wrap swallows the space that caused it, so the new line starts flush.
          if (/^\s+$/.test(token)) continue;
        }
        doc.text(token, x, y);
        x += width;
      }
    }
    y += gap;
  };

  const sectionHeading = (text: string) => {
    y += 9;
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
      doc.line(MARGIN, y - 1, rightEdge, y - 1);
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
    doc.setTextColor(...TEXT);
    doc.text(style.bullet, MARGIN + 2, y);
    for (const line of lines) {
      newPageIfNeeded(lineHeight);
      doc.text(line, MARGIN + 14, y);
      y += lineHeight;
    }
  };

  const entryTitle = (text: string) => (style.caps ? text.toUpperCase() : text);

  const writeRole = (role: ExperienceEntry) => {
    y += 4;
    // Hold the title, the company line and the first bullet together on one page.
    newPageIfNeeded(lineHeight * (role.bullets.length ? 3 : 2));
    row(entryTitle(role.title), formatDateRange(role.startDate, role.endDate), {
      size: style.bodySize + 0.5,
    });
    if (role.company || role.location) {
      row(role.company, role.location ?? '', {
        leftWeight: 'italic',
        rightWeight: 'italic',
        color: style.meta,
      });
    }
    for (const bullet of role.bullets) writeBullet(bullet);
  };

  const writeProject = (project: ProjectEntry) => {
    y += 3;
    newPageIfNeeded(lineHeight * 2);
    const segments: { text: string; weight: 'normal' | 'bold' | 'italic' }[] = [
      { text: entryTitle(project.name), weight: 'bold' },
    ];
    if (project.tech) segments.push({ text: `  |  ${project.tech}`, weight: 'normal' });
    writeRich(segments);
    for (const bullet of project.bullets.slice(0, 3)) writeBullet(bullet);
  };

  const writeEducation = (entry: EducationEntry) => {
    y += 4;
    newPageIfNeeded(lineHeight * 2);
    row(entry.school, entry.location);
    // Coursework and honours ride on the degree line rather than becoming bullets,
    // which is what keeps an education block to the two lines the reference uses.
    const degree = [entryTitle(entry.degree), ...entry.details.map(stripBulletPrefix).filter(Boolean)]
      .filter(Boolean)
      .join(', ');
    const years = formatDateRange(entry.startDate, entry.endDate);
    if (degree || years) {
      row(degree, years, { leftWeight: 'italic', rightWeight: 'italic', color: style.meta });
    }
  };

  const writeSkillGroups = (groups: SkillGroup[]) => {
    for (const group of groups) {
      writeRich([
        { text: `${group.category}:`, weight: 'bold' },
        // The gap leads the normal run rather than trailing the bold one, so a group
        // whose items wrap does not start its second line with a stray indent.
        { text: `  ${group.items.join(', ')}`, weight: 'normal' },
      ]);
    }
  };

  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  if (fullName) {
    write(fullName, {
      size: style.nameSize,
      weight: 'bold',
      align: style.align,
      gap: style.nameSize * 1.12,
    });
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

  // Location leads, then the ways to reach you — the order a classic header uses.
  const contactLine = [
    formatLocation(profile.address),
    profile.email,
    profile.phone,
    profile.linkedin,
    profile.github,
    profile.portfolio,
  ]
    .filter(Boolean)
    .join('  |  ');
  if (contactLine) {
    write(contactLine, { align: style.align, color: style.meta, gap: lineHeight });
  }

  if (style.align === 'left') {
    y += 5;
    doc.setDrawColor(...style.accent);
    doc.setLineWidth(1.2);
    doc.line(MARGIN, y, rightEdge, y);
    y += 3;
  }

  if (resume.summary) {
    sectionHeading('Summary');
    write(resume.summary, { gap: lineHeight });
  }

  if (resume.education?.length) {
    sectionHeading('Education');
    for (const entry of resume.education) writeEducation(entry);
  }

  if (resume.experience?.length) {
    sectionHeading('Experience');
    for (const role of resume.experience) writeRole(role);
  }

  if (resume.projects?.length) {
    sectionHeading('Projects');
    for (const project of resume.projects) writeProject(project);
  }

  const skillGroups =
    resume.skillGroups?.length > 0
      ? resume.skillGroups
      : resume.skills?.length
        ? [{ category: 'Skills', items: resume.skills }]
        : [];
  if (skillGroups.length) {
    sectionHeading('Technical Skills');
    writeSkillGroups(skillGroups);
  }

  if (resume.certifications?.length) {
    sectionHeading('Certifications');
    for (const cert of resume.certifications.map(stripBulletPrefix).filter(Boolean)) {
      write(cert, { gap: lineHeight });
    }
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
