import { useEffect, useRef, useState } from 'react';
import { STARTER_QUESTIONS } from '@mapply/core/jobChat';
import type { ChatTurn, JobRecord, ResumeDoc, Settings } from '@mapply/core/types';
import { sendMessage } from '../../lib/messages';
import { useAction } from '../hooks';

interface ChatPanelProps {
  record: JobRecord | null;
  resume: ResumeDoc | null;
  settings: Settings;
  onGoToSettings: () => void;
  onGoToResume: () => void;
}

/**
 * Questions about the open posting.
 *
 * Deliberately tied to one job. The conversation is stored on that job's record,
 * so closing the panel and coming back keeps the thread, and opening a different
 * posting starts a different one - asking "how do I match?" against whichever
 * job happened to be open last is worse than not answering.
 */
export function ChatPanel({ record, resume, settings, onGoToSettings, onGoToResume }: ChatPanelProps) {
  const { pending, error, run, setError } = useAction();
  const [question, setQuestion] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const turns: ChatTurn[] = record?.chat ?? [];

  // Follow the conversation as it grows, but not on first paint - landing
  // mid-thread on a job you have just opened is disorienting.
  const count = turns.length;
  const seen = useRef(count);
  useEffect(() => {
    if (count > seen.current) bottom.current?.scrollIntoView({ behavior: 'smooth' });
    seen.current = count;
  }, [count]);

  if (!settings.openaiApiKey) {
    return (
      <div className="card stack">
        <h2>Ask about this job</h2>
        <p className="small muted">
          Answering questions needs your OpenAI key, the same one used for scoring.
        </p>
        <button className="secondary" onClick={onGoToSettings}>
          Open settings
        </button>
      </div>
    );
  }

  if (!resume?.text) {
    return (
      <div className="card stack">
        <h2>Ask about this job</h2>
        <p className="small muted">
          Add your resume first — most of what is worth asking here is how this job compares with it.
        </p>
        <button className="secondary" onClick={onGoToResume}>
          Add a resume
        </button>
      </div>
    );
  }

  if (!record) {
    return (
      <div className="card">
        <p className="small muted" style={{ margin: 0 }}>
          Open a job on Jobright and it can be asked about here.
        </p>
      </div>
    );
  }

  const ask = (text: string) => {
    const asked = text.trim();
    if (!asked || pending) return;

    setQuestion('');
    void run('ask', async () => {
      const response = await sendMessage<{ ok: boolean; error?: string }>({
        type: 'REQUEST_CHAT',
        jobKey: record.job.jobKey,
        question: asked,
      });
      if (!response.ok) {
        // Put it back rather than lose it: retyping a question the tool failed
        // to answer is a small insult on top of the failure.
        setQuestion(asked);
        throw new Error(response.error ?? 'Could not answer that.');
      }
    });
  };

  const clear = () =>
    void run('clear', async () => {
      await sendMessage({ type: 'CLEAR_CHAT', jobKey: record.job.jobKey });
    });

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>Ask about this job</h2>
          {turns.length > 0 && (
            <button className="ghost" disabled={pending !== null} onClick={clear}>
              Clear
            </button>
          )}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {record.job.title} — {record.job.company}. Answers come from this posting and your resume;
          where the posting is silent it will say so rather than guess.
        </p>
      </div>

      {turns.length === 0 && (
        <div className="card stack">
          <p className="small muted" style={{ margin: 0 }}>Try one of these, or ask your own.</p>
          <div className="stack" style={{ gap: 6 }}>
            {STARTER_QUESTIONS.map((starter) => (
              <button
                key={starter}
                className="ghost"
                style={{ textAlign: 'left' }}
                disabled={pending !== null}
                onClick={() => ask(starter)}
              >
                {starter}
              </button>
            ))}
          </div>
        </div>
      )}

      {turns.map((turn) => (
        <div
          key={`${turn.at}-${turn.role}`}
          className="card"
          style={turn.role === 'you' ? { background: 'var(--surface-2, transparent)' } : undefined}
        >
          <div className="small muted" style={{ marginBottom: 6 }}>
            {turn.role === 'you' ? 'You' : 'ApplyPilot'}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{turn.text}</div>
        </div>
      ))}

      {pending === 'ask' && (
        <div className="card small muted">Reading the posting…</div>
      )}
      {error && <div className="error">{error}</div>}
      <div ref={bottom} />

      <div className="card stack">
        <textarea
          rows={3}
          value={question}
          placeholder="Ask anything about this role…"
          disabled={pending !== null}
          onChange={(event) => {
            setQuestion(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line. These questions are one
            // or two lines; needing a mouse for every one of them would grate.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              ask(question);
            }
          }}
        />
        <button className="primary" disabled={pending !== null || !question.trim()} onClick={() => ask(question)}>
          {pending === 'ask' ? 'Thinking…' : 'Ask'}
        </button>
      </div>
    </div>
  );
}
