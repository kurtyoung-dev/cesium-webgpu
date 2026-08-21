import {
  Cartesian2,
  clone,
  defined,
  RendererType,
  Scene,
} from "@cesium/engine";

import createCanvas from "./createCanvas.js";

/**
 * The asynchronous analogue of {@link createScene} — for specs that need a
 * Scene on a backend the synchronous `new Scene(...)` constructor cannot
 * produce. `Scene` rejects every asynchronous renderer policy at construction,
 * so a WebGPU Scene can only come from `Scene.createAsync`.
 *
 * `createScene.js` is deliberately untouched: the WebGL lane it serves is
 * enormous, and this helper's job is to add a backend, not to perturb one.
 *
 * Two properties make this helper worth having over an inline
 * `Scene.createAsync` call, and both exist because a WebGPU request can be
 * satisfied by WebGL without anything looking wrong:
 *
 *   1. `strictRenderer: true` is MANDATORY here, not defaulted. Without it, an
 *      explicit `renderer: "webgpu"` request on a host with no WebGPU
 *      implementation resolves a fully working WebGL Scene and logs a
 *      `console.warn` — the renderer plan appends a WebGL attempt for explicit
 *      WebGPU requests (`Renderer/RendererType.js`), and `ContextFactory` takes
 *      it. A spec suite would then assert WebGPU behaviour against WebGL and
 *      pass. Passing `strictRenderer: false` is rejected rather than honoured.
 *   2. The resolved backend is re-checked after construction. Strict mode is a
 *      request, and a request is not evidence; `context.rendererType` is. A
 *      mismatch destroys the Scene and throws, so the wrong backend can never
 *      reach a spec body.
 *
 * `renderer: "auto"` is rejected for the same reason: a helper whose purpose is
 * to prove which backend is running cannot accept a request whose answer is
 * "whichever one happens to be available".
 *
 * @param {object} [options] Scene options, as accepted by `Scene.createAsync`.
 *   `options.contextOptions.renderer` defaults to `"webgpu"`.
 * @returns {Promise<Scene>} The constructed Scene, with the same
 *   `destroyForSpecs` / `renderForSpecs` / `pickForSpecs` helpers
 *   `createScene` attaches.
 */
async function createSceneAsync(options) {
  options = options ?? {};

  // Render tests can be difficult to debug. Let the caller choose a larger
  // canvas size temporarily, exactly as createScene does.
  const debugWidth = window.debugCanvasWidth;
  const debugHeight = window.debugCanvasHeight ?? window.debugCanvasWidth;

  // save the canvas so we don't try to clone an HTMLCanvasElement
  const callerSuppliedCanvas = defined(options.canvas);
  const canvas = callerSuppliedCanvas
    ? options.canvas
    : createCanvas(debugWidth, debugHeight);
  options.canvas = undefined;

  options = clone(options, true);

  options.canvas = canvas;
  options.contextOptions = options.contextOptions ?? {};

  const contextOptions = options.contextOptions;
  const renderer = contextOptions.renderer ?? RendererType.WEBGPU;

  if (renderer === RendererType.AUTO) {
    throw new Error(
      `createSceneAsync requires a concrete renderer; "${RendererType.AUTO}" resolves ` +
        `to whichever backend is available and cannot be asserted against.`,
    );
  }
  if (contextOptions.strictRenderer === false) {
    throw new Error(
      "createSceneAsync cannot honor strictRenderer: false. Non-strict renderer " +
        "selection silently falls back to WebGL, which would let a WebGPU spec pass " +
        "against the wrong backend.",
    );
  }

  contextOptions.renderer = renderer;
  contextOptions.strictRenderer = true;

  // Mirror createScene's WebGL defaults so a `renderer: "webgl"` scene built
  // through this helper matches the synchronous one field for field.
  contextOptions.webgl = contextOptions.webgl ?? {};
  contextOptions.webgl.antialias = contextOptions.webgl.antialias ?? false;
  contextOptions.webgl.stencil = contextOptions.webgl.stencil ?? true;

  const scene = await Scene.createAsync(options);

  const resolved = scene.context.rendererType;
  if (resolved !== renderer) {
    // Destroy before throwing: an abandoned Scene holds a graphics context and,
    // on WebGPU, a pooled device lease that would outlive the failed spec.
    try {
      scene.destroy();
    } catch {
      // Preserve the backend-mismatch error; a destroy failure here would
      // otherwise replace the diagnosis with an unrelated teardown message.
    }
    if (!callerSuppliedCanvas) {
      document.body.removeChild(canvas);
    }
    throw new Error(
      `createSceneAsync requested renderer "${renderer}" but the context resolved ` +
        `"${resolved}". Strict renderer selection was requested, so this is a real ` +
        `backend mismatch and not a silent fallback.`,
    );
  }

  scene.highDynamicRange = false;

  if (
    scene.context.drawingBufferWidth <= 2 ||
    scene.context.drawingBufferHeight <= 2
  ) {
    scene.msaaSamples = 1;
  }

  if (!!window.webglValidation && !scene.context.isWebGPU) {
    const context = scene.context;
    context.validateShaderProgram = true;
    context.validateFramebuffer = true;
    context.logShaderCompilation = true;
    context.throwOnWebGLError = true;
  }

  // Add functions for test
  scene.destroyForSpecs = function () {
    const canvas = this.canvas;
    this.destroy();
    document.body.removeChild(canvas);
  };

  scene.renderForSpecs = function (time) {
    this.initializeFrame();
    this.render(time);
  };

  scene.pickForSpecs = function () {
    this.pick(new Cartesian2(0, 0));
  };

  scene.rethrowRenderErrors = options.rethrowRenderErrors ?? true;

  return scene;
}
export default createSceneAsync;
