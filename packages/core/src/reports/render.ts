import type {
  MonthlyHighlights,
  MonthlyReportData,
  ReportCost,
  ReportGit,
  ReportQuota,
  ReportTotals,
  WeeklyReportData,
} from "./contract";
import {
  formatCount,
  formatInstant,
  formatPercent,
  formatPoints,
  formatTokensM,
  formatUsd,
} from "./format";
import { type ReportKey, type ReportLanguage, t } from "./i18n";

/**
 * Markdown rendering (L27). Pure and deterministic: the same data always produces the same bytes,
 * which is what makes regeneration idempotent. Nothing time-dependent (no "generated at") is added.
 */

const NONE: ReportKey = "value.none";

const WINDOW_KEYS: Record<ReportQuota["window"], ReportKey> = {
  five_hours: "window.five_hours",
  weekly: "window.weekly",
  monthly: "window.monthly",
};

const BASIS_KEYS: Record<string, ReportKey> = {
  "current-reference": "pricing.basis.current-reference",
  historical: "pricing.basis.historical",
};

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function money(cost: ReportCost, language: ReportLanguage): string {
  if (cost.usd === null) return t(language, NONE);
  const suffix =
    cost.unknown > 0 ? t(language, "value.unpriced", { count: formatCount(cost.unknown) }) : "";
  return `${formatUsd(cost.usd, language)}${suffix}`;
}

function summaryRows(
  totals: ReportTotals,
  previous: ReportTotals | null,
  language: ReportLanguage,
): string[][] {
  const cells = (value: (totals: ReportTotals) => string): string[] => [
    value(totals),
    previous ? value(previous) : t(language, NONE),
  ];
  const ratio = (row: ReportTotals) =>
    row.cacheHitRatio === null ? t(language, NONE) : formatPercent(row.cacheHitRatio, language);
  const issues = (row: ReportTotals) =>
    t(language, "issues.line", {
      warning: formatCount(row.issues.warning),
      error: formatCount(row.issues.error),
      critical: formatCount(row.issues.critical),
    });
  return [
    [t(language, "row.sessions"), ...cells((row) => formatCount(row.sessions))],
    [t(language, "row.turns"), ...cells((row) => formatCount(row.turns))],
    [t(language, "row.tokens"), ...cells((row) => formatTokensM(row.tokens, language))],
    [t(language, "row.computedCost"), ...cells((row) => money(row.computedCost, language))],
    [t(language, "row.reportedCost"), ...cells((row) => money(row.reportedCost, language))],
    [t(language, "row.cacheHitRatio"), ...cells(ratio)],
    [t(language, "row.issues"), ...cells(issues)],
  ];
}

function pricingLine(totals: ReportTotals, language: ReportLanguage): string {
  const basisKey = BASIS_KEYS[totals.pricing.basis];
  const basis = basisKey ? t(language, basisKey) : totals.pricing.basis;
  return totals.pricing.observedAt
    ? t(language, "pricing.withDate", { basis, date: totals.pricing.observedAt })
    : t(language, "pricing.withoutDate", { basis });
}

function summaryLines(data: WeeklyReportData, language: ReportLanguage): string[] {
  return [
    `## ${t(language, "section.summary")}`,
    "",
    ...table(
      [
        t(language, "summary.metric"),
        t(language, "summary.current"),
        t(language, "summary.previous"),
      ],
      summaryRows(data.totals, data.previous, language),
    ),
    "",
    pricingLine(data.totals, language),
    "",
  ];
}

function agentLines(data: WeeklyReportData, language: ReportLanguage): string[] {
  const lines = [`## ${t(language, "section.agents")}`, ""];
  if (data.agents.length === 0) {
    lines.push(t(language, "empty.activity"), "");
    return lines;
  }
  lines.push(
    ...table(
      [
        t(language, "agents.agent"),
        t(language, "agents.sessions"),
        t(language, "agents.turns"),
        t(language, "agents.tokens"),
        t(language, "agents.computedCost"),
      ],
      data.agents.map((agent) => [
        agent.agent,
        formatCount(agent.sessions),
        formatCount(agent.turns),
        formatTokensM(agent.tokens, language),
        agent.computedCostUsd === null
          ? t(language, NONE)
          : formatUsd(agent.computedCostUsd, language),
      ]),
    ),
    "",
  );
  return lines;
}

function dayLines(data: WeeklyReportData, language: ReportLanguage): string[] {
  if (data.days.length === 0) return [];
  return [
    `## ${t(language, "section.days")}`,
    "",
    ...table(
      [t(language, "days.day"), t(language, "row.tokens")],
      data.days.map((day) => [day.date, formatTokensM(day.tokens, language)]),
    ),
    "",
  ];
}

function quotaLines(quotas: readonly ReportQuota[], language: ReportLanguage): string[] {
  if (quotas.length === 0) return [];
  const usd = (amount: number | null) =>
    amount === null ? t(language, NONE) : formatUsd(amount, language);
  const instant = (value: string | null) =>
    value === null ? t(language, NONE) : formatInstant(value);
  return [
    `## ${t(language, "section.quotas")}`,
    "",
    ...table(
      [
        t(language, "quotas.subscription"),
        t(language, "quotas.window"),
        t(language, "quotas.used"),
        t(language, "quotas.limit"),
        t(language, "quotas.usedPct"),
        t(language, "quotas.reset"),
        t(language, "quotas.projection"),
        t(language, "quotas.deviation"),
      ],
      quotas.map((quota) => [
        quota.subscription,
        t(language, WINDOW_KEYS[quota.window]),
        usd(quota.usedUsd),
        usd(quota.limitUsd),
        quota.usedPct === null ? t(language, NONE) : formatPercent(quota.usedPct, language),
        instant(quota.resetsAt),
        instant(quota.projectedLimitAt),
        quota.deviationPct === null
          ? t(language, NONE)
          : t(language, "value.points", {
              value: formatPoints(quota.deviationPct, language),
            }),
      ]),
    ),
    "",
  ];
}

function gitLines(git: ReportGit, language: ReportLanguage): string[] {
  const tokens = (value: number) => formatTokensM(value, language);
  return [
    `## ${t(language, "section.git")}`,
    "",
    `- ${t(language, "git.attributed", { tokens: tokens(git.attributedTokens) })}`,
    `- ${t(language, "git.orphan", { tokens: tokens(git.orphanTokens) })}`,
    `- ${t(language, "git.commits", { count: formatCount(git.commits) })}`,
    `- ${t(language, "git.pullRequests", { count: formatCount(git.pullRequests) })}`,
    `- ${t(language, "git.repositories", { count: formatCount(git.repositories) })}`,
    "",
  ];
}

function highlightLines(highlights: MonthlyHighlights, language: ReportLanguage): string[] {
  const lines = [`## ${t(language, "section.highlights")}`, ""];
  if (highlights.busiestDay) {
    lines.push(
      `- ${t(language, "highlights.busiestDay", {
        day: highlights.busiestDay.date,
        tokens: formatTokensM(highlights.busiestDay.tokens, language),
      })}`,
    );
  }
  if (highlights.topAgent) {
    lines.push(
      `- ${t(language, "highlights.topAgent", {
        agent: highlights.topAgent.agent,
        tokens: formatTokensM(highlights.topAgent.tokens, language),
      })}`,
    );
  }
  if (highlights.topModel) {
    lines.push(
      `- ${t(language, "highlights.topModel", {
        model: highlights.topModel.model,
        tokens: formatTokensM(highlights.topModel.tokens, language),
      })}`,
    );
  }
  if (highlights.cacheReadShare !== null) {
    lines.push(
      `- ${t(language, "highlights.cacheReadShare", {
        share: formatPercent(highlights.cacheReadShare, language),
      })}`,
    );
  }
  if (lines.length === 2) return [];
  lines.push("");
  return lines;
}

function render(
  data: WeeklyReportData,
  language: ReportLanguage,
  title: ReportKey,
  body: string[],
): string {
  const lines = [
    `# ${t(language, title, { id: data.id })}`,
    "",
    t(language, "period", { from: data.firstDay, to: data.lastDay }),
    "",
    ...body,
  ];
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

/** The weekly report of one ISO week (S6, L27). */
export function renderWeeklyReport(data: WeeklyReportData, language: ReportLanguage): string {
  return render(data, language, "title.weekly", [
    ...summaryLines(data, language),
    ...agentLines(data, language),
    ...dayLines(data, language),
    ...quotaLines(data.quotas, language),
    ...gitLines(data.git, language),
  ]);
}

/** The monthly «wrapped» report of one calendar month (S6, L27). */
export function renderMonthlyReport(data: MonthlyReportData, language: ReportLanguage): string {
  return render(data, language, "title.monthly", [
    ...summaryLines(data, language),
    ...highlightLines(data.highlights, language),
    ...agentLines(data, language),
    ...dayLines(data, language),
    ...quotaLines(data.quotas, language),
    ...gitLines(data.git, language),
  ]);
}
