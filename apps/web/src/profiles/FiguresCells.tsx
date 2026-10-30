import { useTranslation } from "react-i18next";
import { Estimated } from "../components/Estimated";
import { formatNumber, formatPercent, formatTokensM, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import type { ProfileFigures } from "./contract";
import { attributionOf, attributionShares } from "./state";

/** Exact share as plain text, estimated share marked as estimated (spec §6.2). */
export function AttributionText({
  figures,
  language,
}: {
  figures: ProfileFigures;
  language: Language;
}) {
  const { t } = useTranslation();
  const attribution = attributionOf(figures);
  if (attribution === "none") {
    return <span className="profiles__muted">{t("profiles.attribution.none")}</span>;
  }
  const shares = attributionShares(figures);
  return (
    <span className="profiles__attribution">
      {attribution === "estimated" ? null : (
        <span>
          {t("profiles.attribution.exactShare", { share: formatPercent(shares.exact, language) })}
        </span>
      )}
      {attribution === "exact" ? null : (
        <Estimated>{formatPercent(shares.estimated, language)}</Estimated>
      )}
    </span>
  );
}

export function costText(cost: number | null, language: Language, noCost: string): string {
  return cost === null ? noCost : formatUsd(cost, language);
}

/** Header cells matching FiguresCells. */
export function FiguresHeader() {
  const { t } = useTranslation();
  return (
    <>
      <th scope="col" data-numeric="true">
        {t("profiles.column.turns")}
      </th>
      <th scope="col" data-numeric="true">
        {t("profiles.column.tokens")}
      </th>
      <th scope="col" data-numeric="true">
        {t("profiles.column.computedCost")}
      </th>
      <th scope="col">{t("profiles.column.attribution")}</th>
    </>
  );
}

/** Turns, tokens, computed cost and attribution of one breakdown row. */
export function FiguresCells({
  figures,
  language,
}: {
  figures: ProfileFigures;
  language: Language;
}) {
  const { t } = useTranslation();
  return (
    <>
      <td data-numeric="true">{formatNumber(figures.turns, language)}</td>
      <td data-numeric="true">{formatTokensM(figures.total, language)}</td>
      <td data-numeric="true">{costText(figures.computedCost, language, t("profiles.noCost"))}</td>
      <td>
        <AttributionText figures={figures} language={language} />
      </td>
    </>
  );
}
