import { splitMetricParts } from '../../lib/resumeBuildRules';
import { stripBulletPrefix } from '../../lib/resumeFormat';
import type {
  EducationEntry,
  ExperienceEntry,
  Profile,
  ProjectEntry,
  ResumeSection,
  ResumeTemplate,
  SkillGroup,
} from '../../lib/types';

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
}

export function ResumePreview({ profile, resume, template, highlights }: Props) {
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  const contact = [
    profile.email,
    profile.phone,
    [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
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
        {resume.headline && <div className="paper-headline">{resume.headline}</div>}
        {contact.length > 0 && <div className="paper-contact">{contact.join('  ·  ')}</div>}
      </header>

      {resume.summary && (
        <section>
          <h4>Summary</h4>
          <p>{formatLine(resume.summary, highlights)}</p>
        </section>
      )}

      {skillGroups.length > 0 && (
        <section>
          <h4>Skills</h4>
          <div className="skill-groups">
            {skillGroups.map((group) => (
              <div className="skill-row" key={group.category}>
                <strong>{group.category}:</strong>{' '}
                <span>{formatLine(group.items.join(', '), highlights)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {resume.experience && resume.experience.length > 0 && (
        <section>
          <h4>Experience</h4>
          {resume.experience.map((role, index) => (
            <div className="role" key={`${role.title}-${role.company}-${index}`}>
              <div className="role-title">
                {[role.title, role.company].filter(Boolean).join('  |  ')}
              </div>
              {role.dates && <div className="role-dates">{role.dates}</div>}
              <ul>
                {role.bullets.map((bullet, bulletIndex) => (
                  <li key={`${bullet.slice(0, 24)}-${bulletIndex}`}>
                    {formatLine(stripBulletPrefix(bullet), highlights)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {resume.projects && resume.projects.length > 0 && (
        <section>
          <h4>Projects</h4>
          {resume.projects.map((project, index) => (
            <div className="role" key={`${project.name}-${index}`}>
              <div className="role-title">{project.name}</div>
              <ul>
                {project.bullets.slice(0, 3).map((bullet, bulletIndex) => (
                  <li key={`${bullet.slice(0, 24)}-${bulletIndex}`}>
                    {formatLine(stripBulletPrefix(bullet), highlights)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {resume.education && resume.education.length > 0 && (
        <section>
          <h4>Education</h4>
          {resume.education.map((entry, index) => (
            <div className="role" key={`${entry.school}-${index}`}>
              <div className="role-title">
                {[entry.school, entry.location].filter(Boolean).join('  —  ')}
              </div>
              {[entry.degree, entry.year].filter(Boolean).length > 0 && (
                <div className="role-dates">{[entry.degree, entry.year].filter(Boolean).join(', ')}</div>
              )}
              {entry.details.length > 0 && (
                <ul>
                  {entry.details.slice(0, 2).map((detail, detailIndex) => (
                    <li key={`${detail.slice(0, 24)}-${detailIndex}`}>
                      {formatLine(stripBulletPrefix(detail), highlights)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}

      {resume.certifications && resume.certifications.length > 0 && (
        <section>
          <h4>Certifications</h4>
          <p>{formatLine(resume.certifications.map(stripBulletPrefix).filter(Boolean).join('  ·  '), highlights)}</p>
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
