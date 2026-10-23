import { useEffect, useState } from "react";

type Result<T> = {
  request: string;
  attempt: number;
  data?: T;
  failed?: boolean;
  notFound?: boolean;
};

export interface Resource<T> {
  data: T | undefined;
  loading: boolean;
  failed: boolean;
  notFound: boolean;
  retry: () => void;
}

/** GET a JSON resource, like SummaryView: stale responses never replace the current request. */
export function useResource<T>(
  request: string | null,
  valid: (value: unknown) => value is T,
): Resource<T> {
  const [result, setResult] = useState<Result<T>>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setResult({ request, attempt });
    void fetch(request, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) {
          if (!controller.signal.aborted) setResult({ request, attempt, notFound: true });
          return;
        }
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
  const current = result?.request === request && result.attempt === attempt ? result : undefined;
  const failed = current?.failed === true;
  const notFound = current?.notFound === true;
  return {
    data: current?.data,
    loading: request !== null && !current?.data && !failed && !notFound,
    failed,
    notFound,
    retry: () => setAttempt((value) => value + 1),
  };
}
