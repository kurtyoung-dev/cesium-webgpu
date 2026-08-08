/**
 * The CesiumViewer application's fork-only development chrome: the renderer
 * switcher, the frames-per-second toggle, and the two-pane layout used by
 * split mode.
 *
 * None of it exists in the page until a function here is called. The markup
 * and the styles are both built at runtime rather than living in
 * `index.html`, which keeps the served page identical to upstream's for a
 * default start — a `display: none` toolbar would still be observable in the
 * DOM, and integrators comparing the two pages would see it.
 *
 * Carrying the stylesheet as module text rather than a sibling `.css` file
 * ties it to the same gate as the markup and keeps the dev server and the
 * bundled application in step: the application build lists CSS entry points
 * explicitly, so a new stylesheet would have to be registered there to avoid
 * resolving to nothing in `Build/`.
 *
 * @module CesiumViewerDevUi
 */

const CHROME_STYLE_ELEMENT_ID = "cesiumViewerForkChrome";

const CHROME_STYLES = `
.renderer-toolbar {
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 4px 10px;
  backdrop-filter: blur(8px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
  color: #fff;
  user-select: none;
}
.renderer-toolbar .btn-group {
  display: flex;
  gap: 1px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.25);
}
.renderer-toolbar button {
  border: none;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.08);
  color: #ccc;
  transition:
    background 0.15s,
    color 0.15s;
}
.renderer-toolbar button:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
.renderer-toolbar button.active {
  background: #4fc3f7;
  color: #000;
}
.renderer-toolbar label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  margin-left: 4px;
}
.renderer-toolbar input[type="checkbox"] {
  cursor: pointer;
  accent-color: #4fc3f7;
}
.renderer-toolbar .divider {
  width: 1px;
  height: 16px;
  background: rgba(255, 255, 255, 0.25);
  margin: 0 2px;
}
.split-container {
  display: flex;
  width: 100%;
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;
}
.split-pane {
  flex: 1;
  position: relative;
  min-width: 0;
}
.split-divider {
  width: 2px;
  background: #4fc3f7;
  flex-shrink: 0;
}
.split-label {
  position: absolute;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  pointer-events: none;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  backdrop-filter: blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
`;

/**
 * Buttons the switcher offers, in display order.
 */
const MODE_BUTTONS = Object.freeze([
  { id: "btnWebGL", mode: "webgl", label: "WebGL" },
  { id: "btnWebGPU", mode: "webgpu", label: "WebGPU" },
  { id: "btnSplit", mode: "split", label: "Split" },
]);

/**
 * Add the fork chrome's stylesheet to the document, at most once.
 *
 * Split mode calls this too. Its panes are fork-only layout even when the
 * switcher is absent, so the rules travel with any chrome that needs them
 * rather than with the toolbar alone.
 */
export function ensureForkChromeStyles() {
  if (document.getElementById(CHROME_STYLE_ELEMENT_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = CHROME_STYLE_ELEMENT_ID;
  style.textContent = CHROME_STYLES;
  document.head.appendChild(style);
}

/**
 * Build the renderer switcher and insert it at the top of the page.
 *
 * @param {object} options Toolbar options.
 * @param {string} options.mode Mode to show as active initially.
 * @param {boolean} options.showFps Initial state of the FPS checkbox.
 * @param {Function} options.onSelectMode Called with the requested mode.
 * @param {Function} options.onToggleFps Called with the checkbox state.
 * @returns {{setActiveMode: Function}} Controller for the inserted toolbar.
 */
export function createRendererToolbar({
  mode,
  showFps,
  onSelectMode,
  onToggleFps,
}) {
  ensureForkChromeStyles();

  const toolbar = document.createElement("div");
  toolbar.id = "rendererToolbar";
  toolbar.className = "renderer-toolbar";

  const group = document.createElement("div");
  group.className = "btn-group";
  const buttons = MODE_BUTTONS.map((descriptor) => {
    const button = document.createElement("button");
    button.id = descriptor.id;
    button.textContent = descriptor.label;
    button.addEventListener("click", () => onSelectMode(descriptor.mode));
    group.appendChild(button);
    return { descriptor, button };
  });
  toolbar.appendChild(group);

  const divider = document.createElement("div");
  divider.className = "divider";
  toolbar.appendChild(divider);

  const fpsLabel = document.createElement("label");
  const fpsCheckbox = document.createElement("input");
  fpsCheckbox.type = "checkbox";
  fpsCheckbox.id = "fpsToggle";
  fpsCheckbox.checked = showFps === true;
  fpsCheckbox.addEventListener("change", () =>
    onToggleFps(fpsCheckbox.checked),
  );
  fpsLabel.appendChild(fpsCheckbox);
  fpsLabel.appendChild(document.createTextNode(" FPS"));
  toolbar.appendChild(fpsLabel);

  document.body.insertBefore(toolbar, document.body.firstChild);

  function setActiveMode(activeMode) {
    for (const entry of buttons) {
      entry.button.classList.toggle(
        "active",
        entry.descriptor.mode === activeMode,
      );
    }
  }
  setActiveMode(mode);

  return { setActiveMode };
}
