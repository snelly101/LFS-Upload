import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, ApiError } from '../api';
import type { AuthOptions, MeResponse } from '../lib/types';
import { setTimeZone } from '../lib/time';
import { StepUpDialog } from '../components/StepUpDialog';

interface AuthValue {
  me: MeResponse | undefined;
  loading: boolean;
  options: AuthOptions | undefined;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** Runs fn; if the server demands recent authentication, prompts for step-up and retries once. */
  withStepUp: <T>(fn: () => Promise<T>) => Promise<T>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQ = useQuery({ queryKey: ['me'], queryFn: () => get<MeResponse>('/api/auth/me') });
  const optQ = useQuery({ queryKey: ['auth-options'], queryFn: () => get<AuthOptions>('/api/auth/options'), staleTime: 60_000 });
  const [stepUp, setStepUp] = useState<{ resolve: (ok: boolean) => void } | null>(null);

  useEffect(() => {
    if (meQ.data?.user?.timeZone) setTimeZone(meQ.data.user.timeZone);
  }, [meQ.data?.user?.timeZone]);
  useEffect(() => {
    const o = optQ.data;
    if (!o) return;
    document.documentElement.style.setProperty('--accent', o.accentColour);
    document.title = o.productName;
  }, [optQ.data]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);
  const logout = useCallback(async () => {
    await post('/api/auth/logout');
    qc.clear();
    window.location.href = '/login';
  }, [qc]);
  const withStepUp = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401 && e.code === 'recent_auth_required') {
          const ok = await new Promise<boolean>((resolve) => setStepUp({ resolve }));
          setStepUp(null);
          if (!ok) throw e;
          await refresh();
          return await fn();
        }
        throw e;
      }
    },
    [refresh],
  );

  const value = useMemo<AuthValue>(
    () => ({ me: meQ.data, loading: meQ.isLoading, options: optQ.data, refresh, logout, withStepUp }),
    [meQ.data, meQ.isLoading, optQ.data, refresh, logout, withStepUp],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {stepUp && <StepUpDialog mfa={meQ.data?.mfa} onDone={(ok) => stepUp.resolve(ok)} />}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}
