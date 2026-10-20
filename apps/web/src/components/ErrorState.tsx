import { useTranslation } from "react-i18next";
import { Button } from "./Button";

export interface ErrorStateProps {
  /** What happened and how to fix it (spec §8.4), already translated. */
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  const { t } = useTranslation();
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{t("error.title")}</p>
      <p className="state__body">{message}</p>
      {onRetry ? <Button onClick={onRetry}>{t("common.retry")}</Button> : null}
    </div>
  );
}
