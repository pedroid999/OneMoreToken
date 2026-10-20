import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createI18n } from "./i18n/i18n";
import { browserStorage } from "./prefs/storage";
import "./styles/app.css";

const storage = browserStorage();
const container = document.getElementById("root");

void createI18n({ storage, browserLanguages: navigator.languages }).then((i18n) => {
  if (!container) return;
  createRoot(container).render(
    <StrictMode>
      <App
        i18n={i18n}
        env={{
          storage,
          root: document.documentElement,
          matchMedia: (query) => window.matchMedia(query),
        }}
      />
    </StrictMode>,
  );
});
