import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RunEvent } from '@harness/shared';

/** Global run-status stream: keeps lists, inbox and counters live. */
export function useLiveRuns() {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource('/api/stream');
    es.addEventListener('run', (e) => {
      const { runId } = JSON.parse((e as MessageEvent).data) as { runId: string };
      void qc.invalidateQueries({ queryKey: ['run', runId] });
      clearTimeout(timer);
      timer = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['runs'] });
        void qc.invalidateQueries({ queryKey: ['approvals'] });
        void qc.invalidateQueries({ queryKey: ['stats'] });
      }, 400);
    });
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [qc]);
}

/** Live audit log for one run. */
export function useRunStream(runId: string | undefined, onEvent: (e: RunEvent) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.addEventListener('log', (e) => cb.current(JSON.parse((e as MessageEvent).data) as RunEvent));
    return () => es.close();
  }, [runId]);
}

export function useTheme(): [string, (t: string) => void] {
  const get = () => {
    try {
      return localStorage.getItem('harness-theme') ?? 'system';
    } catch {
      return 'system';
    }
  };
  const apply = (t: string) => {
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('harness-theme', t);
    } catch {
      /* storage unavailable */
    }
  };
  return [get(), apply];
}
