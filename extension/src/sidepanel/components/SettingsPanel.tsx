import { useEffect, useState } from 'react';
import { TEMPLATES } from '../../lib/resumePdf';
import { chooseSaveDirectory, clearSaveDirectory, supportsFolderPicker } from '../../lib/saveLocation';
import { setSettings } from '../../lib/storage';
import type { ResumeTemplate, Settings } from '../../lib/types';
import { useAction } from '../hooks';

const MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];

export function SettingsPanel({ settings }: { settings: Settings }) {
  const { pending, error, run } = useAction();
  const [draft, setDraft] = useState<Settings>(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const update = (patch: Partial<Settings>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
  };

  /**
   * The folder grant lands in IndexedDB the moment it is given, so its name has to
   * persist with it rather than waiting for "Save settings" and drifting apart.
   */
  const applyDirectory = async (name: string) => {
    const next = { ...draft, saveDirectoryName: name };
    setDraft(next);
    await setSettings(next);
  };

  const pickFolder = () =>
    void run('folder', async () => {
      const name = await chooseSaveDirectory();
      if (name !== null) await applyDirectory(name);
    });

  const useDownloads = () =>
    void run('folder', async () => {
      await clearSaveDirectory();
      await applyDirectory('');
    });

  return (
    <div className="stack">
      <div className="card stack">
        <h2>OpenAI</h2>
        <div>
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            type="password"
            value={draft.openaiApiKey}
            placeholder="sk-…"
            onChange={(event) => update({ openaiApiKey: event.target.value })}
          />
        </div>
        <p className="small muted">
          Stored locally in this browser profile and sent only to api.openai.com. Create one at
          platform.openai.com/api-keys.
        </p>

        <div className="grid2">
          <div>
            <label htmlFor="score-model">Scoring model</label>
            <select
              id="score-model"
              value={draft.scoreModel}
              onChange={(event) => update({ scoreModel: event.target.value })}
            >
              {MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="tailor-model">Tailoring model</label>
            <select
              id="tailor-model"
              value={draft.tailorModel}
              onChange={(event) => update({ tailorModel: event.target.value })}
            >
              {MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="row" style={{ gap: 6, marginTop: 4 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={draft.autoScore}
            onChange={(event) => update({ autoScore: event.target.checked })}
          />
          <span>Score automatically when I open a job on Jobright</span>
        </label>
      </div>

      <div className="card stack">
        <h2>Resume template</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Used for the tailored PDF you download and the file autofill attaches.
        </p>
        <div className="template-picker">
          {(Object.keys(TEMPLATES) as ResumeTemplate[]).map((key) => (
            <button
              type="button"
              key={key}
              className={`template-option ${draft.resumeTemplate === key ? 'selected' : ''}`}
              onClick={() => update({ resumeTemplate: key })}
            >
              <strong>{TEMPLATES[key].label}</strong>
              <span>{TEMPLATES[key].description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card stack">
        <h2>Where saved resumes go</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Each PDF is filed as <strong>resumes / company / job title / your name.pdf</strong>.
        </p>
        <div className="notice">
          {draft.saveDirectoryName
            ? `${draft.saveDirectoryName} / resumes / …`
            : 'Downloads / resumes / …'}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          On its own an extension can only write inside your Downloads folder. Pick a folder —
          Documents, for instance — to let ApplyPilot file resumes there instead. Chrome remembers
          the choice and may ask you to confirm it again after a restart.
        </p>
        {supportsFolderPicker() ? (
          <div className="row wrap">
            <button className="secondary" disabled={pending !== null} onClick={pickFolder}>
              {pending === 'folder' ? 'Waiting…' : 'Choose folder…'}
            </button>
            {draft.saveDirectoryName && (
              <button className="ghost" disabled={pending !== null} onClick={useDownloads}>
                Use Downloads instead
              </button>
            )}
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            This Chrome build cannot pick a folder, so resumes go to your Downloads folder.
          </p>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {saved && !error && <div className="notice">Settings saved.</div>}

      <button
        className="primary"
        disabled={pending !== null}
        onClick={() =>
          void run('save', async () => {
            await setSettings(draft);
            setSaved(true);
          })
        }
      >
        {pending === 'save' ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  );
}
