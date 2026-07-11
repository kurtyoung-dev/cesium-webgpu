import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { SettingsProvider } from "./SettingsProvider.tsx";
import { CopilotSettingsProvider, ModelProvider } from "./copilot";

// The app <-> viewer-iframe postMessage bridge bakes the outer app origin
// (__OUTER_ORIGIN__) and the inner bucket origin (__INNER_ORIGIN__) at build
// time; the inner iframe posts back to __OUTER_ORIGIN__, so the app only works
// when served from that origin. Loading it from the inner mirror origin (the
// +1 sandcastlePort) is a common footgun that silently breaks the bridge
// ("target origin ... does not match the recipient window's origin") and leaves
// every renderer black. Send the top-level app to the correct origin instead.
// Redirecting to __OUTER_ORIGIN__ can never loop: on arrival the origin matches.
const outerOrigin = __OUTER_ORIGIN__;
if (
  window.self === window.top &&
  typeof outerOrigin === "string" &&
  outerOrigin.length > 0 &&
  window.location.origin !== outerOrigin
) {
  window.location.replace(
    `${outerOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
} else {
  createRoot(document.getElementById("app-container")!).render(
    <StrictMode>
      <SettingsProvider>
        <CopilotSettingsProvider>
          <ModelProvider>
            <App />
          </ModelProvider>
        </CopilotSettingsProvider>
      </SettingsProvider>
    </StrictMode>,
  );
}
