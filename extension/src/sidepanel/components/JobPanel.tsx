import { useEffect, useState } from 'react';
import { requestHostAccess } from '../../lib/hosts';
import { sendMessage } from '../../lib/messages';
import {
  DEFAULT_TAILOR_OPTIONS,
  type JobRecord,
  type Profile,
  type ResumeDoc,
  type Settings,
  type TailorOptions,
} from '../../lib/types';
import { useAction } from '../hooks';
import { AlignStep } from './AlignStep';
import { CompareStep } from './CompareStep';
import { ReviewStep } from './ReviewStep';
import { Stepper, type WizardStep } from './Stepper';

interface Props {
  record: JobRecord | null;
  profile: Profile;
  resume: ResumeDoc | null;
  settings: Settings;
  onGoToSettings: () => void;
  onGoToResume: () => void;
}

export function JobPanel({ record, profile, resume, settings, onGoToSettings, onGoToResume }: Props) {
  const { pending, error, run, setError } = useAction();
  const [step, setStep] = useState<WizardStep>('compare');
  const [options, setOptions] = useState<TailorOptions>(DEFAULT_TAILOR_OPTIONS);

  const jobKey = record?.job.jobKey;
  const tailored = record?.tailored;
  // Identifies *which* draft is loaded, so a regenerate/refine re-runs the effect below.
  const draftStamp = tailored?.createdAt;

  // A new job (or a cleared board) resets the wizard, and a draft - whether it was
  // already stored or has just been generated - opens straight on review.
  useEffect(() => {
    setError(null);
    setStep(draftStamp === undefined ? 'compare' : 'review');
    setOptions(tailored?.options ?? DEFAULT_TAILOR_OPTIONS);
    // `tailored` is read only for the options that came with `draftStamp`.
  }, [jobKey, draftStamp, setError]);

  if (!settings.openaiApiKey) {
    return (
      <div className="card stack">
        <h2>Add your OpenAI API key</h2>
        <p className="muted small">
          ApplyPilot uses your own OpenAI key to score and tailor resumes. Nothing is sent anywhere else.
        </p>
        <button className="primary" onClick={onGoToSettings}>
          Open settings
        </button>
      </div>
    );
  }

  if (!resume?.text) {
    return (
      <div className="card stack">
        <h2>Upload your default resume</h2>
        <p className="muted small">
          The ATS score compares this resume against whatever job you open on Jobright.
        </p>
        <button className="primary" onClick={onGoToResume}>
          Add resume
        </button>
      </div>
    );
  }

  if (!record) {
    return (
      <div className="card stack">
        <h2>No job captured yet</h2>
        <p className="muted small">
          Open a posting on <strong>jobright.ai/jobs/info/…</strong>. Switching to a different job
          clears the previous one and starts scoring again.
        </p>
      </div>
    );
  }

  const scoreNow = () =>
    run('score', async () => {
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: 'REQUEST_SCORE',
        job: record.job,
        force: true,
      });
      if (!response.ok) throw new Error(response.error ?? 'Scoring failed.');
    });

  const generate = () =>
    run('tailor', async () => {
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: 'REQUEST_TAILOR',
        jobKey: record.job.jobKey,
        options,
      });
      if (!response.ok) throw new Error(response.error ?? 'Tailoring failed.');
      setStep('review');
    });

  const runAutofill = () =>
    run('autofill', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('No active tab.');
      // Has to happen here, in the click handler: Chrome only shows the optional
      // host-permission prompt during a user gesture, so the worker cannot ask.
      await requestHostAccess(tab.url);
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: 'RUN_AUTOFILL',
        tabId: tab.id,
      });
      if (!response.ok) throw new Error(response.error ?? 'Autofill failed on this page.');
    });

  const reachable: WizardStep[] = ['compare'];
  if (record.baseScore) reachable.push('align');
  if (tailored) reachable.push('review');

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 6 }}>
        <h2 style={{ margin: 0 }}>{record.job.title || 'Untitled role'}</h2>
        <div className="small muted">
          {[record.job.company, record.job.location].filter(Boolean).join(' · ') || record.job.url}
        </div>
        <div className="row wrap" style={{ marginTop: 4 }}>
          <button className="secondary" disabled={pending !== null} onClick={scoreNow}>
            {pending === 'score' ? 'Scoring…' : record.baseScore ? 'Re-score' : 'Score now'}
          </button>
          <button className="secondary" disabled={pending !== null} onClick={runAutofill}>
            {pending === 'autofill' ? 'Filling…' : 'Autofill this page'}
          </button>
        </div>
      </div>

      <Stepper current={step} reachable={reachable} onSelect={setStep} />

      {error && <div className="error">{error}</div>}

      {!record.baseScore ? (
        <div className="notice">Not scored yet. Hit “Score now” to compare your resume with this job.</div>
      ) : step === 'compare' ? (
        <CompareStep record={record} score={record.baseScore} onImprove={() => setStep('align')} />
      ) : step === 'align' ? (
        <AlignStep
          score={record.baseScore}
          options={options}
          onChange={setOptions}
          onBack={() => setStep('compare')}
          onGenerate={generate}
          pending={pending === 'tailor'}
          hasDraft={Boolean(tailored)}
        />
      ) : tailored ? (
        <ReviewStep
          record={record}
          profile={profile}
          settings={settings}
          pending={pending}
          run={run}
          onBack={() => setStep('align')}
        />
      ) : (
        <div className="notice">Generate a tailored resume first.</div>
      )}
    </div>
  );
}
