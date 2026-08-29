import { createContext } from "react";
import {
  DEFAULT_RENDERER_MODE,
  type RendererMode,
} from "./util/rendererSelection";

export type AvailableFontId =
  "droid-sans" | "fira-code" | "cascadia-code" | "jetbrains-mono";
type FontDefinition = {
  readableName: string;
  cssValue: string;
  supportsLigatures: boolean;
};
export const availableFonts: Record<AvailableFontId, FontDefinition> = {
  "droid-sans": {
    readableName: "Droid Sans Mono (default)",
    cssValue: "Droid Sans Mono",
    supportsLigatures: false,
  },
  "fira-code": {
    readableName: "Fira Code",
    cssValue: "Fira Code",
    supportsLigatures: true,
  },
  "cascadia-code": {
    readableName: "Cascadia Code",
    cssValue: "Cascadia Code",
    supportsLigatures: true,
  },
  "jetbrains-mono": {
    readableName: "JetBrains Mono",
    cssValue: "JetBrains Mono",
    supportsLigatures: true,
  },
};

export type LeftPanel = "editor" | "gallery";

// The renderer vocabulary and the product default live in a leaf module so the
// URL/settings precedence rules can be exercised without pulling React into the
// test bundle. They are re-exported here because the settings context is where
// the rest of the app already looks for them.
export type { RendererMode };
export { DEFAULT_RENDERER_MODE };

export type Settings = {
  theme: "dark" | "light";
  fontFamily: AvailableFontId;
  fontSize: number;
  fontLigatures: boolean;
  defaultPanel: LeftPanel;
  embeddingSearch: boolean;
  rendererMode: RendererMode;
  showFps: boolean;
};

export const initialSettings: Settings = {
  theme: "dark",
  fontFamily: "droid-sans",
  fontSize: 14,
  fontLigatures: false,
  defaultPanel: "gallery",
  embeddingSearch: true,
  rendererMode: DEFAULT_RENDERER_MODE,
  showFps: false,
};

export const SettingsContext = createContext<{
  settings: Settings;
  updateSettings: (newSettings: Partial<Settings>) => void;
}>({
  settings: initialSettings,
  updateSettings: () => {},
});
