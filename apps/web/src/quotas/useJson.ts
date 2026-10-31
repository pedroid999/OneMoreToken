import { useCallback, useEffect, useState } from "react";

type Result<T> = { request: string; attempt: number; data?: T; failed?: boolean };

export interface JsonResource<T> {
  data: T | undefined;
  loading: boolean;
  failed: boolean;
  /** Refetches while keeping the current data on screen (after a calibration is saved). */
  reload: () => void;
}

/**
 * GET a JSON resource like useResource, but a reload of the same request keeps the last data
 * so forms and scroll position survive the refresh. Stale responses never replace newer ones.
 */
export function useJson<T>(
  request: string,
  valid: (value: unknown) => value is T,
): JsonResource<T> {
  const [result, setResult] = useState<Result<T>>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult((previous) =>
      previous?.request === request && previous.data !== undefined
        ? { request, attempt, data: previous.data }
        : { request, attempt },
    );
    void fetch(request, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        const data: unknown = await response.json();
        if (!valid(data)) throw new Error("bad shape");
        if (!controller.signal.aborted) setResult({ request, attempt, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ request, attempt, failed: true });
      });
    return () => controller.abort();
  }, [request, attempt, valid]);
  const current = result?.request === request ? result : undefined;
  const settled = current?.attempt === attempt;
  const failed = settled && current?.failed === true;
  return {
    data: current?.data,
    loading: !current?.data && !failed,
    failed,
    reload: useCallback(() => setAttempt((value) => value + 1), []),
  };
}
