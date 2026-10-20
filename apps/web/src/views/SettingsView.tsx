import { useTranslation } from "react-i18next";
import { SegmentedControl } from "../components/SegmentedControl";
import { type Language, SUPPORTED_LANGUAGES } from "../i18n/i18n";
import { DARK_VARIANTS, DENSITIES, THEME_MODES } from "../prefs/preferences";
import { usePreferences } from "../prefs/usePreferences";

export function SettingsView() {
  const { t, i18n } = useTranslation();
  const { theme, density, setTheme, setDensity } = usePreferences();
  const language = (i18n.resolvedLanguage ?? i18n.language) as Language;

  const rows = [
    {
      id: "theme",
      label: t("settings.theme.label"),
      control: (
        <SegmentedControl
          label={t("settings.theme.label")}
          value={theme.mode}
          options={THEME_MODES.map((mode) => ({ value: mode, label: t(`settings.theme.${mode}`) }))}
          onChange={(mode) => setTheme({ ...theme, mode })}
        />
      ),
    },
    {
      id: "darkVariant",
      label: t("settings.darkVariant.label"),
      control: (
        <SegmentedControl
          label={t("settings.darkVariant.label")}
          value={theme.darkVariant}
          options={DARK_VARIANTS.map((variant) => ({
            value: variant,
            label: t(`settings.darkVariant.${variant}`),
          }))}
          onChange={(darkVariant) => setTheme({ ...theme, darkVariant })}
        />
      ),
    },
    {
      id: "density",
      label: t("settings.density.label"),
      control: (
        <SegmentedControl
          label={t("settings.density.label")}
          value={density}
          options={DENSITIES.map((value) => ({ value, label: t(`settings.density.${value}`) }))}
          onChange={setDensity}
        />
      ),
    },
    {
      id: "language",
      label: t("settings.language.label"),
      control: (
        <SegmentedControl
          label={t("settings.language.label")}
          value={language}
          options={SUPPORTED_LANGUAGES.map((value) => ({ value, label: t(`language.${value}`) }))}
          onChange={(next) => void i18n.changeLanguage(next)}
        />
      ),
    },
  ];

  return (
    <>
      <h1 className="view__title">{t("settings.title")}</h1>
      <dl className="settings">
        {rows.map((row) => (
          <div key={row.id} className="settings__row">
            <dt className="settings__label">{row.label}</dt>
            <dd className="settings__control">{row.control}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
