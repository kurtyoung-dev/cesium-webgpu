import { useContext } from "react";
import { RendererMode, SettingsContext } from "./SettingsContext";
import { Button, Field, Switch, Tooltip } from "@stratakit/bricks";
import "./RendererToggle.css";

const rendererOptions: { value: RendererMode; label: string; title: string }[] =
  [
    {
      value: "webgl",
      label: "WebGL",
      title: "Render using WebGL (default)",
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

export function RendererToggle() {
  const { settings, updateSettings } = useContext(SettingsContext);

  return (
    <div className="renderer-controls">
      <div className="renderer-toggle">
        {rendererOptions.map((opt) => (
          <Tooltip key={opt.value} content={opt.title} type="label">
            <Button
              // @ts-expect-error tone works but is not passed through the types from Button
              tone={settings.rendererMode === opt.value ? "accent" : "neutral"}
              variant={settings.rendererMode === opt.value ? "solid" : "ghost"}
              onClick={() => updateSettings({ rendererMode: opt.value })}
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
