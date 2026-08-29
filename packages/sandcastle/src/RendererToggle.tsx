import { useContext } from "react";
import { RendererMode, SettingsContext } from "./SettingsContext";
import { DEFAULT_RENDERER_MODE } from "./util/rendererSelection";
import { Button, Field, Switch, Tooltip } from "@stratakit/bricks";
import "./RendererToggle.css";

const rendererOptions: { value: RendererMode; label: string; title: string }[] =
  [
    {
      value: "webgl",
      label: "WebGL",
      title: "Render using WebGL",
    },
    {
      value: "webgpu",
      label: "WebGPU",
      title: "Render using WebGPU (experimental)",
    },
    {
      value: "split",
      label: "Split",
      title: "Side-by-side comparison: WebGL (left) and WebGPU (right)",
    },
  ];

/**
 * The renderer selector in the app bar.
 *
 * The active mode is passed in rather than read from settings directly: a
 * `?renderer=` URL selection outranks the stored setting, so the button that
 * reads as pressed has to be the one the viewer pane is actually running.
 * Calling `onChange` is what retires such an override.
 */
export function RendererToggle({
  mode,
  onChange,
}: {
  mode: RendererMode;
  onChange: (mode: RendererMode) => void;
}) {
  const { settings, updateSettings } = useContext(SettingsContext);

  return (
    <div className="renderer-controls">
      <div className="renderer-toggle">
        {rendererOptions.map((opt) => (
          <Tooltip
            key={opt.value}
            // Derived, not written down: the default marker has to follow the
            // product default rather than outlive a change to it.
            content={
              opt.value === DEFAULT_RENDERER_MODE
                ? `${opt.title} (default)`
                : opt.title
            }
            type="label"
          >
            <Button
              tone={mode === opt.value ? "accent" : "neutral"}
              variant={mode === opt.value ? "solid" : "ghost"}
              onClick={() => onChange(opt.value)}
            >
              {opt.label}
            </Button>
          </Tooltip>
        ))}
      </div>
      <Tooltip content="Show frames per second" type="label">
        <Field.Root>
          <Field.Control
            render={
              <Switch
                checked={settings.showFps}
                onChange={(e) => {
                  updateSettings({ showFps: e.target.checked });
                }}
              />
            }
          />
          <Field.Label className="fps-label">FPS</Field.Label>
        </Field.Root>
      </Tooltip>
    </div>
  );
}
