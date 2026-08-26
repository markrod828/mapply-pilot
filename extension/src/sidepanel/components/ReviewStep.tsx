import { useEffect, useMemo, useState } from 'react';
import { sendMessage } from '../../lib/messages';
import { buildResumeDiff } from '../../lib/resumeDiff';
import { TEMPLATES, buildResumePdf } from '../../lib/resumePdf';
import { saveResumePdf } from '../../lib/saveLocation';
import { setSettings, updateJob } from '../../lib/storage';
import { storeTailoredPdf } from '../../lib/tailoredFile';
import { containsKeyword, renderResumeText } from '../../lib/tailor';
import type { JobRecord, Profile, ResumeTemplate, Settings, TailoredResume } from '../../lib/types';
import { CoverLetterCard } from './CoverLetterCard';
import { ResumePreview } from './ResumePreview';
import { ScoreGauge } from './ScoreGauge';

/** Debounce so typing in the editor does not rebuild the PDF on every keystroke. */
const PDF_SYNC_DELAY_MS = 600;

const QUICK_INSTRUCTIONS = [
  'Rewrite duty-style bullets as accomplishments with truthful metrics from my original resume',
  'Use stronger action verbs in my most recent role',
  'Tighten my most recent role to 6-8 accomplishment-focused bullets',
  'Shorten my summary and align it with my headline stack',
  'Trim skills to my strongest 15 and remove filler',
  'Trim each project to 2-3 impactful bullets',
];

type Mode = 'preview' | 'changes' | 'edit';

const MODES: { id: Mode; label: string }[] = [
  { id: 'preview', label: 'Preview' },
  { id: 'changes', label: 'Changes' },
  { id: 'edit', label: 'Edit' },
];

interface Props {
  record: JobRecord;
  profile: Profile;
  settings: Settings;
  /** Your default resume text, compared against the draft in "Changes" mode. */
  originalText: string;
  pending: string | null;
  run: (name: string, action: () => Promise<void>) => Promise<void>;
  onBack: () => void;
}

export function ReviewStep({ record, profile, settings, originalText, pending, run, onBack }: Props) {
  const tailored = record.tailored;
  const [draft, setDraft] = useState<TailoredResume | null>(tailored ?? null);
  const [mode, setMode] = useState<Mode>('preview');
  const [instruction, setInstruction] = useState('');
  const [savedTo, setSavedTo] = useState<string | null>(null);

  useEffect(() => {
    setDraft(tailored ?? null);
  }, [tailored?.createdAt, tailored?.jobKey]);

  const draftText = useMemo(() => (draft ? renderResumeText(draft) : ''), [draft]);

  const comparison = useMemo(
    () => (draft && originalText ? buildResumeDiff(originalText, draft, draftText) : undefined),
    [draft, draftText, originalText],
  );

  // Autofill attaches whatever PDF is stored for this job, so keep that file in step
  // with the draft on screen - including edits that were never accepted.
  useEffect(() => {
    if (!draft) return undefined;
    const timer = window.setTimeout(() => {
      void storeTailoredPdf(record.job.jobKey, profile, draft, settings.resumeTemplate).catch(() => {
        // Autofill reports the fallback to the default resume, so stay quiet here.
      });
    }, PDF_SYNC_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, draftText, profile, record.job.jobKey, settings.resumeTemplate]);

  if (!draft) return null;

  const update = (patch: Partial<TailoredResume>) => setDraft({ ...draft, ...patch });
  const busy = pending !== null;

  const template = settings.resumeTemplate;
  const selectTemplate = (next: ResumeTemplate) => setSettings({ ...settings, resumeTemplate: next });

  const acceptDraft = async () => {
    const accepted: TailoredResume = { ...draft, text: draftText, accepted: true };
    await storeTailoredPdf(record.job.jobKey, profile, accepted, template);
    await updateJob(record.job.jobKey, (current) => ({
      ...current,
      tailored: accepted,
      tailoredScore: undefined,
    }));
    const response = await sendMessage<{ ok: boolean; error?: string }>({
      type: 'REQUEST_RESCORE_TAILORED',
      jobKey: record.job.jobKey,
    });
    if (!response.ok) throw new Error(response.error ?? 'Re-scoring failed.');
  };

  const downloadPdf = async () => {
    const pdf = await buildResumePdf(profile, { ...draft, text: draftText }, template);
    const saved = await saveResumePdf(pdf, profile, record.job);
    setSavedTo(saved.location);
  };

  const refine = async (text: string) => {
    const response = await sendMessage<{ ok: boolean; error?: string }>({
      type: 'REQUEST_REFINE',
      jobKey: record.job.jobKey,
      instruction: text,
    });
    if (!response.ok) throw new Error(response.error ?? 'Refinement failed.');
    setInstruction('');
  };

  const before = record.baseScore?.overall;
  const after = record.tailoredScore?.overall;
  const highlights = [...draft.addedKeywords, ...draft.options.selectedKeywords];

  // Measured against the same keyword list as the original score, so this number is
  // comparable even when the model's own score moves around.
  const scoredKeywords = record.baseScore?.keywords ?? [];
  const coverageBefore = scoredKeywords.filter((keyword) => keyword.present).length;
  const coverageAfter = scoredKeywords.filter((keyword) => containsKeyword(draftText, keyword.term)).length;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            {after !== undefined && before !== undefined ? (
              <h2 style={{ margin: 0 }}>
                Your score went from {before} to {after}
              </h2>
            ) : (
              <h2 style={{ margin: 0 }}>Draft ready</h2>
            )}
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              {after === undefined
                ? 'Accept the draft to store it and score the tailored version.'
                : draft.accepted
                  ? 'Autofill will attach this version for this job.'
                  : 'You have unsaved edits — accept again to store them.'}
            </p>
          </div>
          {after !== undefined && <ScoreGauge score={after} />}
        </div>

        {scoredKeywords.length > 0 && (
          <div className="coverage">
            <span>ATS keyword coverage</span>
            <strong>
              {coverageBefore}/{scoredKeywords.length} → {coverageAfter}/{scoredKeywords.length}
            </strong>
          </div>
        )}

        <div>
          <h3 style={{ marginTop: 0 }}>What changed</h3>
          <ul className="notes">
            {draft.stats.summaryUpdated && <li>Summary rewritten for this role</li>}
            {draft.stats.bulletsRewritten > 0 && <li>Enhanced {draft.stats.bulletsRewritten} experience bullets</li>}
            {draft.stats.skillsAdded > 0 && <li>Added {draft.stats.skillsAdded} skills</li>}
            {draft.changeNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>

        {draft.addedKeywords.length > 0 && (
          <div>
            <h3>Keywords worked in ({draft.addedKeywords.length})</h3>
            <div className="chips">
              {draft.addedKeywords.map((keyword) => (
                <span className="chip matched" key={keyword}>
                  ✓ {keyword}
                </span>
              ))}
            </div>
          </div>
        )}

        {draft.omittedKeywords.length > 0 && (
          <div>
            <h3>Could not add</h3>
            <ul className="notes">
              {draft.omittedKeywords.map((item) => (
                <li key={item.keyword}>
                  <strong>{item.keyword}</strong> — {item.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Your new resume</h2>
          <div className="row" style={{ gap: 2 }}>
            {MODES.map((item) => (
              <button
                key={item.id}
                className={mode === item.id ? 'secondary' : 'ghost'}
                onClick={() => setMode(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {mode !== 'edit' ? (
          <>
            {mode === 'preview' && (
              <div className="template-picker">
                {(Object.keys(TEMPLATES) as ResumeTemplate[]).map((key) => (
                  <button
                    type="button"
                    key={key}
                    className={`template-option ${template === key ? 'selected' : ''}`}
                    onClick={() => void selectTemplate(key)}
                  >
                    <strong>{TEMPLATES[key].label}</strong>
                    <span>{TEMPLATES[key].description}</span>
                  </button>
                ))}
              </div>
            )}
            {mode === 'changes' && (
              <div className="diff-legend">
                <span>
                  <ins>green</ins> new or rewritten wording
                </span>
                <span>
                  <del>struck</del> wording from your original
                </span>
              </div>
            )}
            <ResumePreview
              profile={profile}
              resume={draft}
              template={template}
              highlights={mode === 'changes' ? [] : highlights}
              diff={mode === 'changes' ? comparison : undefined}
            />
            <p className="small muted" style={{ margin: 0 }}>
              {mode === 'changes'
                ? 'Each line is matched to the closest line in your original resume, so unchanged text stays plain. Lines with no match are shown as new.'
                : 'Both templates are single-column with no tables or graphics, so parsers still read them in order. The PDF you download or autofill matches this preview.'}
            </p>
          </>
        ) : (
          <div className="stack">
            <div>
              <label htmlFor="tailor-headline">Headline</label>
              <input
                id="tailor-headline"
                value={draft.headline}
                placeholder="Full-Stack Engineer | React/TypeScript | Java/Spring Boot | AWS"
                onChange={(event) => update({ headline: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="tailor-summary">Summary</label>
              <textarea
                id="tailor-summary"
                value={draft.summary}
                onChange={(event) => update({ summary: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="tailor-skills">Skills (Category: a, b, c — one group per line)</label>
              <textarea
                id="tailor-skills"
                rows={5}
                value={(draft.skillGroups ?? [])
                  .map((group) => `${group.category}: ${group.items.join(', ')}`)
                  .join('\n')}
                onChange={(event) => {
                  const skillGroups = event.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => {
                      const splitAt = line.indexOf(':');
                      if (splitAt === -1) {
                        return {
                          category: 'Skills',
                          items: line.split(',').map((item) => item.trim()).filter(Boolean),
                        };
                      }
                      return {
                        category: line.slice(0, splitAt).trim() || 'Skills',
                        items: line
                          .slice(splitAt + 1)
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean),
                    };
                    })
                    .filter((group) => group.items.length > 0);
                  update({
                    skillGroups,
                    skills: skillGroups.flatMap((group) => group.items),
                  });
                }}
              />
            </div>

            {(draft.experience ?? []).map((role, index) => (
              <div className="section-edit" key={`exp-${index}`}>
                <label htmlFor={`exp-title-${index}`}>Role title</label>
                <input
                  id={`exp-title-${index}`}
                  value={role.title}
                  onChange={(event) => {
                    const experience = [...draft.experience];
                    experience[index] = { ...role, title: event.target.value };
                    update({ experience });
                  }}
                />
                <div className="grid2" style={{ marginTop: 6 }}>
                  <div>
                    <label htmlFor={`exp-company-${index}`}>Company</label>
                    <input
                      id={`exp-company-${index}`}
                      value={role.company}
                      onChange={(event) => {
                        const experience = [...draft.experience];
                        experience[index] = { ...role, company: event.target.value };
                        update({ experience });
                      }}
                    />
                  </div>
                  <div>
                    <label htmlFor={`exp-dates-${index}`}>Dates</label>
                    <input
                      id={`exp-dates-${index}`}
                      value={role.dates}
                      onChange={(event) => {
                        const experience = [...draft.experience];
                        experience[index] = { ...role, dates: event.target.value };
                        update({ experience });
                      }}
                    />
                  </div>
                </div>
                <label htmlFor={`exp-bullets-${index}`} style={{ marginTop: 6 }}>
                  Bullets (one per line, no markers)
                </label>
                <textarea
                  id={`exp-bullets-${index}`}
                  value={role.bullets.join('\n')}
                  onChange={(event) => {
                    const experience = [...draft.experience];
                    experience[index] = {
                      ...role,
                      bullets: event.target.value
                        .split('\n')
                        .map((line) => line.replace(/^[\s]*([•\-–—*]+|\d+[.)])\s*/u, '').trim())
                        .filter((line, lineIndex, all) => line.length > 0 || lineIndex < all.length - 1),
                    };
                    update({ experience });
                  }}
                />
              </div>
            ))}

            {(draft.projects ?? []).map((project, index) => (
              <div className="section-edit" key={`proj-${index}`}>
                <label htmlFor={`proj-name-${index}`}>Project</label>
                <input
                  id={`proj-name-${index}`}
                  value={project.name}
                  onChange={(event) => {
                    const projects = [...draft.projects];
                    projects[index] = { ...project, name: event.target.value };
                    update({ projects });
                  }}
                />
                <label htmlFor={`proj-bullets-${index}`} style={{ marginTop: 6 }}>
                  Bullets (2–3, one per line)
                </label>
                <textarea
                  id={`proj-bullets-${index}`}
                  value={project.bullets.join('\n')}
                  onChange={(event) => {
                    const projects = [...draft.projects];
                    projects[index] = {
                      ...project,
                      bullets: event.target.value
                        .split('\n')
                        .map((line) => line.replace(/^[\s]*([•\-–—*]+|\d+[.)])\s*/u, '').trim())
                        .filter(Boolean)
                        .slice(0, 3),
                    };
                    update({ projects });
                  }}
                />
              </div>
            ))}

            {(draft.education ?? []).map((entry, index) => (
              <div className="section-edit" key={`edu-${index}`}>
                <label htmlFor={`edu-school-${index}`}>School</label>
                <input
                  id={`edu-school-${index}`}
                  value={entry.school}
                  onChange={(event) => {
                    const education = [...draft.education];
                    education[index] = { ...entry, school: event.target.value };
                    update({ education });
                  }}
                />
                <div className="grid2" style={{ marginTop: 6 }}>
                  <div>
                    <label htmlFor={`edu-degree-${index}`}>Degree</label>
                    <input
                      id={`edu-degree-${index}`}
                      value={entry.degree}
                      onChange={(event) => {
                        const education = [...draft.education];
                        education[index] = { ...entry, degree: event.target.value };
                        update({ education });
                      }}
                    />
                  </div>
                  <div>
                    <label htmlFor={`edu-year-${index}`}>Year</label>
                    <input
                      id={`edu-year-${index}`}
                      value={entry.year}
                      onChange={(event) => {
                        const education = [...draft.education];
                        education[index] = { ...entry, year: event.target.value };
                        update({ education });
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}

            <div>
              <label htmlFor="tailor-certs">Certifications (separate with · or commas)</label>
              <textarea
                id="tailor-certs"
                value={(draft.certifications ?? []).join(' · ')}
                onChange={(event) =>
                  update({
                    certifications: event.target.value
                      .split(/[·,]/)
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          </div>
        )}

        <div className="row wrap">
          <button className="primary" disabled={busy} onClick={() => void run('accept', acceptDraft)}>
            {pending === 'accept' ? 'Scoring…' : 'Accept & re-score'}
          </button>
          <button className="secondary" disabled={busy} onClick={() => void run('download', downloadPdf)}>
            {pending === 'download' ? 'Saving…' : 'Save PDF'}
          </button>
        </div>
        {savedTo && (
          <p className="small muted" style={{ margin: 0 }}>
            Saved to <strong>{savedTo}</strong>
          </p>
        )}
      </div>

      <CoverLetterCard
        record={record}
        profile={profile}
        settings={settings}
        pending={pending}
        run={run}
      />

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Tweak with AI</h2>
        <div className="chips">
          {QUICK_INSTRUCTIONS.map((text) => (
            <button
              className="chip suggestion"
              key={text}
              disabled={busy}
              onClick={() => void run('refine', () => refine(text))}
            >
              {text}
            </button>
          ))}
        </div>
        <textarea
          value={instruction}
          placeholder="Tell me how you'd like to tweak your resume…"
          onChange={(event) => setInstruction(event.target.value)}
        />
        <button
          className="secondary"
          disabled={busy || !instruction.trim()}
          onClick={() => void run('refine', () => refine(instruction))}
        >
          {pending === 'refine' ? 'Rewriting…' : 'Apply instruction'}
        </button>
        {draft.refinements.length > 0 && (
          <p className="small muted" style={{ margin: 0 }}>
            Applied so far: {draft.refinements.join(' · ')}
          </p>
        )}
      </div>

      <button className="secondary" onClick={onBack} disabled={busy}>
        Back to keywords
      </button>
    </div>
  );
}