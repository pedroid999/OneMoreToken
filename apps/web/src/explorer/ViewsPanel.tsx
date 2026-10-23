import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Panel } from "../components/Panel";
import {
  deriveViewId,
  type ExplorerState,
  resolveViewId,
  type SavedViewEntry,
  stateToView,
} from "./state";

export interface ViewsPanelProps {
  /** Undefined while loading. */
  views: SavedViewEntry[] | undefined;
  /** Every id in use, including invalid user files, so a save never overwrites them. */
  takenIds: ReadonlySet<string>;
  failed: boolean;
  state: ExplorerState;
  onRetry: () => void;
  onLoad: (view: SavedViewEntry) => void;
  onSaved: (id: string) => void;
  onDeleted: (id: string) => void;
}

type Status = "idle" | "saving" | "saved" | "saveError" | "deleteError";

/** Presets (read-only, i18n names) and the user's views (S9, S13, L2). */
export function ViewsPanel(props: ViewsPanelProps) {
  const { views, takenIds, failed, state, onRetry, onLoad, onSaved, onDeleted } = props;
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const current = views?.find((view) => view.id === state.view);
  const label = (view: SavedViewEntry) => (view.origin === "preset" ? t(view.name) : view.name);

  const open = () => {
    setName(current?.origin === "user" ? current.name : "");
    setStatus("idle");
    setEditing(true);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim().slice(0, 120);
    if (!trimmed) return;
    // Editing a user view overwrites it; any other name collision gets a numbered suffix.
    const keep = current?.origin === "user" ? current.id : undefined;
    const id = resolveViewId(deriveViewId(trimmed), takenIds, keep);
    setStatus("saving");
    void fetch(`/api/views/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stateToView(state, { id, name: trimmed })),
    })
      .then((response) => {
        if (!response.ok) throw new Error("save failed");
        setEditing(false);
        setStatus("saved");
        onSaved(id);
      })
      .catch(() => setStatus("saveError"));
  };

  const remove = (view: SavedViewEntry) => {
    setStatus("idle");
    void fetch(`/api/views/${view.id}`, { method: "DELETE" })
      .then((response) => {
        if (!response.ok) throw new Error("delete failed");
        onDeleted(view.id);
      })
      .catch(() => setStatus("deleteError"));
  };

  return (
    <Panel
      title={t("explorer.views")}
      status={failed ? "error" : views ? "ready" : "loading"}
      error={{ message: t("explorer.viewsError"), onRetry }}
    >
      {editing ? (
        <form className="explorer__save" onSubmit={save}>
          <label className="explorer__field">
            <span className="explorer__label">{t("explorer.viewName")}</span>
            <input
              type="text"
              className="explorer__input explorer__input--grow"
              value={name}
              maxLength={120}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" loading={status === "saving"}>
            {t("explorer.saveView")}
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            {t("explorer.cancel")}
          </Button>
        </form>
      ) : (
        <div className="explorer__save">
          <Button variant="primary" onClick={open}>
            {t("explorer.saveView")}
          </Button>
        </div>
      )}
      {status === "saved" ? (
        <p className="explorer__success" role="status">
          {t("explorer.viewSaved")}
        </p>
      ) : null}
      {status === "saveError" || status === "deleteError" ? (
        <p className="explorer__warning" role="alert">
          {t(status === "saveError" ? "explorer.saveError" : "explorer.deleteError")}
        </p>
      ) : null}
      {views && views.length === 0 ? (
        <p className="explorer__muted">{t("explorer.viewsEmpty")}</p>
      ) : null}
      {views && views.length > 0 ? (
        <ul className="explorer__views">
          {views.map((view) => (
            <li key={view.id} className="explorer__view" data-origin={view.origin}>
              <div className="explorer__view-head">
                <Button
                  variant="ghost"
                  pressed={view.id === state.view}
                  onClick={() => onLoad(view)}
                >
                  {label(view)}
                </Button>
                {view.origin === "preset" ? (
                  <span className="explorer__tag">{t("explorer.preset")}</span>
                ) : (
                  <Button
                    variant="danger"
                    aria-label={t("explorer.deleteViewNamed", { name: view.name })}
                    onClick={() => remove(view)}
                  >
                    {t("explorer.deleteView")}
                  </Button>
                )}
              </div>
              {view.description ? (
                <p className="explorer__muted">
                  {view.origin === "preset" ? t(view.description) : view.description}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
