import { useState } from 'react';
import { setProfile } from '../../lib/storage';
import type { Address, Profile, ScreeningAnswer } from '../../lib/types';
import { useAction } from '../hooks';

/** Every profile key that holds a plain string, which is every field a section renders. */
type TextKey = Exclude<keyof Profile, 'address' | 'screeningAnswers'>;

interface FieldSpec {
  label: string;
  placeholder?: string;
  /** Address fields live one level down; everything else sits on the profile itself. */
  scope?: 'address';
  key: TextKey | keyof Address;
  /** A closed set, rendered as a select. */
  choices?: { value: string; label: string }[];
  /** Offered as a datalist on a free-text field, so an unusual answer is still typeable. */
  suggestions?: string[];
  type?: 'date';
  /** Span both columns, for values too long to read in a half-width box. */
  wide?: boolean;
}

interface SectionSpec {
  id: string;
  title: string;
  description?: string;
  fields: FieldSpec[];
}

const YES_NO = [
  { value: '', label: 'Not set' },
  { value: 'no', label: 'No' },
  { value: 'yes', label: 'Yes' },
];

const DECLINE = 'Decline to self-identify';

const SECTIONS: SectionSpec[] = [
  {
    id: 'identity',
    title: 'Identity',
    fields: [
      { key: 'firstName', label: 'First name' },
      { key: 'middleName', label: 'Middle name', placeholder: 'Optional' },
      { key: 'lastName', label: 'Last name' },
      { key: 'pronouns', label: 'Pronouns', placeholder: 'Optional', suggestions: ['she/her', 'he/him', 'they/them'] },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      {
        key: 'preferredContact',
        label: 'Preferred contact method',
        suggestions: ['Email', 'Phone', 'Text message', 'LinkedIn'],
      },
    ],
  },
  {
    id: 'address',
    title: 'Address',
    description: 'Your resume header shows only the city, region and country from this.',
    fields: [
      { scope: 'address', key: 'line1', label: 'Street address', placeholder: '1200 Market St' },
      { scope: 'address', key: 'line2', label: 'Apt / suite', placeholder: 'Optional' },
      { scope: 'address', key: 'city', label: 'City' },
      { scope: 'address', key: 'state', label: 'State / region' },
      { scope: 'address', key: 'postalCode', label: 'ZIP / postal code' },
      { scope: 'address', key: 'country', label: 'Country' },
    ],
  },
  {
    id: 'links',
    title: 'Links',
    fields: [
      { key: 'linkedin', label: 'LinkedIn URL' },
      { key: 'github', label: 'GitHub URL' },
      { key: 'portfolio', label: 'Portfolio URL' },
    ],
  },
  {
    id: 'role',
    title: 'Role and preferences',
    fields: [
      { key: 'currentTitle', label: 'Current title' },
      { key: 'yearsExperience', label: 'Years of experience', placeholder: '6' },
      { key: 'salaryExpectation', label: 'Salary expectation', placeholder: '150000' },
      { key: 'noticePeriod', label: 'Notice period', placeholder: '4 weeks' },
      { key: 'availableStartDate', label: 'Available start date', type: 'date' },
      { key: 'willingToRelocate', label: 'Willing to relocate', choices: YES_NO },
      {
        key: 'workPreference',
        label: 'Work preference',
        suggestions: ['Remote', 'Hybrid', 'On-site', 'Flexible'],
      },
    ],
  },
  {
    id: 'eligibility',
    title: 'Work eligibility',
    fields: [
      { key: 'workAuthorization', label: 'Work authorization', placeholder: 'Yes' },
      { key: 'requiresSponsorship', label: 'Needs visa sponsorship', choices: YES_NO },
    ],
  },
  {
    id: 'application',
    title: 'Application questions',
    fields: [
      {
        key: 'referralSource',
        label: 'How you heard about the role',
        suggestions: ['LinkedIn', 'Company website', 'Indeed', 'Employee referral', 'Recruiter'],
      },
      { key: 'previouslyEmployed', label: 'Previously employed there', choices: YES_NO },
      { key: 'isOver18', label: 'Are you 18 or older', choices: YES_NO },
      { key: 'hasRelativesAtCompany', label: 'Relatives at the company', choices: YES_NO },
      {
        key: 'relativesDetail',
        label: 'Relative names',
        placeholder: 'N/A',
        wide: true,
      },
      {
        key: 'agreeToTerms',
        label: 'Agree to privacy notices and terms',
        choices: YES_NO,
        wide: true,
      },
    ],
  },
  {
    id: 'eeo',
    title: 'Voluntary self-identification',
    description:
      'Optional everywhere it is asked. Anything left blank is simply not filled in, and "Decline to self-identify" is a valid answer on every form that asks.',
    fields: [
      {
        key: 'gender',
        label: 'Gender',
        wide: true,
        suggestions: ['Male', 'Female', 'Non-binary', DECLINE],
      },
      {
        key: 'ethnicity',
        label: 'Race / ethnicity',
        wide: true,
        suggestions: [
          'Hispanic or Latino',
          'White (Not Hispanic or Latino)',
          'Black or African American',
          'Asian',
          'Native Hawaiian or Other Pacific Islander',
          'American Indian or Alaska Native',
          'Two or More Races',
          DECLINE,
        ],
      },
      {
        key: 'veteranStatus',
        label: 'Veteran status',
        wide: true,
        suggestions: ['I am not a protected veteran', 'I identify as a protected veteran', DECLINE],
      },
      {
        key: 'disabilityStatus',
        label: 'Disability status',
        wide: true,
        suggestions: [
          'Yes, I have a disability, or have had one in the past',
          'No, I do not have a disability',
          DECLINE,
        ],
      },
    ],
  },
];

function readField(profile: Profile, field: FieldSpec): string {
  return field.scope === 'address'
    ? profile.address[field.key as keyof Address]
    : String(profile[field.key as TextKey] ?? '');
}

function writeField(profile: Profile, field: FieldSpec, value: string): Profile {
  if (field.scope === 'address') {
    return { ...profile, address: { ...profile.address, [field.key]: value } };
  }
  // The schema pairs each closed field with the exact values it accepts, so this is
  // sound by construction — TypeScript just cannot see that through a computed key.
  return { ...profile, [field.key]: value } as Profile;
}

/** What a preview shows for a value: the choice's label, or the raw text. */
function displayValue(field: FieldSpec, value: string): string {
  if (!value) return '';
  const choice = field.choices?.find((option) => option.value === value);
  return choice && choice.value ? choice.label : value;
}

export function ProfileForm({ profile }: { profile: Profile }) {
  const { pending, error, run } = useAction();
  // One section edits at a time, so two drafts of the same profile can never race.
  const [editing, setEditing] = useState<string | null>(null);
  const [savedSection, setSavedSection] = useState<string | null>(null);

  const save = (id: string, next: Profile) =>
    run('save', async () => {
      await setProfile(next);
      setEditing(null);
      setSavedSection(id);
    });

  const open = (id: string) => {
    setEditing(id);
    setSavedSection(null);
  };

  return (
    <div className="stack">
      <p className="small muted">
        Autofill types these values into application forms. Empty fields are left alone.
      </p>

      {SECTIONS.map((section) => (
        <section className="card stack" key={section.id}>
          <div className="section-head">
            <h2>{section.title}</h2>
            {editing !== section.id && (
              <button className="ghost" onClick={() => open(section.id)}>
                Edit
              </button>
            )}
          </div>
          {section.description && <p className="small muted">{section.description}</p>}

          {editing === section.id ? (
            <SectionEditor
              section={section}
              profile={profile}
              saving={pending === 'save'}
              onCancel={() => setEditing(null)}
              onSave={(next) => save(section.id, next)}
            />
          ) : (
            <SectionPreview section={section} profile={profile} />
          )}

          {savedSection === section.id && !error && <div className="notice">Saved.</div>}
        </section>
      ))}

      <ScreeningAnswers
        profile={profile}
        editing={editing === 'answers'}
        saving={pending === 'save'}
        saved={savedSection === 'answers' && !error}
        onEdit={() => open('answers')}
        onCancel={() => setEditing(null)}
        onSave={(next) => save('answers', next)}
      />

      {error && <div className="error">{error}</div>}
    </div>
  );
}

function SectionPreview({ section, profile }: { section: SectionSpec; profile: Profile }) {
  return (
    <dl className="preview">
      {section.fields.map((field) => {
        const value = displayValue(field, readField(profile, field));
        return (
          <div className={field.wide ? 'preview-row span2' : 'preview-row'} key={String(field.key)}>
            <dt>{field.label}</dt>
            <dd className={value ? undefined : 'muted'}>{value || 'Not set'}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function SectionEditor({
  section,
  profile,
  saving,
  onCancel,
  onSave,
}: {
  section: SectionSpec;
  profile: Profile;
  saving: boolean;
  onCancel: () => void;
  onSave: (next: Profile) => void;
}) {
  // Mounted only while editing, so the draft always starts from what is stored.
  const [draft, setDraft] = useState<Profile>(profile);

  return (
    <>
      <div className="grid2">
        {section.fields.map((field) => {
          const id = `profile-${section.id}-${String(field.key)}`;
          const value = readField(draft, field);
          const set = (next: string) => setDraft((current) => writeField(current, field, next));

          return (
            <div className={field.wide ? 'span2' : undefined} key={String(field.key)}>
              <label htmlFor={id}>{field.label}</label>
              {field.choices ? (
                <select id={id} value={value} onChange={(event) => set(event.target.value)}>
                  {field.choices.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    id={id}
                    type={field.type ?? 'text'}
                    value={value}
                    placeholder={field.placeholder}
                    list={field.suggestions ? `${id}-options` : undefined}
                    onChange={(event) => set(event.target.value)}
                  />
                  {field.suggestions && (
                    <datalist id={`${id}-options`}>
                      {field.suggestions.map((option) => (
                        <option key={option} value={option} />
                      ))}
                    </datalist>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="row wrap">
        <button className="primary" disabled={saving} onClick={() => onSave(draft)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="secondary" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function ScreeningAnswers({
  profile,
  editing,
  saving,
  saved,
  onEdit,
  onCancel,
  onSave,
}: {
  profile: Profile;
  editing: boolean;
  saving: boolean;
  saved: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (next: Profile) => void;
}) {
  return (
    <section className="card stack">
      <div className="section-head">
        <h2>Saved answers</h2>
        {!editing && (
          <button className="ghost" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
      <p className="small muted">
        Reused for screening questions. Autofill matches a question when most of its words overlap.
      </p>

      {editing ? (
        <ScreeningEditor
          profile={profile}
          saving={saving}
          onCancel={onCancel}
          onSave={onSave}
        />
      ) : profile.screeningAnswers.length === 0 ? (
        <div className="small muted">No saved answers yet.</div>
      ) : (
        <dl className="preview">
          {profile.screeningAnswers.map((answer) => (
            <div className="preview-row" key={answer.id}>
              <dt>{answer.question || 'Untitled question'}</dt>
              <dd className={answer.answer ? undefined : 'muted'}>{answer.answer || 'Not set'}</dd>
            </div>
          ))}
        </dl>
      )}

      {saved && <div className="notice">Saved.</div>}
    </section>
  );
}

function ScreeningEditor({
  profile,
  saving,
  onCancel,
  onSave,
}: {
  profile: Profile;
  saving: boolean;
  onCancel: () => void;
  onSave: (next: Profile) => void;
}) {
  const [answers, setAnswers] = useState<ScreeningAnswer[]>(profile.screeningAnswers);

  const patch = (index: number, change: Partial<ScreeningAnswer>) =>
    setAnswers((current) =>
      current.map((answer, position) => (position === index ? { ...answer, ...change } : answer)),
    );

  return (
    <>
      {answers.map((answer, index) => (
        <div className="section-edit stack" key={answer.id}>
          <div>
            <label htmlFor={`question-${answer.id}`}>Question</label>
            <input
              id={`question-${answer.id}`}
              value={answer.question}
              placeholder="Why do you want to work here?"
              onChange={(event) => patch(index, { question: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor={`answer-${answer.id}`}>Answer</label>
            <textarea
              id={`answer-${answer.id}`}
              value={answer.answer}
              onChange={(event) => patch(index, { answer: event.target.value })}
            />
          </div>
          <button
            className="ghost"
            onClick={() => setAnswers((current) => current.filter((item) => item.id !== answer.id))}
          >
            Remove
          </button>
        </div>
      ))}

      <button
        className="secondary"
        onClick={() =>
          setAnswers((current) => [...current, { id: crypto.randomUUID(), question: '', answer: '' }])
        }
      >
        Add answer
      </button>

      <div className="row wrap">
        <button
          className="primary"
          disabled={saving}
          onClick={() => onSave({ ...profile, screeningAnswers: answers })}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="secondary" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}
