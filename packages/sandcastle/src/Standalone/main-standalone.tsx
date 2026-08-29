import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AppStandalone from "./AppStandalone.tsx";
import { SettingsProvider } from "../SettingsProvider.tsx";

// The standalone page needs the settings provider for the same reason the
// editor does: the renderer it runs comes from the stored setting unless the
// URL overrides it, and without a provider every read would fall back to the
// context default and ignore the visitor entirely.
createRoot(document.getElementById("app-container")!).render(
  <StrictMode>
    <SettingsProvider>
      <AppStandalone />
    </SettingsProvider>
  </StrictMode>,
);
