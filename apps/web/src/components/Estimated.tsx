import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** A quota figure visibly marked as estimated (spec §5.3: every window figure is an estimate). */
export function Estimated({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className="estimated" data-estimated="true">
      <span className="estimated__value">{children}</span>{" "}
      <span className="estimated__tag">{t("quota.estimated")}</span>
    </span>
  );
}
