import { ReactNode, useCallback, useMemo } from "react";
import {
  availableFonts,
  initialSettings,
  Settings,
  SettingsContext,
} from "./SettingsContext";
import { useLocalStorage } from "react-use";
import { isRendererMode } from "./util/rendererSelection";

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, updateSettings] = useLocalStorage<Settings>(
    "sandcastle/settings",
    initialSettings,
    {
      raw: false,
      serializer: (value) => {
        // Build a new object so we always set only the settings we know about
        return JSON.stringify({
          theme: value.theme ?? initialSettings.theme,
          fontFamily: value.fontFamily ?? initialSettings.fontFamily,
          fontSize: value.fontSize ?? initialSettings.fontSize,
          fontLigatures: value.fontLigatures ?? initialSettings.fontLigatures,
          defaultPanel: value.defaultPanel ?? initialSettings.defaultPanel,
          embeddingSearch:
            value.embeddingSearch ?? initialSettings.embeddingSearch,
          rendererMode: value.rendererMode ?? initialSettings.rendererMode,
          showFps: value.showFps ?? initialSettings.showFps,
        });
      },
      deserializer: (value) => {
        // This allows us to guarantee all expected values are set AND any unknown
        // values are removed from the settings object
        const parsedValue = JSON.parse(value);
        let fontFamily = parsedValue.fontFamily ?? initialSettings.fontFamily;
        if (!(fontFamily in availableFonts)) {
          // sanitize while loading to avoid removed fonts or user editied values
          fontFamily = "droid-sans";
        }

        let fontSize = parsedValue.fontSize ?? initialSettings.fontSize;
        if (Number.isNaN(fontSize)) {
          fontSize = initialSettings.fontSize;
        }

        // Sanitize on load: stored JSON is user-editable and can also carry a
        // mode from a build that knew a name this one does not.
        let rendererMode =
          parsedValue.rendererMode ?? initialSettings.rendererMode;
        if (!isRendererMode(rendererMode)) {
          rendererMode = initialSettings.rendererMode;
        }

        return {
          theme: parsedValue.theme ?? initialSettings.theme,
          fontFamily: fontFamily,
          fontSize: fontSize,
          fontLigatures:
            parsedValue.fontLigatures ?? initialSettings.fontLigatures,
          defaultPanel:
            parsedValue.defaultPanel ?? initialSettings.defaultPanel,
          embeddingSearch:
            parsedValue.embeddingSearch ?? initialSettings.embeddingSearch,
          rendererMode: rendererMode,
          showFps: parsedValue.showFps ?? initialSettings.showFps,
        };
      },
    },
  );

  const mergeSettings = useCallback(
    (newSettings: Partial<Settings>) => {
      // allow partial updates but make sure we don't lose settings keys
      // won't currently work with nested settings
      updateSettings({
        ...initialSettings,
        ...settings,
        ...newSettings,
      });
    },
    [updateSettings, settings],
  );

  const contextValue = useMemo(
    () => ({
      settings: settings ?? initialSettings,
      updateSettings: mergeSettings,
    }),
    [settings, mergeSettings],
  );

  return <SettingsContext value={contextValue}>{children}</SettingsContext>;
}
