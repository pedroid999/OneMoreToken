import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl, type SegmentedOption } from "../components/SegmentedControl";
import {
  saveTaskClass,
  type TaskClassChoice,
  type TaskClassState,
  taskClassChoice,
} from "./taskClass";

const CHOICES: readonly TaskClassChoice[] = ["feature", "inline", "auto"];

/**
 * Correction of the session's task class (spec §7.3, S2): the derived class is the default and
 * can be overridden per session; "auto" clears the override. Always says which one is in force.
 */
export function TaskClassControl({
  sessionId,
  taskClass,
}: {
  sessionId: string;
  /** `taskClass` of GET /api/sessions/:id. */
  taskClass: TaskClassState;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<TaskClassState | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = saved ?? taskClass;
  const choice = taskClassChoice(current);
  const options: readonly SegmentedOption<TaskClassChoice>[] = CHOICES.map((value) => ({
    value,
    label: value === "auto" ? t("session.taskClass.auto") : t(`taskClass.${value}`),
  }));

  const change = (next: TaskClassChoice) => {
    if (next === choice || saving) return;
    setSaving(true);
    setFailed(false);
    void saveTaskClass(sessionId, next)
      .then((state) => {
        setSaving(false);
        if (state) setSaved(state);
        else setFailed(true);
      })
      .catch(() => {
        setSaving(false);
        setFailed(true);
      });
  };

  return (
    <div className="session__task-class">
      <SegmentedControl
        label={t("session.taskClass.label")}
        value={choice}
        options={options}
        onChange={change}
        disabled={saving}
      />
      <p className="session__task-class-value" aria-live="polite">
        {t("session.taskClass.value", {
          value: t(`taskClass.${current.value}`),
          source: t(`taskClass.source.${current.source}`),
        })}
      </p>
      {failed ? (
        <p className="session__warning" role="alert">
          {t("session.taskClass.error")}
        </p>
      ) : null}
    </div>
  );
}
