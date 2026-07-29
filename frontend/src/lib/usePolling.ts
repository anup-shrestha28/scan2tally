import { useEffect, useRef } from 'react';

export interface PollingContext {
  /**
   * Aborted when polling is stopped, reset, or paused because the tab is hidden.
   * Data clients do not all support request cancellation, so callers should also
   * check this before committing a response to React state.
   */
  signal: AbortSignal;
}

interface PollingOptions {
  enabled?: boolean;
  intervalMs: number;
  maxIntervalMs?: number;
  runImmediately?: boolean;
  pauseWhenHidden?: boolean;
  /** Restarts the schedule when the resource being watched changes. */
  resetKey?: string | number;
}

/**
 * Runs one poll at a time, pauses in background tabs or while offline, refreshes
 * immediately when the app is usable again, and backs off after failures.
 *
 * setTimeout is deliberately used instead of setInterval: a slow request can
 * never overlap the next request and return out of order.
 */
export function usePolling(
  poll: (context: PollingContext) => Promise<void>,
  {
    enabled = true,
    intervalMs,
    maxIntervalMs = intervalMs * 8,
    runImmediately = false,
    pauseWhenHidden = true,
    resetKey = '',
  }: PollingOptions
): void {
  const pollRef = useRef(poll);

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let inFlight = false;
    let refreshWhenReady = false;
    let failures = 0;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };

    const isPaused = () =>
      (pauseWhenHidden && document.visibilityState === 'hidden') || !navigator.onLine;

    const schedule = (delay: number) => {
      clearTimer();
      if (stopped || isPaused()) return;
      timer = window.setTimeout(run, delay);
    };

    const run = async () => {
      if (stopped || isPaused()) return;
      if (inFlight) {
        refreshWhenReady = true;
        return;
      }

      refreshWhenReady = false;
      inFlight = true;
      controller = new AbortController();
      const { signal } = controller;
      let failed = false;

      try {
        await pollRef.current({ signal });
        if (!signal.aborted) failures = 0;
      } catch {
        if (!signal.aborted) {
          failed = true;
          failures += 1;
        }
      } finally {
        inFlight = false;
        controller = undefined;

        if (!stopped && !isPaused()) {
          if (refreshWhenReady) {
            refreshWhenReady = false;
            schedule(0);
            return;
          }
          const nextDelay = failed
            ? Math.min(intervalMs * (2 ** failures), maxIntervalMs)
            : intervalMs;
          schedule(nextDelay);
        }
      }
    };

    const handleAvailabilityChange = () => {
      if (isPaused()) {
        clearTimer();
        controller?.abort();
        return;
      }

      // Returning to the tab is a strong signal that fresh data is useful now,
      // not one complete interval from now.
      failures = 0;
      clearTimer();
      refreshWhenReady = true;
      void run();
    };

    document.addEventListener('visibilitychange', handleAvailabilityChange);
    window.addEventListener('online', handleAvailabilityChange);
    window.addEventListener('offline', handleAvailabilityChange);
    schedule(runImmediately ? 0 : intervalMs);

    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener('visibilitychange', handleAvailabilityChange);
      window.removeEventListener('online', handleAvailabilityChange);
      window.removeEventListener('offline', handleAvailabilityChange);
    };
  }, [enabled, intervalMs, maxIntervalMs, pauseWhenHidden, resetKey, runImmediately]);
}
