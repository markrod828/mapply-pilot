import { Fragment } from 'react';
import type { DiffPart } from '@mapply/core/diffText';
import { splitMetricParts } from '@mapply/core/resumeBuildRules';
import { formatLocation } from '@mapply/core/profile';
import { formatDateRange, stripBulletPrefix } from '@mapply/core/resumeFormat';
import type { ResumeDiff } from '@mapply/core/resumeDiff';
import type {
  EducationEntry,
  ExperienceEntry,
  Profile,
  ProjectEntry,
  ResumeSection,
  ResumeTemplate,
  SkillGroup,
} from '@mapply/core/types';

interface Props {
  profile: Profile;
  resume: {
    headline: string;
    summary: string;
    skillGroups?: SkillGroup[];
    skills?: string[];
    experience?: ExperienceEntry[];
    projects?: ProjectEntry[];
    education?: EducationEntry[];
    certifications?: string[];
    sections?: ResumeSection[];
  };
  template: ResumeTemplate;
  /** Terms to visually mark as inserted by the rewrite. */
  highlights: string[];
  /** When set, render as a comparison against the original resume instead. */
  diff?: ResumeDiff;
}

export function ResumePreview({ profile, resume, template, highlights, diff }: Props) {
  /** In comparison mode the diff colours carry the meaning, so drop the other marks. */
  const line = (text: string) => (diff ? renderDiff(text, diff) : formatLine(text, highlights));
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  const contact = [
    formatLocation(profile.address),
    profile.email,
    profile.phone,
    profile.linkedin,
    profile.github,
    profile.portfolio,
  ].filter(Boolean);

  const skillGroups =
    resume.skillGroups && resume.skillGroups.length > 0
      ? resume.skillGroups
      : resume.skills?.length
        ? [{ category: 'Skills', items: resume.skills }]
        : [];

  return (
    <div className={`paper tpl-${template}`}>
      <header className="paper-header">
        <div className="paper-name">{fullName || 'Your name'}</div>
        {resume.headline && <div className="paper-headline">{line(resume.headline)}</div>}
        {contact.length > 0 && <div className="paper-contact">{contact.join('  |  ')}</div>}
      </header>

      {resume.summary && (
        <section>
          <h4>Summary</h4>
          <p>{line(resume.summary)}</p>
        </section>
      )}

      {resume.education && resume.education.length > 0 && (
        <section>
          <h4>Education</h4>
          {resume.education.map((entry, index) => (
            <div className="entry" key={`${entry.school}-${index}`}>
              <div className="entry-row">
                <span className="entry-name">{entry.school}</span>
                <span className="entry-meta">{entry.location}</span>
              </div>
              <div className="entry-row entry-sub">
                <span>
                  <span className="caps">{entry.degree}</span>
                  {entry.details.map(stripBulletPrefix).filter(Boolean).length > 0 &&
                    `, ${entry.details.map(stripBulletPrefix).filter(Boolean).join(', ')}`}
                </span>
                <span className="entry-meta">
                  {formatDateRange(entry.startDate, entry.endDate)}
                </span>
              </div>
            </div>
          ))}
        </section>
      )}

      {resume.experience && resume.experience.length > 0 && (
        <section>
          <h4>Experience</h4>
          {resume.experience.map((role, index) => (
            <div className="entry" key={`${role.title}-${role.company}-${index}`}>
              <div className="entry-row">
                <span className="entry-name caps">{role.title}</span>
                <span className="entry-meta">
                  {formatDateRange(role.startDate, role.endDate)}
                </span>
              </div>
              {(role.company || role.location) && (
                <div className="entry-row entry-sub">
                  <span>{role.company}</span>
                  <span className="entry-meta">{role.location}</span>
                </div>
              )}
              <ul>
                {role.bullets.map((bullet, bulletIndex) => (
                  <li key={`${bullet.slice(0, 24)}-${bulletIndex}`}>
                    {line(stripBulletPrefix(bullet))}
                  </li>
                ))}
                {droppedItems(diff, index)}
              </ul>
            </div>
          ))}
        </section>
      )}

      {resume.projects && resume.projects.length > 0 && (
        <section>
          <h4>Projects</h4>
          {resume.projects.map((project, index) => (
            <div className="entry" key={`${project.name}-${index}`}>
              <div className="entry-name">
                <span className="caps">{project.name}</span>
                {project.tech && <span className="entry-tech">{`  |  ${project.tech}`}</span>}
              </div>
              <ul>
                {project.bullets.slice(0, 3).map((bullet, bulletIndex) => (
                  <li key={`${bullet.slice(0, 24)}-${bulletIndex}`}>
                    {line(stripBulletPrefix(bullet))}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {skillGroups.length > 0 && (
        <section>
          <h4>Technical Skills</h4>
          <div className="skill-groups">
            {skillGroups.map((group) => (
              <div className="skill-row" key={group.category}>
                <strong>{group.category}:</strong>{' '}
                <span>
                  {diff
                    ? group.items.map((item, index) => (
                        <Fragment key={item}>
                          {index > 0 && ', '}
                          {diff.addedSkills.has(item.toLowerCase()) ? <ins>{item}</ins> : item}
                        </Fragment>
                      ))
                    : formatLine(group.items.join(', '), highlights)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {resume.certifications && resume.certifications.length > 0 && (
        <section>
          <h4>Certifications</h4>
          {resume.certifications
            .map(stripBulletPrefix)
            .filter(Boolean)
            .map((cert, index) => (
              <p key={`${cert}-${index}`}>{formatLine(cert, highlights)}</p>
            ))}
        </section>
      )}

      {diff && diff.droppedOther.length > 0 && (
        <section className="dropped-section">
          <h4>Left out of the rewrite</h4>
          <ul>
            {diff.droppedOther.map((text, index) => (
              <li className="dropped" key={`other-${index}`}>
                <del>{text}</del>
              </li>
            ))}
          </ul>
        </section>
      )}

      {resume.sections?.map((section, index) => (
        <section key={`${section.heading}-${index}`}>
          <h4>{section.heading}</h4>
          <ul>
            {section.bullets.map((bullet, bulletIndex) => (
              <li key={`${bullet.slice(0, 24)}-${bulletIndex}`}>
                {formatLine(stripBulletPrefix(bullet), highlights)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Renders one line as a comparison: green for new wording, struck for what it replaced. */
function renderDiff(text: string, diff: ResumeDiff): JSX.Element {
  if (diff.additions.has(text)) return <ins>{text}</ins>;

  const parts = diff.lines.get(text);
  if (!parts) return <>{text}</>;

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={`${part.kind}-${index}`}>
          {index > 0 && ' '}
          {renderPart(part)}
        </Fragment>
      ))}
    </>
  );
}

function renderPart(part: DiffPart): JSX.Element | string {
  if (part.kind === 'added') return <ins>{part.text}</ins>;
  if (part.kind === 'removed') return <del>{part.text}</del>;
  return part.text;
}

/** The lines an original role lost, shown struck through under the bullets that stayed. */
function droppedItems(diff: ResumeDiff | undefined, roleIndex: number): JSX.Element[] {
  return (diff?.droppedByRole.get(roleIndex) ?? []).map((text, index) => (
    <li className="dropped" key={`dropped-${index}`}>
      <del>{text}</del>
    </li>
  ));
}

function formatLine(text: string, keywords: string[]): (string | JSX.Element)[] {
  const parts = splitMetricParts(text);
  const nodes: (string | JSX.Element)[] = [];

  parts.forEach((part, index) => {
    const marked = mark(part.text, keywords);
    if (part.emphasize) {
      nodes.push(<strong key={`metric-${index}`}>{marked}</strong>);
    } else {
      nodes.push(...marked);
    }
  });

  return nodes.length ? nodes : [text];
}

function mark(text: string, keywords: string[]): (string | JSX.Element)[] {
  const terms = [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))];
  if (!terms.length) return [text];

  const pattern = terms
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');

  return text
    .split(new RegExp(`(${pattern})`, 'gi'))
    .map((part, index) => (index % 2 === 1 ? <mark key={`${part}-${index}`}>{part}</mark> : part));
}
