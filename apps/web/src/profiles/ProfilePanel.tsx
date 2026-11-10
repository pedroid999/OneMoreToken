import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { Panel } from "../components/Panel";
import { TableExport } from "../export/TableExport";
import type { Language } from "../i18n/i18n";
import { agentLabel, dateTimeFormat } from "../session/labels";
import { SessionLink } from "../session/SessionLink";
import type { ProfileReport } from "./contract";
import { AttributionText, FiguresCells, FiguresHeader } from "./FiguresCells";
import { effortGroups, figuresCsv, roleCategory, shortHash, sortedRoles } from "./state";

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="profiles__section" aria-labelledby={id}>
      <div className="profiles__section-header">
        <h3 className="profiles__subtitle" id={id}>
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Table({ label, head, children }: { label: string; head: ReactNode; children: ReactNode }) {
  return (
    <div className="profiles__table-wrap">
      <table className="profiles__table" aria-label={label}>
        <thead>
          <tr>{head}</tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

/** One profile: versions, roles, effort, subscriptions drained and sessions (spec §6.1, §6.2). */
export function ProfilePanel({
  profile,
  language,
  slug,
}: {
  profile: ProfileReport;
  language: Language;
  slug: string;
}) {
  const { t } = useTranslation();
  const format = dateTimeFormat(language);
  const figuresColumns = [
    t("profiles.column.turns"),
    t("profiles.column.tokens"),
    t("profiles.column.computedCost"),
    t("profiles.column.attribution"),
  ];
  const file = (section: string) => `profiles-${profile.name}-${section}-${slug}`;

  return (
    <Panel title={profile.name}>
      <p className="profiles__muted">
        <AttributionText figures={profile.totals} language={language} />
      </p>
      <Section title={t("profiles.versions.title")}>
        <ul className="profiles__list" aria-label={t("profiles.versions.title")}>
          {profile.versions.map((version) => (
            <li key={version.hash}>
              <code>{shortHash(version.hash)}</code>{" "}
              <span className="profiles__muted">
                {t("profiles.versions.item", {
                  date: version.firstSeenAt ? format.format(new Date(version.firstSeenAt)) : "",
                })}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title={t("profiles.roles.title")}
        actions={
          <TableExport
            name={t("profiles.roles.title")}
            filename={file("roles")}
            columns={[t("profiles.roles.role"), t("profiles.roles.agent"), ...figuresColumns]}
            rows={sortedRoles(profile.roles).map((row) => [
              roleCategory(row.role),
              row.role,
              ...figuresCsv(row),
            ])}
          />
        }
      >
        <Table
          label={t("profiles.roles.title")}
          head={
            <>
              <th scope="col">{t("profiles.roles.role")}</th>
              <th scope="col">{t("profiles.roles.agent")}</th>
              <FiguresHeader />
            </>
          }
        >
          <tbody>
            {sortedRoles(profile.roles).map((row) => {
              const category = roleCategory(row.role);
              const stored = row.role !== null && row.role !== category;
              return (
                <tr key={row.role ?? ""} data-role={category}>
                  <th scope="row">{t(`profiles.roles.category.${category}`)}</th>
                  <td>{stored ? <code>{row.role}</code> : null}</td>
                  <FiguresCells figures={row} language={language} />
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Section>
      <Section
        title={t("profiles.efforts.title")}
        actions={
          <TableExport
            name={t("profiles.efforts.title")}
            filename={file("efforts")}
            columns={[t("profiles.efforts.model"), t("profiles.efforts.effort"), ...figuresColumns]}
            rows={effortGroups(profile.efforts).flatMap((group) => {
              const model = [group.provider, group.model].filter(Boolean).join("/");
              return group.rows.map((row) => [model, row.effort, ...figuresCsv(row)]);
            })}
          />
        }
      >
        <Table
          label={t("profiles.efforts.title")}
          head={
            <>
              <th scope="col">{t("profiles.efforts.model")}</th>
              <th scope="col">{t("profiles.efforts.effort")}</th>
              <FiguresHeader />
            </>
          }
        >
          {effortGroups(profile.efforts).map((group) => {
            const model = [group.provider, group.model].filter(Boolean).join("/");
            return (
              <tbody key={model} data-compared={group.compared || undefined}>
                {group.rows.map((row, index) => (
                  <tr key={row.effort ?? ""}>
                    {index === 0 ? (
                      <th scope="rowgroup" rowSpan={group.rows.length}>
                        <span>{model || t("profiles.unknown")}</span>
                        {group.compared ? (
                          <span className="profiles__note">{t("profiles.efforts.compared")}</span>
                        ) : null}
                      </th>
                    ) : null}
                    <td>{row.effort ?? t("profiles.efforts.none")}</td>
                    <FiguresCells figures={row} language={language} />
                  </tr>
                ))}
              </tbody>
            );
          })}
        </Table>
      </Section>
      <Section
        title={t("profiles.subscriptions.title")}
        actions={
          <TableExport
            name={t("profiles.subscriptions.title")}
            filename={file("subscriptions")}
            columns={[t("profiles.subscriptions.subscription"), ...figuresColumns]}
            rows={profile.subscriptions.map((row) => [
              row.subscriptionId === null
                ? t("profiles.subscriptions.payAsYouGo")
                : row.subscriptionId,
              ...figuresCsv(row),
            ])}
          />
        }
      >
        <Table
          label={t("profiles.subscriptions.title")}
          head={
            <>
              <th scope="col">{t("profiles.subscriptions.subscription")}</th>
              <FiguresHeader />
            </>
          }
        >
          <tbody>
            {profile.subscriptions.map((row) => (
              <tr key={row.subscriptionId ?? ""}>
                <th scope="row">
                  {row.subscriptionId === null
                    ? t("profiles.subscriptions.payAsYouGo")
                    : (row.label ?? row.subscriptionId)}
                </th>
                <FiguresCells figures={row} language={language} />
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
      <Section
        title={t("profiles.sessions.title")}
        actions={
          <TableExport
            name={t("profiles.sessions.title")}
            filename={file("sessions")}
            columns={[
              t("profiles.sessions.started"),
              t("profiles.sessions.agent"),
              ...figuresColumns,
            ]}
            rows={profile.sessions.map((row) => [row.startedAt, row.agent, ...figuresCsv(row)])}
          />
        }
      >
        <Table
          label={t("profiles.sessions.title")}
          head={
            <>
              <th scope="col">{t("profiles.sessions.started")}</th>
              <th scope="col">{t("profiles.sessions.agent")}</th>
              <FiguresHeader />
            </>
          }
        >
          <tbody>
            {profile.sessions.map((row) => (
              <tr key={row.sessionId}>
                <th scope="row">
                  <SessionLink patch={{ id: row.sessionId }} className="profiles__link">
                    {row.startedAt ? (
                      <time dateTime={row.startedAt}>{format.format(new Date(row.startedAt))}</time>
                    ) : (
                      t("profiles.sessions.unknownStart")
                    )}
                  </SessionLink>
                </th>
                <td>{row.agent ? agentLabel(t, row.agent) : t("profiles.unknown")}</td>
                <FiguresCells figures={row} language={language} />
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
    </Panel>
  );
}
