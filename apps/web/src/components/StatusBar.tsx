import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface StatusBarProps {
  /** Ordered segments; the first one is highlighted like a Zellij mode indicator. */
  segments: Array<{ id: string; content: ReactNode }>;
}

export function StatusBar({ segments }: StatusBarProps) {
  const { t } = useTranslation();
  return (
    <footer className="status-bar">
      <ul className="status-bar__list" aria-label={t("status.label")}>
        {segments.map((segment) => (
          <li key={segment.id} className="status-bar__segment" data-segment={segment.id}>
            {segment.content}
          </li>
        ))}
      </ul>
    </footer>
  );
}
