import { useEffect, useState } from 'react';
import { setProfile } from '../../lib/storage';
import type { Profile } from '../../lib/types';
import { useAction } from '../hooks';

const TEXT_FIELDS: { key: keyof Profile; label: string; placeholder?: string }[] = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State / region' },
  { key: 'country', label: 'Country' },
  { key: 'currentTitle', label: 'Current title' },
  { key: 'yearsExperience', label: 'Years of experience', placeholder: '6' },
  { key: 'linkedin', label: 'LinkedIn URL' },
  { key: 'github', label: 'GitHub URL' },
  { key: 'portfolio', label: 'Portfolio URL' },
  { key: 'salaryExpectation', label: 'Salary expectation', placeholder: '150000' },
  { key: 'noticePeriod', label: 'Notice period', placeholder: '4 weeks' },
  { key: 'workAuthorization', label: 'Work authorization', placeholder: 'Yes' },
];

export function ProfileForm({ profile }: { profile: Profile }) {
  const { pending, error, run } = useAction();
  const [draft, setDraft] = useState<Profile>(profile);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  const update = (patch: Partial<Profile>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
  };

  const save = () =>
    run('save', async () => {
      await setProfile(draft);
      setSaved(true);
    });

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Application profile</h2>
        <p className="small muted">Autofill types these values into application forms.</p>
        <div className="grid2">
          {TEXT_FIELDS.map((field) => (
            <div key={field.key}>
              <label htmlFor={`profile-${field.key}`}>{field.label}</label>
              <input
                id={`profile-${field.key}`}
                value={String(draft[field.key] ?? '')}
                placeholder={field.placeholder}
                onChange={(event) => update({ [field.key]: event.target.value } as Partial<Profile>)}
              />
            </div>
          ))}
          <div>
            <label htmlFor="profile-sponsorship">Needs visa sponsorship</label>
            <select
              id="profile-sponsorship"
              value={draft.requiresSponsorship}
              onChange={(event) =>
                update({ requiresSponsorship: event.target.value as Profile['requiresSponsorship'] })
              }
            >
              <option value="">Not set</option>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card stack">
        <h2>Saved answers</h2>
        <p className="small muted">
          Reused for screening questions. Autofill matches a question when most of its words overlap.
        </p>

        {draft.screeningAnswers.map((answer, index) => (
          <div className="section-edit stack" key={answer.id}>
            <div>
              <label htmlFor={`question-${answer.id}`}>Question</label>
              <input
                id={`question-${answer.id}`}
                value={answer.question}
                placeholder="Why do you want to work here?"
                onChange={(event) => {
                  const next = [...draft.screeningAnswers];
                  next[index] = { ...answer, question: event.target.value };
                  update({ screeningAnswers: next });
                }}
              />
            </div>
            <div>
              <label htmlFor={`answer-${answer.id}`}>Answer</label>
              <textarea
                id={`answer-${answer.id}`}
                value={answer.answer}
                onChange={(event) => {
                  const next = [...draft.screeningAnswers];
                  next[index] = { ...answer, answer: event.target.value };
                  update({ screeningAnswers: next });
                }}
              />
            </div>
            <button
              className="ghost"
              onClick={() =>
                update({ screeningAnswers: draft.screeningAnswers.filter((item) => item.id !== answer.id) })
              }
            >
              Remove
            </button>
          </div>
        ))}

        <button
          className="secondary"
          onClick={() =>
            update({
              screeningAnswers: [
                ...draft.screeningAnswers,
                { id: crypto.randomUUID(), question: '', answer: '' },
              ],
            })
          }
        >
          Add answer
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {saved && !error && <div className="notice">Profile saved.</div>}

      <button className="primary" disabled={pending !== null} onClick={save}>
        {pending === 'save' ? 'Saving…' : 'Save profile'}
      </button>
    </div>
  );
}
