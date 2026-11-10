import { formatInstant, formatPercent, formatUsd } from "../reports/format";
import type { ReportLanguage } from "../reports/i18n";
import type { AlertMessage } from "./channel";
import type { AlertEvent } from "./evaluate";
import { type AlertKey, tAlert } from "./i18n";

/**
 * Renders one alert in the chosen language: subscription, window, threshold, estimated usage, cost
 * against the limit and when the window ends. Aggregates only, like the reports (spec §10).
 */
export function renderAlert(event: AlertEvent, language: ReportLanguage): AlertMessage {
  const pct = formatPercent(event.estimatedPct / 100, language);
  const limit =
    event.limitUsd === null
      ? tAlert(language, "value.unknownLimit")
      : formatUsd(event.limitUsd, language);
  const window = tAlert(language, `window.${event.windowKind}` as AlertKey);
  return {
    subject: tAlert(language, "alert.subject", {
      pct,
      subscription: event.subscriptionLabel,
    }),
    text: [
      tAlert(language, "alert.window", { window, endsAt: formatInstant(event.windowEnd) }),
      tAlert(language, "alert.usage", {
        pct,
        used: formatUsd(event.usedUsd, language),
        limit,
      }),
      tAlert(language, "alert.threshold", {
        threshold: formatPercent(event.thresholdPct / 100, language),
      }),
      tAlert(language, "alert.estimate"),
    ].join("\n"),
  };
}
