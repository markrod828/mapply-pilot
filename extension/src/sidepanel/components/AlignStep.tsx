import { useMemo, useState } from 'react';
import { keywordsByCategory } from '@mapply/core/atsScore';
import type { AtsScore, TailorOptions, TailorSections } from '@mapply/core/types';

const SECTION_LABELS: { key: keyof TailorSections; label: string; hint: string }[] = [
  { key: 'summary', label: 'Summary', hint: 'Rewrite the profile to target this role' },
  { key: 'skills', label: 'Skills', hint: 'Reorder and add the keywords you select' },
  { key: 'workExperience', label: 'Work experience', hint: 'Keep all roles; rewrite titles & bullets only' },
  { key: 'projects', label: 'Projects', hint: 'Emphasise the projects that fit this role' },
];

interface Props {
  score: AtsScore;
  options: TailorOptions;
  onChange: (options: TailorOptions) => void;
  onBack: () => void;
  onGenerate: () => void;
  pending: boolean;
  hasDraft: boolean;
}

export function AlignStep({ score, options, onChange, onBack, onGenerate, pending, hasDraft }: Props) {
  const [custom, setCustom] = useState('');

  const missing = useMemo(
    () => score.keywords.filter((keyword) => !keyword.present),
    [score.keywords],
  );
  const groups = useMemo(() => keywordsByCategory(missing), [missing]);

  const customKeywords = options.selectedKeywords.filter(
    (keyword) => !missing.some((item) => item.term.toLowerCase() === keyword.toLowerCase()),
  );

  const toggleSection = (key: keyof TailorSections) =>
    onChange({ ...options, sections: { ...options.sections, [key]: !options.sections[key] } });

  const toggleKeyword = (term: string) =>
    onChange({
      ...options,
      selectedKeywords: options.selectedKeywords.includes(term)
        ? options.selectedKeywords.filter((item) => item !== term)
        : [...options.selectedKeywords, term],
    });

  const selectAll = () => {
    const allSelected = missing.every((keyword) => options.selectedKeywords.includes(keyword.term));
    onChange({
      ...options,
      selectedKeywords: allSelected
        ? customKeywords
        : [...new Set([...options.selectedKeywords, ...missing.map((keyword) => keyword.term)])],
    });
  };

  const addCustom = () => {
    const term = custom.trim();
    if (!term || options.selectedKeywords.some((item) => item.toLowerCase() === term.toLowerCase())) {
      setCustom('');
      return;
    }
    onChange({ ...options, selectedKeywords: [...options.selectedKeywords, term] });
    setCustom('');
  };

  const noSections = !Object.values(options.sections).some(Boolean);

  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>1. Choose sections to enhance</h2>
        {SECTION_LABELS.map((section) => (
          <div key={section.key}>
            <label className="row check" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={options.sections[section.key]}
                onChange={() => toggleSection(section.key)}
              />
              <span>
                <strong>{section.label}</strong>
                <span className="muted small"> — {section.hint}</span>
              </span>
            </label>

            {section.key === 'workExperience' && options.sections.workExperience && (
              <div className="stack indent" style={{ gap: 2 }}>
                {(['quick', 'full'] as const).map((depth) => (
                  <label className="row check small" key={depth} style={{ fontWeight: 400 }}>
                    <input
                      type="radio"
                      name="depth"
                      checked={options.workExperienceDepth === depth}
                      onChange={() => onChange({ ...options, workExperienceDepth: depth })}
                    />
                    <span>
                      {depth === 'quick'
                        ? 'Quick edit (deep rewrite on 2 most recent; keep all roles)'
                        : 'Full edit (rewrite every role; keep all companies & dates)'}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>
            2. Add missing keywords ({options.selectedKeywords.length}/{missing.length})
          </h2>
          {missing.length > 0 && (
            <button className="ghost" onClick={selectAll}>
              Select all
            </button>
          )}
        </div>

        {missing.length === 0 && (
          <p className="small muted" style={{ margin: 0 }}>
            Your resume already covers every keyword the scorer found. Add your own below if you want
            more.
          </p>
        )}

        {groups.map((group) => (
          <div key={group.category}>
            <h3 style={{ marginTop: 4 }}>{group.category}</h3>
            <div className="stack" style={{ gap: 2 }}>
              {group.keywords.map((keyword) => (
                <label className="row check small" key={keyword.term} style={{ fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={options.selectedKeywords.includes(keyword.term)}
                    onChange={() => toggleKeyword(keyword.term)}
                  />
                  <span>{keyword.term}</span>
                </label>
              ))}
            </div>
          </div>
        ))}

        <div>
          <h3 style={{ marginTop: 4 }}>Add your own</h3>
          <div className="row">
            <input
              value={custom}
              placeholder="e.g. GraphQL"
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCustom();
                }
              }}
            />
            <button className="secondary" onClick={addCustom} disabled={!custom.trim()}>
              Add
            </button>
          </div>
          {customKeywords.length > 0 && (
            <div className="chips" style={{ marginTop: 6 }}>
              {customKeywords.map((keyword) => (
                <button className="chip removable" key={keyword} onClick={() => toggleKeyword(keyword)}>
                  {keyword} ✕
                </button>
              ))}
            </div>
          )}
        </div>

        <p className="small muted" style={{ margin: 0 }}>
          Only tick keywords you genuinely have. They are treated as true and written into your
          resume; facts like employers, dates and degrees are never invented.
        </p>
      </div>

      <div className="row">
        <button className="secondary" onClick={onBack} disabled={pending}>
          Back
        </button>
        <button className="primary" style={{ flex: 1 }} onClick={onGenerate} disabled={pending || noSections}>
          {pending ? 'Generating…' : hasDraft ? 'Regenerate resume' : 'Generate my new resume'}
        </button>
      </div>
      {noSections && <p className="small muted">Pick at least one section to enhance.</p>}
    </div>
  );
}
