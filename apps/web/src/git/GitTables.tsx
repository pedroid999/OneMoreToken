import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Panel } from "../components/Panel";
import { formatNumber, formatTokensM, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { agentLabel, dateTimeFormat } from "../session/labels";
import { SessionLink } from "../session/SessionLink";
import type { GitCommit, GitOrphanSession, GitPullRequest } from "./contract";
import { tokensPerNetLine } from "./state";

/** Column header: translation key suffix under `git.column` and whether it is numeric. */
type Column = readonly [key: string, numeric: boolean];

function Table({
  label,
  columns,
  empty,
  children,
}: {
  label: string;
  columns: readonly Column[];
  empty: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (empty !== null) return <p className="git__muted">{empty}</p>;
  return (
    <div className="git__table-wrap">
      <table className="git__table" aria-label={label}>
        <thead>
          <tr>
            {columns.map(([key, numeric]) => (
              <th key={key} scope="col" data-numeric={numeric || undefined}>
                {t(`git.column.${key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Formatting shared by the three tables. */
function useCells(language: Language) {
  const { t } = useTranslation();
  const noCost = t("git.noCost");
  return {
    usd: (value: number | null) => (value === null ? noCost : formatUsd(value, language)),
    additions: (value: number) => t("git.additions", { value: formatNumber(value, language) }),
    deletions: (value: number) => t("git.deletions", { value: formatNumber(value, language) }),
    perNetLine: (figures: { tokens: number; additions: number; deletions: number }) => {
      const value = tokensPerNetLine(figures);
      return value === null ? t("git.notApplicable") : formatNumber(value, language);
    },
  };
}

const COMMIT_COLUMNS: readonly Column[] = [
  ["repository", false],
  ["sha", false],
  ["subject", false],
  ["date", false],
  ["additions", true],
  ["deletions", true],
  ["tokens", true],
  ["computedCost", true],
  ["reportedCost", true],
  ["sessions", true],
  ["pullRequest", true],
  ["tokensPerNetLine", true],
];

export function CommitsTable({
  commits,
  language,
}: {
  commits: readonly GitCommit[];
  language: Language;
}) {
  const { t } = useTranslation();
  const cells = useCells(language);
  const format = dateTimeFormat(language);
  const title = t("git.commits.title");
  return (
    <Panel title={title}>
      <Table
        label={title}
        columns={COMMIT_COLUMNS}
        empty={commits.length ? null : t("git.commits.empty")}
      >
        {commits.map((commit) => (
          <tr key={`${commit.repo} ${commit.sha}`}>
            <td>{commit.repo}</td>
            <th scope="row">
              <code>{commit.sha}</code>
            </th>
            <td className="git__subject">{commit.subject}</td>
            <td>
              <time dateTime={commit.authoredAt}>{format.format(new Date(commit.authoredAt))}</time>
            </td>
            <td data-numeric="true">{cells.additions(commit.additions)}</td>
            <td data-numeric="true">{cells.deletions(commit.deletions)}</td>
            <td data-numeric="true">{formatTokensM(commit.tokens, language)}</td>
            <td data-numeric="true">{cells.usd(commit.computedCostUsd)}</td>
            <td data-numeric="true">{cells.usd(commit.reportedCostUsd)}</td>
            <td data-numeric="true">{formatNumber(commit.sessions, language)}</td>
            <td data-numeric="true">
              {commit.pullRequest === null
                ? t("git.noPullRequest")
                : t("git.pullRequestNumber", { number: commit.pullRequest })}
            </td>
            <td data-numeric="true">{cells.perNetLine(commit)}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

const PR_COLUMNS: readonly Column[] = [
  ["pullRequest", false],
  ["repository", false],
  ["commits", true],
  ["additions", true],
  ["deletions", true],
  ["tokens", true],
  ["computedCost", true],
  ["reportedCost", true],
  ["tokensPerNetLine", true],
];

export function PullRequestsTable({
  pullRequests,
  language,
}: {
  pullRequests: readonly GitPullRequest[];
  language: Language;
}) {
  const { t } = useTranslation();
  const cells = useCells(language);
  const title = t("git.pullRequests.title");
  return (
    <Panel title={title}>
      <Table
        label={title}
        columns={PR_COLUMNS}
        empty={pullRequests.length ? null : t("git.pullRequests.empty")}
      >
        {pullRequests.map((pr) => (
          <tr key={`${pr.repo} ${pr.number}`}>
            <th scope="row">{t("git.pullRequestNumber", { number: pr.number })}</th>
            <td>{pr.repo}</td>
            <td data-numeric="true">{formatNumber(pr.commits, language)}</td>
            <td data-numeric="true">{cells.additions(pr.additions)}</td>
            <td data-numeric="true">{cells.deletions(pr.deletions)}</td>
            <td data-numeric="true">{formatTokensM(pr.tokens, language)}</td>
            <td data-numeric="true">{cells.usd(pr.computedCostUsd)}</td>
            <td data-numeric="true">{cells.usd(pr.reportedCostUsd)}</td>
            <td data-numeric="true">{cells.perNetLine(pr)}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

const ORPHAN_COLUMNS: readonly Column[] = [
  ["started", false],
  ["agent", false],
  ["repository", false],
  ["tokens", true],
  ["computedCost", true],
  ["reportedCost", true],
  ["hadCommits", false],
];

export function OrphansTable({
  sessions,
  language,
}: {
  sessions: readonly GitOrphanSession[];
  language: Language;
}) {
  const { t } = useTranslation();
  const cells = useCells(language);
  const format = dateTimeFormat(language);
  const title = t("git.orphans.title");
  return (
    <Panel title={title}>
      <p className="git__muted">{t("git.orphans.body")}</p>
      <Table
        label={title}
        columns={ORPHAN_COLUMNS}
        empty={sessions.length ? null : t("git.orphans.empty")}
      >
        {sessions.map((session) => (
          <tr key={session.sessionId}>
            <th scope="row">
              <SessionLink patch={{ id: session.sessionId }} className="git__link">
                <time dateTime={session.startedAt}>
                  {format.format(new Date(session.startedAt))}
                </time>
              </SessionLink>
            </th>
            <td>{agentLabel(t, session.agent)}</td>
            <td>{session.repo ?? t("git.orphans.noRepository")}</td>
            <td data-numeric="true">{formatTokensM(session.tokens, language)}</td>
            <td data-numeric="true">{cells.usd(session.computedCostUsd)}</td>
            <td data-numeric="true">{cells.usd(session.reportedCostUsd)}</td>
            <td>{session.hadCommit ? t("git.yes") : t("git.no")}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}
