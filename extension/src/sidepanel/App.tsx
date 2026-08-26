import { useState } from 'react';
import { EMPTY_PROFILE, DEFAULT_SETTINGS } from '../lib/types';
import { JobPanel } from './components/JobPanel';
import { ProfileForm } from './components/ProfileForm';
import { ResumePanel } from './components/ResumePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { useAppState } from './hooks';

type Tab = 'job' | 'resume' | 'profile' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'job', label: 'Job' },
  { id: 'resume', label: 'Resume' },
  { id: 'profile', label: 'Profile' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const state = useAppState();
  const [tab, setTab] = useState<Tab>('job');

  if (!state.loaded) {
    return (
      <main>
        <div className="muted">Loading…</div>
      </main>
    );
  }

  const settings = state.settings ?? DEFAULT_SETTINGS;
  const profile = state.profile ?? EMPTY_PROFILE;

  return (
    <>
      <header>
        <h1>ApplyPilot</h1>
        <span className="small muted">Jobright ATS copilot</span>
      </header>

      <nav>
        {TABS.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'job' && (
          <JobPanel
            record={state.activeJob}
            profile={profile}
            resume={state.resume}
            settings={settings}
            onGoToSettings={() => setTab('settings')}
            onGoToResume={() => setTab('resume')}
          />
        )}
        {tab === 'resume' && <ResumePanel resume={state.resume} />}
        {tab === 'profile' && <ProfileForm profile={profile} />}
        {tab === 'settings' && <SettingsPanel settings={settings} />}
      </main>
    </>
  );
}
