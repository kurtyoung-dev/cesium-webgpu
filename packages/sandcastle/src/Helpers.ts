import { deflate, inflate } from "pako";

/**
 * Generate a preamble that patches Cesium.Viewer for WebGPU mode and enables FPS display.
 *
 * For WebGPU: replaces `new Cesium.Viewer(...)` calls with `await Cesium.Viewer.createAsync(...)`
 * by monkey-patching the Viewer class. Since sandcastle code runs as ES modules (which support
 * top-level await), the async conversion works transparently.
 *
 * For FPS: patches Viewer creation to enable `scene.debugShowFramesPerSecond` after init.
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
  const _OriginalViewer = _Cesium.Viewer;
  const _OriginalCreateAsync = _Cesium.Viewer.createAsync;
  const _renderer = "${renderer}";
  const _showFps = ${showFps};

  // Patch createAsync to inject renderer option and FPS
  _Cesium.Viewer.createAsync = async function(container, options) {
    options = options || {};
    if (_renderer === "webgpu") {
      options.contextOptions = { ...options.contextOptions, renderer: "webgpu" };
    }
    const viewer = await _OriginalCreateAsync.call(_Cesium.Viewer, container, options);
    if (_showFps && viewer.scene) {
      viewer.scene.debugShowFramesPerSecond = true;
    }
    return viewer;
  };

  if (_renderer === "webgpu") {
    // Replace Viewer constructor with a proxy that redirects to createAsync.
    // This works because ES module scripts support top-level await, and
    // we wrap the user code so that "new Cesium.Viewer(...)" becomes async.
    const _ViewerProxy = new Proxy(_OriginalViewer, {
      construct(target, args) {
        // Signal that sync construction was attempted — the code transform
        // below converts "new Cesium.Viewer" to "await Cesium.Viewer.createAsync"
        // so this should rarely fire. If it does, warn and fall back to WebGL.
        console.warn("[Sandcastle] WebGPU requires async Viewer creation. Falling back to WebGL for this instance.");
        const viewer = new _OriginalViewer(...args);
        if (_showFps && viewer.scene) {
          viewer.scene.debugShowFramesPerSecond = true;
        }
        return viewer;
      },
      get(target, prop, receiver) {
        return Reflect.get(target, prop, receiver);
      }
    });
    _Cesium.Viewer = _ViewerProxy;
  } else if (_showFps) {
    // WebGL mode with FPS — patch constructor to enable FPS after creation
    const _ViewerWrapper = new Proxy(_OriginalViewer, {
      construct(target, args) {
        const viewer = new _OriginalViewer(...args);
        if (viewer.scene) {
          viewer.scene.debugShowFramesPerSecond = true;
        }
        return viewer;
      },
      get(target, prop, receiver) {
        return Reflect.get(target, prop, receiver);
      }
    });
    _Cesium.Viewer = _ViewerWrapper;
  }
}
`);
  }

  parts.push(`// --- End Sandcastle Renderer Preamble ---`);
  return parts.join("\n");
}

/**
 * Transform sandcastle code for WebGPU mode:
 * - Replace `new Cesium.Viewer(` with `await Cesium.Viewer.createAsync(`
 * - Replace `new Viewer(` with `await Viewer.createAsync(` (for destructured imports)
 */
function transformCodeForWebGPU(code: string): string {
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

  // For WebGPU mode, transform synchronous Viewer construction to async
  let processedCode = code;
  if (renderer === "webgpu") {
    processedCode = transformCodeForWebGPU(code);
  }

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
