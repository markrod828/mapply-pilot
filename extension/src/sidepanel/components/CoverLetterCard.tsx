import { useEffect, useState } from 'react';
import { sendMessage } from '../../lib/messages';
import { saveCoverLetter } from '../../lib/saveLocation';
import { updateJob } from '../../lib/storage';
import { storeCoverLetterPdf } from '../../lib/tailoredFile';
import type { CoverLetter, JobRecord, Profile, Settings } from '../../lib/types';

/** Debounce so typing does not rewrite the stored PDF on every keystroke. */
const PDF_SYNC_DELAY_MS = 600;

interface Props {
  record: JobRecord;
  profile: Profile;
  settings: Settings;
  pending: string | null;
  run: (name: string, action: () => Promise<void>) => Promise<void>;
}

export function CoverLetterCard({ record, profile, settings, pending, run }: Props) {
  const stored = record.coverLetter;
  const [text, setText] = useState(stored?.text ?? '');
  const [savedTo, setSavedTo] = useState<string | null>(null);

  useEffect(() => {
    setText(stored?.text ?? '');
  }, [stored?.createdAt]);

  // Autofill attaches the stored PDF, so keep it in step with what is on screen.
  useEffect(() => {
    if (!text.trim()) return undefined;
    const timer = window.setTimeout(() => {
      void storeCoverLetterPdf(record.job, profile, text, settings.resumeTemplate).catch(() => {
        // Autofill still has the letter as text; the attachment is the extra.
      });
    }, PDF_SYNC_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, profile, record.job, settings.resumeTemplate]);

  const busy = pending !== null;

  const regenerate = () =>
    void run('cover', async () => {
      const response = await sendMessage<{ ok: boolean; error?: string; coverLetter?: CoverLetter }>({
        type: 'REQUEST_COVER_LETTER',
        jobKey: record.job.jobKey,
      });
      if (!response.ok) throw new Error(response.error ?? 'Could not write the cover letter.');
    });

  const saveEdits = () =>
    void run('cover-save', async () => {
      const edited: CoverLetter = { text: text.trim(), createdAt: Date.now() };
      await updateJob(record.job.jobKey, (current) => ({ ...current, coverLetter: edited }));
      await storeCoverLetterPdf(record.job, profile, edited.text, settings.resumeTemplate);
    });

  const savePdf = () =>
    void run('cover-pdf', async () => {
      const saved = await saveCoverLetter(text, profile, record.job, settings.resumeTemplate);
      setSavedTo(saved.location);
    });

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const edited = text.trim() !== (stored?.text ?? '').trim();

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0 }}>Cover letter</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            {stored
              ? `${words} words · autofill pastes this and attaches it where a form asks for a file.`
              : 'Written automatically when you generate a tailored resume.'}
          </p>
        </div>
        <button className="secondary" disabled={busy} onClick={regenerate}>
          {pending === 'cover' ? 'Writing…' : stored ? 'Regenerate' : 'Write one'}
        </button>
      </div>

      {stored ? (
        <>
          <textarea rows={14} value={text} onChange={(event) => setText(event.target.value)} />
          <div className="row wrap">
            <button className="secondary" disabled={busy || !edited} onClick={saveEdits}>
              {pending === 'cover-save' ? 'Saving…' : edited ? 'Save edits' : 'Saved'}
            </button>
            <button className="secondary" disabled={busy || !text.trim()} onClick={savePdf}>
              {pending === 'cover-pdf' ? 'Saving…' : 'Save PDF'}
            </button>
          </div>
          {savedTo && (
            <p className="small muted" style={{ margin: 0 }}>
              Saved to <strong>{savedTo}</strong>
            </p>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            Check every claim before you send it. The prompt forbids inventing facts, but you are
            responsible for what goes out under your name.
          </p>
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          No cover letter yet for this job.
        </p>
      )}
    </div>
  );
}
