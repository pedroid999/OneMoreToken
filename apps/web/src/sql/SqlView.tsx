import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { Panel } from "../components/Panel";
import { useJson } from "../quotas/useJson";
import { isSavedQueryList, isSqlResult, type SavedQuery, type SqlResult } from "./contract";
import {
  cellText,
  DEFAULT_SQL,
  nextSavedQueryId,
  SAVED_QUERIES_PATH,
  SQL_QUERY_PATH,
  type SqlFailure,
  savedQueryPath,
  sqlFailure,
} from "./state";
import "../styles/sql.css";

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; result: SqlResult }
  | { status: "failed"; failure: SqlFailure };

type SaveStatus = "idle" | "saving" | "saved" | "error";

const failedText = (failure: SqlFailure, t: (key: string) => string): string => {
  if (failure.kind === "invalid") return t("sql.error.invalid");
  if (failure.kind === "timeout") return t("sql.error.timeout");
  if (failure.kind === "unavailable") return t("sql.error.unavailable");
  return failure.message ? `${t("sql.error.failed")}: ${failure.message}` : t("sql.error.failed");
};

/** Result rows as a plain table: the console's own output, not a chart (spec §7.1, T4). */
function ResultTable({ result }: { result: SqlResult }) {
  const { t } = useTranslation();
  return (
    <div className="sql__table-wrap">
      <table className="sql__table" aria-label={t("sql.result")}>
        <thead>
          <tr>
            {result.columns.map((column, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a query may repeat a column name
              <th key={`${column.name}-${index}`} scope="col">
                {column.name}
                <span className="sql__type">{column.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of a free query have no id
            <tr key={rowIndex}>
              {row.map((value, columnIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional by design
                <td key={columnIndex}>
                  {value === null || value === undefined ? t("sql.nullValue") : cellText(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * SQL console over the local DuckDB (spec §7.1, Phase 4 T4): one bounded, read-only query at a time,
 * with saved queries as private local files. The server owns every limit; this view only reports them.
 */
export function SqlView() {
  const { t } = useTranslation();
  const editorId = useId();
  const hintId = useId();
  const nameId = useId();
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [name, setName] = useState("");
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saved = useJson(SAVED_QUERIES_PATH, isSavedQueryList);

  const execute = async () => {
    const text = sql.trim();
    if (!text) return;
    setRun({ status: "running" });
    try {
      const response = await fetch(SQL_QUERY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: text }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok && isSqlResult(payload)) {
        setRun({ status: "ok", result: payload });
        return;
      }
      setRun({ status: "failed", failure: sqlFailure(payload) });
    } catch {
      setRun({ status: "failed", failure: { kind: "unavailable" } });
    }
  };

  const shortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void execute();
    }
  };

  /** Every id in use, including invalid files, so a save never overwrites them. */
  const takenIds = new Set<string>([
    ...(saved.data?.views.map((view) => view.id) ?? []),
    ...(saved.data?.invalid.map((entry) => entry.id) ?? []),
  ]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim().slice(0, 120);
    if (!trimmed) {
      setSaveStatus("error");
      return;
    }
    const id = nextSavedQueryId(trimmed, takenIds, loadedId);
    setSaveStatus("saving");
    void fetch(savedQueryPath(id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed, sql }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("save failed");
        setLoadedId(id);
        setSaveStatus("saved");
        saved.reload();
      })
      .catch(() => setSaveStatus("error"));
  };

  const load = (view: SavedQuery) => {
    setSql(view.sql);
    setName(view.name);
    setLoadedId(view.id);
    setSaveStatus("idle");
  };

  const remove = (view: SavedQuery) => {
    void fetch(savedQueryPath(view.id), { method: "DELETE" })
      .then((response) => {
        if (!response.ok) throw new Error("delete failed");
        if (loadedId === view.id) setLoadedId(undefined);
        saved.reload();
      })
      .catch(() => setSaveStatus("error"));
  };

  const resultPanel =
    run.status === "ok" ? (
      <>
        <p className="sql__muted">
          {t("sql.summary", { count: run.result.rowCount, ms: run.result.elapsedMs })}
        </p>
        {run.result.truncated ? (
          <p className="sql__muted">{t("sql.truncated", { rows: run.result.rowCount })}</p>
        ) : null}
        <ResultTable result={run.result} />
      </>
    ) : null;

  return (
    <div className="sql">
      <h1 className="view__title">{t("sql.title")}</h1>
      <p className="sql__muted">{t("sql.intro")}</p>

      <Panel
        title={t("sql.editorTitle")}
        actions={
          <Button
            variant="primary"
            onClick={() => void execute()}
            loading={run.status === "running"}
          >
            {run.status === "running" ? t("sql.running") : t("sql.run")}
          </Button>
        }
      >
        <label className="sql__label" htmlFor={editorId}>
          {t("sql.editor")}
        </label>
        <textarea
          id={editorId}
          className="sql__editor"
          aria-describedby={hintId}
          rows={8}
          spellCheck={false}
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={shortcut}
        />
        <p className="sql__muted" id={hintId}>
          {t("sql.runHint")}
        </p>
        <form className="sql__save" onSubmit={save}>
          <label className="sql__label" htmlFor={nameId}>
            {t("sql.saved.name")}
          </label>
          <input
            id={nameId}
            className="sql__input"
            value={name}
            maxLength={120}
            onChange={(event) => {
              setName(event.target.value);
              setSaveStatus("idle");
            }}
          />
          <Button type="submit" loading={saveStatus === "saving"}>
            {saveStatus === "saving" ? t("sql.saved.saving") : t("sql.saved.save")}
          </Button>
        </form>
        {saveStatus === "saved" ? (
          <p className="sql__muted" role="status">
            {t("sql.saved.saved")}
          </p>
        ) : null}
        {saveStatus === "error" ? (
          <p className="sql__error" role="alert">
            {t("sql.saved.saveError")}
          </p>
        ) : null}
      </Panel>

      <Panel
        title={t("sql.result")}
        status={
          run.status === "running"
            ? "loading"
            : run.status === "failed"
              ? "error"
              : run.status === "ok"
                ? "ready"
                : "empty"
        }
        empty={<EmptyState title={t("sql.empty")} body={t("sql.emptyHint")} />}
        {...(run.status === "failed"
          ? { error: { message: failedText(run.failure, t), onRetry: () => void execute() } }
          : {})}
      >
        {resultPanel}
      </Panel>

      <Panel
        title={t("sql.saved.title")}
        status={saved.failed ? "error" : saved.data ? "ready" : "loading"}
        error={{ message: t("sql.saved.error"), onRetry: saved.reload }}
      >
        {saved.data && saved.data.views.length === 0 ? (
          <p className="sql__muted">{t("sql.saved.empty")}</p>
        ) : null}
        <ul className="sql__list">
          {saved.data?.views.map((view) => (
            <li key={view.id} className="sql__item">
              <Button variant="ghost" className="sql__name" onClick={() => load(view)}>
                {view.name}
              </Button>
              <Button
                variant="ghost"
                aria-label={t("sql.saved.delete", { name: view.name })}
                onClick={() => remove(view)}
              >
                {t("sql.saved.deleteLabel")}
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
