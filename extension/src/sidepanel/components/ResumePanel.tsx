import { useEffect, useRef, useState } from 'react';
import { DEFAULT_RESUME_FILE, deleteFile, putFile } from '../../lib/db';
import { extractResumeText } from '../../lib/pdfText';
import { setResume } from '../../lib/storage';
import type { ResumeDoc } from '../../lib/types';
import { useAction } from '../hooks';

export function ResumePanel({ resume }: { resume: ResumeDoc | null }) {
  const { pending, error, run, setError } = useAction();
  const [text, setText] = useState(resume?.text ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(resume?.text ?? '');
  }, [resume?.updatedAt]);

  const onFile = (file: File) =>
    run('upload', async () => {
      const extracted = await extractResumeText(file);
      setText(extracted);
      await putFile(DEFAULT_RESUME_FILE, file);
      await setResume({
        fileName: file.name,
        mimeType: file.type || 'application/pdf',
        text: extracted,
        size: file.size,
        updatedAt: Date.now(),
      });
      setStatus(`Loaded ${file.name} (${Math.round(extracted.length / 5)} words).`);
    });

  const saveText = () =>
    run('save', async () => {
      if (!text.trim()) throw new Error('Resume text is empty.');
      await setResume({
        fileName: resume?.fileName ?? 'resume.txt',
        mimeType: resume?.mimeType ?? 'text/plain',
        text: text.trim(),
        size: resume?.size ?? 0,
        updatedAt: Date.now(),
      });
      setStatus('Resume text saved. Scores will refresh on the next job you open.');
    });

  const clear = () =>
    run('clear', async () => {
      await deleteFile(DEFAULT_RESUME_FILE);
      await setResume(null);
      setText('');
      setStatus('Resume removed.');
    });

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Default resume</h2>
        {resume ? (
          <div className="small muted">
            {resume.fileName} · updated {new Date(resume.updatedAt).toLocaleDateString()}
            {resume.size > 0 && ` · ${Math.round(resume.size / 1024)} KB original kept for uploads`}
          </div>
        ) : (
          <div className="small muted">No resume yet. Upload a PDF or paste the text below.</div>
        )}

        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.txt,.md,application/pdf,text/plain"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
            event.target.value = '';
          }}
        />

        <div className="row wrap">
          <button className="primary" disabled={pending !== null} onClick={() => fileInput.current?.click()}>
            {pending === 'upload' ? 'Reading…' : 'Upload PDF'}
          </button>
          {resume && (
            <button className="secondary" disabled={pending !== null} onClick={clear}>
              Remove
            </button>
          )}
        </div>
        <p className="small muted">
          The PDF you upload is kept locally so autofill can attach it when you have not tailored a
          version for the job.
        </p>
      </div>

      <div className="card stack">
        <h2>Resume text</h2>
        <p className="small muted">This text is what gets scored and tailored. Fix any PDF extraction glitches here.</p>
        <textarea
          value={text}
          rows={16}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          placeholder="Paste your resume text…"
        />
        <button className="primary" disabled={pending !== null} onClick={saveText}>
          {pending === 'save' ? 'Saving…' : 'Save resume text'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {status && !error && <div className="notice">{status}</div>}
    </div>
  );
}
