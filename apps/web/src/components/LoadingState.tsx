import { useTranslation } from "react-i18next";

export function LoadingState() {
  const { t } = useTranslation();
  return (
    <p className="state state--loading" role="status">
      <span className="state__spinner" aria-hidden="true" />
      <span>{t("common.loading")}</span>
    </p>
  );
}
