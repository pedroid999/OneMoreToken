import type { Database } from "@omt/core";
import { type AlertPassResult, type AlertsOptions, runAlertPass } from "./service";

export interface AlertSchedulerOptions extends AlertsOptions {
  /** Milliseconds between passes; 0 keeps the startup pass and disables the timer. */
  intervalMs: number;
  /** A failed pass is reported here and never stops the server or the timer (L34). */
  onError?: (error: unknown) => void;
}

export interface AlertScheduler {
  /** One pass now; concurrent calls are ignored while a pass is in flight. */
  runOnce(): Promise<AlertPassResult>;
  /** Clears the timer and waits for the pass in flight, so the database can close safely. */
  stop(): Promise<void>;
}

/**
 * Runs one alert pass at startup and then one per interval, inside the single DuckDB writer. The
 * timer is unref'd so an alert pass never keeps the process alive on shutdown.
 */
export function startAlertScheduler(db: Database, options: AlertSchedulerOptions): AlertScheduler {
  let running: Promise<AlertPassResult> | null = null;
  let timer: NodeJS.Timeout | undefined;

  const runOnce = (): Promise<AlertPassResult> => {
    if (running) return running;
    const pass = runAlertPass(db, options).finally(() => {
      running = null;
    });
    running = pass;
    return pass;
  };

  // A failed pass is reported and never breaks `omt serve`; this covers startup and every interval.
  const pass = () => {
    runOnce().catch((error: unknown) => options.onError?.(error));
  };

  pass();

  if (options.intervalMs > 0) {
    timer = setInterval(pass, options.intervalMs);
    timer.unref();
  }

  return {
    runOnce,
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      const inFlight = running;
      if (inFlight) await inFlight.catch(() => {});
    },
  };
}
