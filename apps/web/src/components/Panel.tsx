import { type ReactNode, useId } from "react";
import { ErrorState, type ErrorStateProps } from "./ErrorState";
import { LoadingState } from "./LoadingState";

export type PanelStatus = "ready" | "loading" | "empty" | "error";

export interface PanelProps {
  title: string;
  status?: PanelStatus;
  /** Rendered when status is "empty", usually an EmptyState. */
  empty?: ReactNode;
  error?: ErrorStateProps;
  actions?: ReactNode;
  children?: ReactNode;
}

/** Bordered region with a title rule, in the spirit of a Zellij pane (spec §8.2). */
export function Panel({ title, status = "ready", empty, error, actions, children }: PanelProps) {
  const titleId = useId();
  let body: ReactNode = children;
  if (status === "loading") body = <LoadingState />;
  else if (status === "empty") body = empty;
  else if (status === "error" && error) body = <ErrorState {...error} />;
  return (
    <section
      className="panel"
      aria-labelledby={titleId}
      aria-busy={status === "loading" || undefined}
      data-status={status}
    >
      <header className="panel__header">
        <h2 className="panel__title" id={titleId}>
          {title}
        </h2>
        {actions ? <div className="panel__actions">{actions}</div> : null}
      </header>
      <div className="panel__body">{body}</div>
    </section>
  );
}
