import { useTranslation } from "react-i18next";
import type { SessionCommit } from "../../../cli/src/sessions/contract";
import { Panel } from "../components/Panel";
import { formatNumber, formatTokensM } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { dateTimeFormat } from "./labels";

const COLUMNS = [
  ["repository", false],
  ["sha", false],
  ["subject", false],
  ["date", false],
  ["additions", true],
  ["deletions", true],
  ["tokens", true],
] as const;

/** Commits the session's turns are attributed to, with their +/− line counts (spec §7.1, L20). */
export function SessionCommits({
  commits,
  language,
}: {
  commits: readonly SessionCommit[];
  language: Language;
}) {
  const { t } = useTranslation();
  const format = dateTimeFormat(language);
  const title = t("session.commits.title");
  return (
    <Panel title={title}>
      {commits.length ? (
        <>
          <div className="session__table-wrap">
            <table className="session__table" aria-label={title}>
              <thead>
                <tr>
                  {COLUMNS.map(([key, numeric]) => (
                    <th key={key} scope="col" data-numeric={numeric || undefined}>
                      {t(`git.column.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {commits.map((commit) => (
                  <tr key={`${commit.repo} ${commit.sha}`}>
                    <td>{commit.repo}</td>
                    <th scope="row">
                      <code>{commit.sha}</code>
                    </th>
                    <td>{commit.subject}</td>
                    <td>
                      <time dateTime={commit.authoredAt}>
                        {format.format(new Date(commit.authoredAt))}
                      </time>
                    </td>
                    <td data-numeric="true">
                      {t("git.additions", { value: formatNumber(commit.additions, language) })}
                    </td>
                    <td data-numeric="true">
                      {t("git.deletions", { value: formatNumber(commit.deletions, language) })}
                    </td>
                    <td data-numeric="true">{formatTokensM(commit.tokens, language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="session__muted">{t("session.commits.note")}</p>
        </>
      ) : (
        <p className="session__muted">{t("session.commits.empty")}</p>
      )}
    </Panel>
  );
}
