import { deflate, inflate } from "pako";

/**
 * Generate a preamble that patches Cesium.Viewer for WebGPU mode and enables FPS display.
 *
 * For WebGPU: the code transform (see `transformCodeForRenderer`) rewrites
 * `new Cesium.Viewer(...)` calls into `await Cesium.Viewer.createAsync(...)`, and this
 * preamble patches the static `Viewer.createAsync` to inject `renderer: "webgpu"`. Since
 * sandcastle code runs as ES modules (which support top-level await), the async conversion
 * works transparently.
 *
 * For FPS: patches Viewer creation to enable `scene.debugShowFramesPerSecond` after init.
 *
 * IMPORTANT — the module namespace is frozen: `await import("cesium")` yields an ES-module
 * namespace exotic object whose bindings are read-only. Assigning to a property of it (e.g.
 * `_Cesium.Viewer = proxy`) throws `TypeError: Cannot assign to property "Viewer" of
 * [object Module]` and aborts the whole demo module — that is why WebGPU demos would get stuck
 * on "Loading...". We therefore ONLY mutate the Viewer *class object* (its writable static
 * members such as `createAsync`), never the namespace binding, and route the synchronous
 * `new Cesium.Viewer(...)` FPS path through a code transform + a `globalThis` helper instead.
 */
function buildRendererPreamble(
  renderer: "webgl" | "webgpu",
  showFps: boolean,
): string {
  const parts: string[] = [];

  parts.push(`// --- Sandcastle Renderer Preamble ---`);

  if (renderer === "webgpu" || showFps) {
    parts.push(`
{
  const _Cesium = await import("cesium");
  const _OriginalCreateAsync = _Cesium.Viewer.createAsync;
  const _renderer = "${renderer}";
  const _showFps = ${showFps};

  // Patch the STATIC createAsync to inject the renderer option + FPS. Mutating a
  // property of the Viewer class object is allowed; the module namespace itself is
  // frozen, so we must never assign to _Cesium.Viewer (that throws and aborts the demo).
  _Cesium.Viewer.createAsync = async function(container, options) {
    options = options || {};
    if (_renderer === "webgpu") {
      options.contextOptions = { ...options.contextOptions, renderer: "webgpu" };
    }
    const viewer = await _OriginalCreateAsync.call(_Cesium.Viewer, container, options);
    if (_showFps && viewer && viewer.scene) {
      viewer.scene.debugShowFramesPerSecond = true;
    }
    return viewer;
  };

  // WebGL + FPS demos build the Viewer synchronously via "new Cesium.Viewer(...)".
  // The code transform rewrites those call sites to this helper so we can enable the
  // FPS counter without reassigning the frozen module namespace binding. (WebGPU sync
  // sites are instead rewritten to "await Cesium.Viewer.createAsync(...)", handled above.)
  if (_showFps && _renderer !== "webgpu") {
    globalThis.__sandcastleFpsViewer = function(...args) {
      const viewer = new _Cesium.Viewer(...args);
      if (viewer && viewer.scene) {
        viewer.scene.debugShowFramesPerSecond = true;
      }
      return viewer;
    };
  }
}
`);
  }

  parts.push(`// --- End Sandcastle Renderer Preamble ---`);
  return parts.join("\n");
}

/**
 * Transform sandcastle code so the Viewer is built the way the active renderer needs.
 *
 * WebGPU (requires async construction):
 * - Replace `new Cesium.Viewer(` with `await Cesium.Viewer.createAsync(`
 * - Replace `new Viewer(` with `await Viewer.createAsync(` (for destructured imports)
 *
 * WebGL + FPS (stays synchronous, but must route through the preamble helper so the FPS
 * counter can be enabled without touching the frozen `cesium` module namespace):
 * - Replace `new Cesium.Viewer(` / `new Viewer(` with `globalThis.__sandcastleFpsViewer(`
 *
 * When renderer is WebGL and FPS is off, the code is returned unchanged (byte-identical).
 */
function transformCodeForRenderer(
  code: string,
  renderer: "webgl" | "webgpu",
  showFps: boolean,
): string {
  if (renderer === "webgpu") {
    // Match "new Cesium.Viewer(" — the most common pattern in sandcastle demos
    let transformed = code.replace(
      /new\s+Cesium\.Viewer\s*\(/g,
      "await Cesium.Viewer.createAsync(",
    );

    // Also match bare "new Viewer(" for demos that destructure: const { Viewer } = Cesium;
    // Be careful not to match things like "new CustomViewer(" — only standalone "Viewer"
    transformed = transformed.replace(
      /new\s+Viewer\s*\(/g,
      "await Viewer.createAsync(",
    );

    return transformed;
  }

  if (showFps) {
    // WebGL + FPS: wrap synchronous construction in the preamble helper.
    let transformed = code.replace(
      /new\s+Cesium\.Viewer\s*\(/g,
      "globalThis.__sandcastleFpsViewer(",
    );
    transformed = transformed.replace(
      /new\s+Viewer\s*\(/g,
      "globalThis.__sandcastleFpsViewer(",
    );
    return transformed;
  }

  return code;
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

  // Build renderer preamble (patches Viewer for WebGPU / FPS)
  const preamble = buildRendererPreamble(renderer, showFps);

  // Transform synchronous Viewer construction as needed for the active renderer / FPS.
  const processedCode = transformCodeForRenderer(code, renderer, showFps);

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
