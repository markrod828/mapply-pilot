/**
 * Resume building principles used by the tailor prompts and the post-processing
 * pass that polishes structured output before PDF/preview render.
 */
export const RESUME_BUILD_RULES = `RESUME BUILDING RULES (follow every one):

Golden rule: make the employer's job easier. In 10–15 seconds they should see:
WHO YOU ARE → WHAT YOU CAN DO → WHAT YOU'VE ACCOMPLISHED → WHY YOU FIT THIS JOB

1. Easy to scan: clear standard headings (Summary, Education, Experience, Projects, Technical
   Skills, Certifications), short bullets, generous white space. No walls of text.

2. Strategic emphasis: job titles, certifications, and measurable results stand out through structure
   and word choice—not decorative formatting or bolding entire paragraphs.

3. Job relevance first: the target job posting decides what gets the most attention. Emphasize
   matching experience, skills and keywords. Re-angle unrelated content toward whatever in it
   does transfer rather than trimming it away.
4. Accomplishments, not duties: never open with "Responsible for", "Duties included", or
   "Helped with". Show what was achieved.
   Weak: "Responsible for helping customers."
   Strong: "Assisted 50+ customers per shift and resolved issues efficiently."

5. Truthful numbers: include real metrics from the original resume (counts, %, $, time saved).
   Never invent numbers. If the original has no metric for a bullet, do not fabricate one.

6. Customize for this job: mirror the posting's vocabulary where your experience supports it.

7. Section order (the renderer enforces this): Summary → Education → Experience → Projects →
   Technical Skills → Certifications.

8. Professional design: one readable font family, consistent headings and spacing, dark text,
   minimal color. No graphics, icons, charts, photos or decorative elements.

9. Concise length: early-career (roughly ≤7 years or ≤2 roles) should fit one page. More
   experienced candidates may use two pages only when every section earns its place.

10. Remove filler: every bullet and skill must help convince an employer to interview. Filler
    means a line that demonstrates nothing - a duty restated, a tool merely named. A real
    achievement in an unrelated domain is not filler; it is evidence wearing the wrong label, and
    it gets re-angled rather than deleted.

11. Strong action verbs: start bullets with words like Managed, Created, Increased, Reduced,
    Trained, Organized, Developed, Resolved, Coordinated, Improved, Analyzed, Maintained,
    Built, Designed, Implemented, Led, Delivered, Optimized, Automated.

12. Believable skills: list at most 18 skills total across all groups. Only skills you can
    demonstrate through the experience bullets.

13. ATS-friendly: use standard section names. No text boxes, columns or graphics.

14. Proofread: correct spelling and grammar; consistent tense (past for prior roles, present for
    current role).

15. Professional contact: name, phone, email, location—handled by the template header.

16. Never lie or exaggerate: make real experience look its best; never invent employers, titles,
    dates, degrees, certifications, projects or metrics.`;

/** Duty-style openers the polish pass flags and the prompt forbids. */
export const WEAK_BULLET_OPENERS =
  /^(responsible for|duties included|duties were|tasked with|helped with|worked on|assisted with|in charge of)\b/i;

export const ACTION_VERBS = [
  'Managed',
  'Created',
  'Increased',
  'Reduced',
  'Trained',
  'Organized',
  'Developed',
  'Resolved',
  'Coordinated',
  'Improved',
  'Analyzed',
  'Maintained',
  'Built',
  'Designed',
  'Implemented',
  'Led',
  'Delivered',
  'Optimized',
  'Automated',
  'Architected',
  'Deployed',
  'Migrated',
];

export const MAX_SKILLS_TOTAL = 18;
export const MAX_BULLET_WORDS = 28;
export const MAX_SUMMARY_SENTENCES = 3;

/** Trim bullets, cap skills, tighten summary—never invent content. */
export function polishStructuredResume<T extends {
  summary: string;
  skillGroups: { category: string; items: string[] }[];
  skills: string[];
  experience: { bullets: string[] }[];
  projects: { bullets: string[] }[];
}>(resume: T): T {
  const skillGroups = capSkillGroups(resume.skillGroups);
  const skills = skillGroups.flatMap((group) => group.items);

  return {
    ...resume,
    summary: trimSummary(resume.summary),
    skillGroups,
    skills,
    experience: resume.experience.map((role) => ({
      ...role,
      bullets: role.bullets.map(polishBullet).filter(Boolean),
    })),
    projects: resume.projects.map((project) => ({
      ...project,
      bullets: project.bullets.map(polishBullet).filter(Boolean).slice(0, 3),
    })),
  };
}

export function polishBullet(text: string): string {
  let bullet = text.replace(/\s+/g, ' ').trim();
  if (!bullet) return '';

  // Trim to readable length without cutting mid-word harshly.
  const words = bullet.split(' ');
  if (words.length > MAX_BULLET_WORDS) {
    bullet = `${words.slice(0, MAX_BULLET_WORDS).join(' ')}…`;
  }

  return bullet.charAt(0).toUpperCase() + bullet.slice(1);
}

export function trimSummary(summary: string): string {
  const clean = summary.replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(0, MAX_SUMMARY_SENTENCES).join(' ');
}

export function capSkillGroups(groups: { category: string; items: string[] }[]): { category: string; items: string[] }[] {
  const capped: { category: string; items: string[] }[] = [];
  let remaining = MAX_SKILLS_TOTAL;

  for (const group of groups) {
    if (remaining <= 0) break;
    const items = group.items.slice(0, remaining);
    if (!items.length) continue;
    capped.push({ category: group.category, items });
    remaining -= items.length;
  }

  return capped;
}

/** One-page vs two-page hint passed into the tailor prompt. */
export function pageLengthHint(roleCount: number, totalYearsHint?: string): string {
  const years = parseInt(totalYearsHint ?? '', 10);
  if (roleCount <= 2 && (!Number.isFinite(years) || years <= 7)) {
    return 'LENGTH TARGET: one page. Keep bullets tight and omit low-value content.';
  }
  if (roleCount <= 3 && (!Number.isFinite(years) || years <= 10)) {
    return 'LENGTH TARGET: prefer one page; use two only if every section is high-value.';
  }
  return 'LENGTH TARGET: up to two pages. Still trim irrelevant content—every line must earn its place.';
}

/** Split text so preview/PDF can bold truthful metrics ($, %, counts). */
export const METRIC_FRAGMENT = /\$?\d[\d,]*(?:\.\d+)?%?|\d+\+/;

export function splitMetricParts(text: string): { text: string; emphasize: boolean }[] {
  return text
    .split(/(\$?\d[\d,]*(?:\.\d+)?%?|\d+\+)/g)
    .filter(Boolean)
    .map((part) => ({
      text: part,
      emphasize: METRIC_FRAGMENT.test(part),
    }));
}

export function hasWeakBullets(resume: { experience: { bullets: string[] }[]; projects: { bullets: string[] }[] }): boolean {
  const all = [
    ...resume.experience.flatMap((role) => role.bullets),
    ...resume.projects.flatMap((project) => project.bullets),
  ];
  return all.some((bullet) => WEAK_BULLET_OPENERS.test(bullet.trim()));
}
