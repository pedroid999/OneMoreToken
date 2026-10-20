import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  body?: string;
  /** Concrete command that fills the view (spec §8.4). */
  command?: string;
  action?: ReactNode;
}

export function EmptyState({ title, body, command, action }: EmptyStateProps) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {body ? <p className="state__body">{body}</p> : null}
      {command ? (
        <pre className="state__command">
          <span className="state__prompt" aria-hidden="true">
            {"$"}
          </span>
          <code>{command}</code>
        </pre>
      ) : null}
      {action}
    </div>
  );
}
