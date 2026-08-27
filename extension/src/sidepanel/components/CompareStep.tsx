import { scoreVerdict } from '@mapply/core/atsScore';
import type { AtsScore, ComparisonStatus, JobRecord } from '@mapply/core/types';
import { ScoreGauge } from './ScoreGauge';

const STATUS_ICON: Record<ComparisonStatus, string> = {
  match: '✓',
  partial: '!',
  miss: '✕',
};

const BUCKET_LABELS: Record<keyof AtsScore['buckets'], string> = {
  keywordCoverage: 'Keyword coverage',
  skillsOverlap: 'Skills overlap',
  titleExperienceAlignment: 'Title & experience',
  mustHaveRequirements: 'Must-haves',
};

interface Props {
  record: JobRecord;
  score: AtsScore;
  onImprove: () => void;
}

export function CompareStep({ record, score, onImprove }: Props) {
  const verdict = scoreVerdict(score.overall);
  const matched = score.keywords.filter((keyword) => keyword.present).length;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>
              Your resume is {article(verdict.label)} <span style={{ color: verdict.color }}>{verdict.label.toLowerCase()}</span> match
            </h2>
            <div className="small muted">{record.job.title || 'This role'}</div>
          </div>
          <ScoreGauge score={score.overall} />
        </div>

        {verdict.atRisk && (
          <div className="warning">
            Resumes scoring under 60 are usually filtered out before a human reads them.
          </div>
        )}
        {score.rationale && <p className="small muted" style={{ margin: 0 }}>{score.rationale}</p>}
      </div>

      {score.comparison.length > 0 && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>Job vs your resume</h3>
          <table className="compare">
            <thead>
              <tr>
                <th>Requirement</th>
                <th>{record.job.company || 'This job'}</th>
                <th>Your resume</th>
              </tr>
            </thead>
            <tbody>
              {score.comparison.map((row) => (
                <tr key={row.label}>
                  <td>
                    <span className={`status ${row.status}`}>{STATUS_ICON[row.status]}</span>
                    {row.label}
                  </td>
                  <td>{row.jobValue || '—'}</td>
                  <td>{row.resumeValue || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {score.keywords.length > 0 && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>
            ATS keywords ({matched}/{score.keywords.length})
          </h3>
          <div className="chips">
            {score.keywords.map((keyword) => (
              <span className={`chip ${keyword.present ? 'matched' : 'missing'}`} key={keyword.term}>
                {keyword.present ? '✓ ' : ''}
                {keyword.term}
              </span>
            ))}
          </div>
        </div>
      )}

      {score.summaryVerdict && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          <p className="small" style={{ margin: 0 }}>{score.summaryVerdict}</p>
        </div>
      )}

      {score.mustHaveGaps.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Unmet must-haves</h3>
          <ul className="notes">
            {score.mustHaveGaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Score breakdown</h3>
        {(Object.keys(BUCKET_LABELS) as (keyof AtsScore['buckets'])[]).map((key) => (
          <div key={key}>
            <div className="bar-label">
              <span>{BUCKET_LABELS[key]}</span>
              <span>{score.buckets[key]}</span>
            </div>
            <div className="bar">
              <span
                style={{
                  width: `${score.buckets[key]}%`,
                  background: scoreVerdict(score.buckets[key]).color,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <button className="primary" onClick={onImprove}>
        Improve my resume for this job
      </button>
    </div>
  );
}

function article(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a';
}
