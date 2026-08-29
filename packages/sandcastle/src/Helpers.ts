import { deflate, inflate } from "pako";

/**
 * The name of the synchronous-construction helper the renderer preamble
 * installs on `globalThis` and the code transform calls into.
 */
const SYNC_HELPER = "__sandcastleConstruct";

/**
 * The two constructors a Sandcastle demo can build a globe with, in the two
 * spellings the gallery uses: fully qualified off the namespace import, and
 * bare from a destructured `const { Viewer } = Cesium;`.
 *
 * The trailing `\(` is what keeps `new CustomViewer(` and `new CesiumWidgetFoo(`
 * out of the match — only an exact constructor name immediately followed by its
 * argument list is rewritten.
 */
const CONSTRUCTORS: { pattern: RegExp; expression: string }[] = [
  { pattern: /new\s+Cesium\.Viewer\s*\(/g, expression: "Cesium.Viewer" },
  { pattern: /new\s+Viewer\s*\(/g, expression: "Viewer" },
  {
    pattern: /new\s+Cesium\.CesiumWidget\s*\(/g,
    expression: "Cesium.CesiumWidget",
  },
  { pattern: /new\s+CesiumWidget\s*\(/g, expression: "CesiumWidget" },
];

/**
 * Generate the preamble that makes demo code run on the renderer Sandcastle
 * actually selected, and enables the FPS display.
 *
 * WHY A PREAMBLE AT ALL. The synchronous constructors support WebGL only — the
 * engine throws `DeveloperError` for any other `contextOptions.renderer`,
 * because a WebGPU device can only be acquired asynchronously. So WebGPU needs
 * `createAsync`, which the code transform rewrites demo call sites into, and
 * this preamble is what injects the renderer into those factories. Demo source
 * is never edited on disk.
 *
 * WHY WEBGL GETS A PREAMBLE TOO. Without one, a demo that names a renderer in
 * its own source outranks the selection: demos pinning `renderer: "webgpu"`
 * render WebGPU even in the WebGL pane — which makes a split-screen comparison
 * vacuous, since both panes then show the same backend — and a demo that pins it
 * on a *synchronous* constructor throws outright. Forcing the selected renderer
 * in both directions is what makes the toggle, the split view and the
 * `?renderer=` parameter mean what they say.
 *
 * WHY IT IS EMITTED AS TWO LINES REGARDLESS OF MODE. The preamble is prepended
 * to the demo body, so every line it occupies shifts the line numbers reported
 * back to the editor for runtime errors. Two lines is what the no-op case has
 * always cost, so the block is folded onto the second line and the offset stays
 * both small and identical in every mode.
 *
 * IMPORTANT — the module namespace is frozen: `await import("cesium")` yields an
 * ES-module namespace exotic object whose bindings are read-only. Assigning to a
 * property of it (e.g. `_Cesium.Viewer = proxy`) throws `TypeError: Cannot
 * assign to property "Viewer" of [object Module]` and aborts the whole demo
 * module — that is why WebGPU demos would get stuck on "Loading...". We
 * therefore ONLY mutate the constructor *class objects* (their writable static
 * members such as `createAsync`), never the namespace binding, and route
 * synchronous construction through a `globalThis` helper instead.
 */
function buildRendererPreamble(
  renderer: "webgl" | "webgpu",
  showFps: boolean,
): string {
  const statements = [
    `const _Cesium = await import("cesium");`,
    `const _renderer = ${JSON.stringify(renderer)};`,
    `const _showFps = ${showFps};`,
    // Force the selection over whatever the demo asked for, rather than merging
    // under it: a demo-supplied renderer is exactly the value that has to lose.
    `const _withRenderer = (options) => ({ ...options, contextOptions: { ...(options && options.contextOptions), renderer: _renderer } });`,
    // Demos keep their viewer in a local const, so nothing else can reach it.
    // Publishing every construction gives devtools the same handle the page
    // already gets for the Cesium namespace, and gives a headless check a way
    // to ask which backend a demo actually ended up on.
    `const _afterCreate = (instance) => { if (_showFps && instance && instance.scene) { instance.scene.debugShowFramesPerSecond = true; } (globalThis.__sandcastleInstances ??= []).push(instance); return instance; };`,
    `const _patchCreateAsync = (ctor) => { if (!ctor || typeof ctor.createAsync !== "function") { return; } const _original = ctor.createAsync; ctor.createAsync = async function (container, options, onProgress) { return _afterCreate(await _original.call(ctor, container, _withRenderer(options), onProgress)); }; };`,
    `_patchCreateAsync(_Cesium.Viewer);`,
    `_patchCreateAsync(_Cesium.CesiumWidget);`,
    `globalThis.${SYNC_HELPER} = function (Ctor, container, options, ...rest) { return _afterCreate(new Ctor(container, _withRenderer(options), ...rest)); };`,
  ];

  return `// --- Sandcastle Renderer Preamble ---
{ ${statements.join(" ")} } /* --- End Sandcastle Renderer Preamble --- */`;
}

/**
 * Transform sandcastle code so the viewer is built the way the active renderer
 * needs, without editing the demo on disk.
 *
 * WebGPU requires asynchronous construction, so every synchronous call site
 * becomes an awaited factory call:
 * - `new Cesium.Viewer(` -> `await Cesium.Viewer.createAsync(`
 * - `new Cesium.CesiumWidget(` -> `await Cesium.CesiumWidget.createAsync(`
 * - and the bare, destructured spellings of both
 *
 * Demo bodies are injected as `<script type="module">`, so top-level `await` is
 * legal by construction, including at column 0.
 *
 * WebGL stays synchronous but still routes through the preamble helper, so the
 * selected renderer overrides any renderer the demo names for itself and the
 * FPS counter can be enabled without touching the frozen module namespace:
 * - `new Cesium.Viewer(` -> `globalThis.__sandcastleConstruct(Cesium.Viewer, `
 */
function transformCodeForRenderer(
  code: string,
  renderer: "webgl" | "webgpu",
): string {
  let transformed = code;
  for (const { pattern, expression } of CONSTRUCTORS) {
    // These are module-level /g regexes reused across calls; `replace` resets
    // lastIndex itself, but resetting here keeps that independent of it.
    pattern.lastIndex = 0;
    transformed = transformed.replace(
      pattern,
      renderer === "webgpu"
        ? `await ${expression}.createAsync(`
        : `globalThis.${SYNC_HELPER}(${expression}, `,
    );
  }
  return transformed;
}

export function embedInSandcastleTemplate(
  code: string,
  addExtraLine: boolean,
  renderer: "webgl" | "webgpu" = "webgl",
  showFps: boolean = false,
) {
  let imports = "";

  if (!/^import\s+\*\s+as\s+Cesium\s+from\s+(['"])cesium\1;?$/m.test(code)) {
    imports += `import * as Cesium from "cesium";\n`;
  }
  if (!/^import\s+Sandcastle\s+from\s+(['"])Sandcastle\1;?$/m.test(code)) {
    imports += `import Sandcastle from "Sandcastle";\n`;
  }

  // Build renderer preamble (forces the active renderer, enables FPS)
  const preamble = buildRendererPreamble(renderer, showFps);

  // Transform viewer construction as needed for the active renderer.
  const processedCode = transformCodeForRenderer(code, renderer);

  return `${addExtraLine ? "\n" : ""}${preamble}
${processedCode}
// Imports are hoisted. Adding them here preserves line numbers with the editor
${imports}
// Call default actions that might have been set up
Sandcastle.finishedLoading();
// Set Cesium on the window for use in DevTools
window.Cesium = Cesium;
`;
}

type SandcastleSaveData = {
  code: string;
  html: string;
};

export function makeCompressedBase64String(data: SandcastleSaveData) {
  // data stored in the hash as:
  // Base64 encoded, raw DEFLATE compressed JSON array where index 0 is code, index 1 is html
  const { code, html } = data;
  const encode = [code, html];
  let jsonString = JSON.stringify(encode);

  // we save a few bytes by omitting the leading [" and trailing "] since they are always the same
  jsonString = jsonString.slice(2, 2 + jsonString.length - 4);
  const pakoData = deflate(jsonString, { raw: true, level: 9 });

  // https://stackoverflow.com/questions/12710001/how-to-convert-uint8-array-to-base64-encoded-string
  let base64String = btoa(String.fromCharCode(...pakoData));
  base64String = base64String.replace(/=+$/, ""); // remove padding

  return base64String;
}

export function decodeBase64Data(base64String: string): SandcastleSaveData {
  // data stored in the hash as:
  // Base64 encoded, raw DEFLATE compressed JSON array where index 0 is code, index 1 is html
  // restore padding
  while (base64String.length % 4 !== 0) {
    base64String += "=";
  }
  // https://stackoverflow.com/questions/12710001/how-to-convert-uint8-array-to-base64-encoded-string
  const dataArray = new Uint8Array(
    atob(base64String)
      .split("")
      .map(function (c) {
        return c.charCodeAt(0);
      }),
  );

  let jsonString = inflate(dataArray, { raw: true, toText: true });

  // we save a few bytes by omitting the leading [" and trailing "] since they are always the same
  jsonString = `["${jsonString}"]`;
  const json = JSON.parse(jsonString);

  // index 0 is code, index 1 is html
  const code = json[0];
  const html = json[1];
  const baseHref = json[2];
  if (baseHref !== undefined) {
    // historically the third element allowed changing the <base> of the page when loaded
    // This is no longer supported but could show up in old links if they were saved.
    console.warn(
      "Sandcastle no longer supports setting the base through the sandcastle URL",
    );
  }
  return {
    code: code,
    html: html,
  };
}
