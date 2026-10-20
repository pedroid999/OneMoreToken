import { useTranslation } from "react-i18next";
import { EmptyState } from "../components/EmptyState";
import type { Route } from "../router";

export function UpcomingView({ route }: { route: Route }) {
  const { t } = useTranslation();
  return (
    <>
      <h1 className="view__title">{t(route.labelKey)}</h1>
      <EmptyState
        title={t("view.upcoming", { phase: route.phase })}
        body={t("view.upcomingHint")}
      />
    </>
  );
}
