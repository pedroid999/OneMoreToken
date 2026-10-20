import { useTranslation } from "react-i18next";
import { EmptyState } from "../components/EmptyState";
import { Panel } from "../components/Panel";

export function SummaryView() {
  const { t } = useTranslation();
  return (
    <>
      <h1 className="view__title">{t("summary.title")}</h1>
      <Panel
        title={t("session.count", { count: 0 })}
        status="empty"
        empty={
          <EmptyState
            title={t("summary.empty.title")}
            body={t("summary.empty.body")}
            command={t("summary.empty.command")}
          />
        }
      />
    </>
  );
}
