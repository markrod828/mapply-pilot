import { useCallback, useEffect, useState } from 'react';
import {
  getActiveJob,
  getProfile,
  getResume,
  getSettings,
  onStorageChanged,
} from '../lib/storage';
import type { JobRecord, Profile, ResumeDoc, Settings } from '../lib/types';

export interface AppState {
  settings: Settings | null;
  profile: Profile | null;
  resume: ResumeDoc | null;
  activeJob: JobRecord | null;
  loaded: boolean;
}

export function useAppState(): AppState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<AppState>({
    settings: null,
    profile: null,
    resume: null,
    activeJob: null,
    loaded: false,
  });

  const refresh = useCallback(async () => {
    const [settings, profile, resume, activeJob] = await Promise.all([
      getSettings(),
      getProfile(),
      getResume(),
      getActiveJob(),
    ]);
    setState({ settings, profile, resume, activeJob, loaded: true });
  }, []);

  useEffect(() => {
    void refresh();
    return onStorageChanged(() => {
      void refresh();
    });
  }, [refresh]);

  return { ...state, refresh };
}

/** Wraps an async action with pending state and a surfaced error message. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    setPending(name);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPending(null);
    }
  }, []);

  return { pending, error, run, setError };
}
