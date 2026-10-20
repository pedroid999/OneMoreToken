import { useTranslation } from "react-i18next";

// Badge markup and image URL kept exactly as spec §11.4 asks.
const BADGE_HREF = "https://github.com/Gentleman-Programming/gentle-ai";
const BADGE_SRC =
  "https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png";

export function AboutView() {
  const { t } = useTranslation();
  return (
    <>
      <h1 className="view__title">{t("about.title")}</h1>
      <div className="about">
        <p className="about__body">{t("about.body")}</p>
        <p className="about__badge">
          <a href={BADGE_HREF}>
            <img width="220" src={BADGE_SRC} alt={t("about.badgeAlt")} />
          </a>
        </p>
        <p className="about__credit">{t("about.independent")}</p>
      </div>
    </>
  );
}
