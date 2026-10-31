import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { ErrorState } from "../components/ErrorState";
import { Estimated } from "../components/Estimated";
import { LoadingState } from "../components/LoadingState";
import { formatPercent } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import type { CalibrationEntry, QuotaSubscriptionReport, WindowKind } from "./contract";
import {
  CALIBRATIONS_LOCATION,
  type CalibrationDraft,
  type CalibrationErrors,
  deviationOf,
  formatPoints,
  quotaTimeFormat,
  toLocalInput,
  validateCalibration,
  windowKey,
} from "./state";

export interface CalibrationSectionProps {
  subscription: QuotaSubscriptionReport;
  /** This subscription's readings; undefined while loading. */
  entries: CalibrationEntry[] | undefined;
  entriesFailed: boolean;
  onRetryEntries: () => void;
  /** The calibrations file is corrupt or unsafe: nothing can be saved (L11). */
  invalid: boolean;
  language: Language;
  /** Refetches quotas and readings after a change. */
  onChanged: () => void;
}

type Status =
  | "idle"
  | "saving"
  | "saved"
  | "deleted"
  | "rejected"
  | "storage"
  | "failed"
  | "deleteError";

const SAVE_ERRORS: Partial<Record<Status, string>> = {
  rejected: "burnRate.calibration.errors.rejected",
  storage: "burnRate.calibration.errors.storage",
  failed: "burnRate.calibration.errors.failed",
  deleteError: "burnRate.readings.deleteError",
};

/** Manual readings of the provider console % and the historical deviation (spec §5.3, S4). */
export function CalibrationSection(props: CalibrationSectionProps) {
  const { subscription, entries, entriesFailed, onRetryEntries, invalid, language, onChanged } =
    props;
  const { t } = useTranslation();
  const titleId = useId();
  const fieldId = useId();
  const kinds: WindowKind[] = subscription.windows.map((report) => report.kind);
  const [draft, setDraft] = useState<CalibrationDraft>(() => ({
    windowKind: kinds[0] ?? "",
    observedPct: "",
    observedAt: toLocalInput(Date.now()),
    note: "",
  }));
  const [errors, setErrors] = useState<CalibrationErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const format = quotaTimeFormat(language);
  const windowName = (kind: WindowKind) => t(`quota.window.${windowKey(kind)}`);
  const predictions = new Map(
    subscription.windows.flatMap((report) =>
      report.calibration.readings.map((reading) => [reading.id, reading] as const),
    ),
  );
  const readings = [...(entries ?? [])].sort(
    (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id),
  );

  const update = (field: keyof CalibrationDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const { [field]: _removed, ...rest } = current;
      return rest;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid || status === "saving") return;
    const result = validateCalibration(draft, {
      subscriptionId: subscription.id,
      kinds,
      now: Date.now(),
    });
    if (!result.ok) {
      setErrors(result.errors);
      setStatus("idle");
      return;
    }
    setStatus("saving");
    void fetch("/api/calibrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result.input),
    })
      .then((response) => {
        if (response.status === 400) return setStatus("rejected");
        if (response.status === 409) return setStatus("storage");
        if (!response.ok) return setStatus("failed");
        setDraft((current) => ({
          ...current,
          observedPct: "",
          note: "",
          observedAt: toLocalInput(Date.now()),
        }));
        setStatus("saved");
        onChanged();
      })
      .catch(() => setStatus("failed"));
  };

  const remove = (entry: CalibrationEntry) => {
    setStatus("idle");
    void fetch(`/api/calibrations/${encodeURIComponent(entry.id)}`, { method: "DELETE" })
      .then((response) => {
        if (!response.ok) throw new Error("delete failed");
        setStatus("deleted");
        onChanged();
      })
      .catch(() => setStatus("deleteError"));
  };

  const field = (name: keyof CalibrationDraft) => ({
    id: `${fieldId}-${name}`,
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? `${fieldId}-${name}-error` : undefined,
  });
  const fieldError = (name: keyof CalibrationDraft) =>
    errors[name] ? (
      <span className="quota__field-error" id={`${fieldId}-${name}-error`}>
        {t(errors[name])}
      </span>
    ) : null;
  const saveError = SAVE_ERRORS[status];

  return (
    <section className="quota__section" aria-labelledby={titleId}>
      <h3 className="quota__subtitle" id={titleId}>
        {t("burnRate.calibration.title")}
      </h3>
      <p className="quota__muted">{t("burnRate.calibration.intro")}</p>
      {invalid ? (
        <ErrorState
          message={t("burnRate.calibration.invalid", { path: CALIBRATIONS_LOCATION })}
          onRetry={onChanged}
        />
      ) : null}

      <h4 className="quota__subtitle">{t("burnRate.deviation.title")}</h4>
      <ul className="quota__list">
        {subscription.windows.map((report) => {
          const deviation = deviationOf(report);
          return (
            <li key={report.kind}>
              {deviation.kind === "ready" ? (
                <Estimated>
                  {t("burnRate.deviation.line", {
                    window: windowName(report.kind),
                    text: t("burnRate.deviation.mean", {
                      value: t("burnRate.pp", { value: formatPoints(deviation.meanPct, language) }),
                    }),
                  })}
                </Estimated>
              ) : (
                <span className="quota__muted">
                  {t("burnRate.deviation.line", {
                    window: windowName(report.kind),
                    text: t("burnRate.deviation.needsMore"),
                  })}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <form
        className="quota__form"
        aria-label={t("burnRate.calibration.title")}
        onSubmit={submit}
        noValidate
      >
        <div className="quota__field">
          <label className="quota__label" htmlFor={`${fieldId}-windowKind`}>
            {t("burnRate.calibration.windowKind")}
          </label>
          <select
            {...field("windowKind")}
            className="quota__input"
            value={draft.windowKind}
            onChange={(event) => update("windowKind", event.target.value)}
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {windowName(kind)}
              </option>
            ))}
          </select>
          {fieldError("windowKind")}
        </div>
        <div className="quota__field">
          <label className="quota__label" htmlFor={`${fieldId}-observedPct`}>
            {t("burnRate.calibration.observedPct")}
          </label>
          <input
            {...field("observedPct")}
            type="text"
            inputMode="decimal"
            className="quota__input"
            value={draft.observedPct}
            onChange={(event) => update("observedPct", event.target.value)}
          />
          {fieldError("observedPct")}
        </div>
        <div className="quota__field">
          <label className="quota__label" htmlFor={`${fieldId}-observedAt`}>
            {t("burnRate.calibration.observedAt")}
          </label>
          <input
            {...field("observedAt")}
            type="datetime-local"
            className="quota__input"
            value={draft.observedAt}
            onChange={(event) => update("observedAt", event.target.value)}
          />
          {fieldError("observedAt")}
        </div>
        <div className="quota__field quota__field--grow">
          <label className="quota__label" htmlFor={`${fieldId}-note`}>
            {t("burnRate.calibration.note")}
          </label>
          <input
            {...field("note")}
            type="text"
            className="quota__input"
            value={draft.note}
            onChange={(event) => update("note", event.target.value)}
          />
          {fieldError("note")}
        </div>
        <Button type="submit" variant="primary" loading={status === "saving"} disabled={invalid}>
          {t("burnRate.calibration.submit")}
        </Button>
        {saveError && status !== "deleteError" ? (
          <p className="quota__warning" role="alert">
            {t(saveError, { path: CALIBRATIONS_LOCATION })}
          </p>
        ) : null}
      </form>
      {status === "saved" || status === "deleted" ? (
        <p className="quota__success" role="status">
          {t(status === "saved" ? "burnRate.calibration.saved" : "burnRate.calibration.deleted")}
        </p>
      ) : null}
      {status === "deleteError" ? (
        <p className="quota__warning" role="alert">
          {t("burnRate.readings.deleteError")}
        </p>
      ) : null}

      <h4 className="quota__subtitle">{t("burnRate.readings.title")}</h4>
      {invalid ? null : entriesFailed ? (
        <ErrorState message={t("burnRate.readings.error")} onRetry={onRetryEntries} />
      ) : !entries ? (
        <LoadingState />
      ) : readings.length === 0 ? (
        <p className="quota__muted">{t("burnRate.readings.empty")}</p>
      ) : (
        <div className="quota__table-wrap">
          <table className="quota__table" aria-label={t("burnRate.readings.title")}>
            <thead>
              <tr>
                <th scope="col">{t("burnRate.readings.window")}</th>
                <th scope="col">{t("burnRate.readings.observedAt")}</th>
                <th scope="col" data-numeric="true">
                  {t("burnRate.readings.observed")}
                </th>
                <th scope="col" data-numeric="true">
                  {t("burnRate.readings.predicted")}
                </th>
                <th scope="col" data-numeric="true">
                  {t("burnRate.readings.delta")}
                </th>
                <th scope="col">{t("burnRate.readings.note")}</th>
                <th scope="col">{t("burnRate.readings.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {readings.map((entry) => {
                const prediction = predictions.get(entry.id);
                const time = format.format(new Date(entry.observedAt));
                return (
                  <tr key={entry.id}>
                    <td>{windowName(entry.windowKind)}</td>
                    <td>
                      <time dateTime={entry.observedAt}>{time}</time>
                    </td>
                    <td data-numeric="true">{formatPercent(entry.observedPct / 100, language)}</td>
                    <td data-numeric="true">
                      {prediction?.predictedPct == null ? (
                        <span className="quota__muted">{t("session.noValue")}</span>
                      ) : (
                        <Estimated>
                          {formatPercent(prediction.predictedPct / 100, language)}
                        </Estimated>
                      )}
                    </td>
                    <td data-numeric="true">
                      {prediction?.deltaPct == null ? (
                        <span className="quota__muted">{t("session.noValue")}</span>
                      ) : (
                        <Estimated>
                          {t("burnRate.pp", {
                            value: formatPoints(prediction.deltaPct, language, true),
                          })}
                        </Estimated>
                      )}
                    </td>
                    <td>{entry.note ?? t("session.noValue")}</td>
                    <td>
                      <Button
                        variant="danger"
                        aria-label={t("burnRate.readings.deleteNamed", {
                          window: windowName(entry.windowKind),
                          time,
                        })}
                        onClick={() => remove(entry)}
                      >
                        {t("burnRate.readings.delete")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
