import { useEffect, useState } from 'react';
import { setSettings } from '../lib/storage';
import { EMPTY_PROFILE, DEFAULT_SETTINGS, type Theme } from '@mapply/core/types';
import { JobPanel } from './components/JobPanel';
import { ProfileForm } from './components/ProfileForm';
import { ResumePanel } from './components/ResumePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { useAppState } from './hooks';
import { applyTheme, nextTheme, systemTheme } from './theme';

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
  const stored = state.settings?.theme ?? 'system';
  /*
   * Held locally as well as in settings so a tap paints immediately. Reading it back
   * from storage would make the toggle wait on a round trip, and a second tap during
   * that window would compute its direction from a stale value and go nowhere.
   */
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => setTheme(stored), [stored]);
  useEffect(() => {
    if (state.loaded) applyTheme(theme);
  }, [theme, state.loaded]);

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
        <div className="brand-mark" aria-hidden="true">
          {/* The same plane-leaving-a-briefcase as the toolbar icon. Monochrome on the
              accent here, so what the icon says in colour — the case sitting back, the
              fold turned away from the light — this says in opacity. The case is grouped
              so its handle and body composite once and the overlap stays invisible. */}
          <svg viewBox="0 0 24 24" fill="none">
            <g opacity="0.55">
              <path
                d="M10.6 17.4v-1.2a1.2 1.2 0 0 1 1.2-1.2h.4a1.2 1.2 0 0 1 1.2 1.2v1.2"
                stroke="#fff"
                strokeWidth="1.25"
              />
              <rect x="5.6" y="16.2" width="12.8" height="5.2" rx="1.15" fill="#fff" />
            </g>
            <path d="M20.5 2.6 2.4 6.7 8.6 8.9 7.2 12.6Z" fill="#fff" fillOpacity="0.72" />
            <path d="M20.5 2.6 2.4 6.7 8.6 8.9Z" fill="#fff" />
          </svg>
        </div>
        <div className="brand-text">
          <h1>ApplyPilot</h1>
          <span>Jobright ATS copilot</span>
        </div>
        <ThemeToggle
          theme={theme === 'system' ? systemTheme() : theme}
          onToggle={() => {
            const next = nextTheme(theme);
            setTheme(next);
            void setSettings({ ...settings, theme: next });
          }}
        />
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

/** Flips between light and dark. The icon shows where the tap will take you. */
function ThemeToggle({ theme, onToggle }: { theme: 'light' | 'dark'; onToggle: () => void }) {
  const goingDark = theme === 'light';
  const label = goingDark ? 'Switch to dark theme' : 'Switch to light theme';

  return (
    <button className="theme-toggle" onClick={onToggle} title={label} aria-label={label}>
      {goingDark ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path
            d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.5 6.5 4.9 4.9M19.1 19.1l-1.6-1.6M17.5 6.5l1.6-1.6M4.9 19.1l1.6-1.6"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
