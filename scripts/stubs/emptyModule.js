// Empty module stub used by the build-variant alias plugin.
//
// In a WebGL-only build, files under `Source/Renderer/WebGPU/` and
// `Source/Shaders/WebGPU/` are rewritten to point at this file. The
// dynamic `await import("./WebGPU/WebGPUContext.js")` in `ContextFactory`
// resolves to a no-op module that throws if anyone actually tries to
// instantiate WebGPU — which they shouldn't, because the WebGL-only
// build aliases RendererBuildCapabilities to disable WebGPU selection.
//
// We export both a default and named accessors so the various import
// shapes used across the codebase all see SOMETHING. Anything trying to
// `new WebGPUContext()` against this stub trips the explicit error
// instead of failing inscrutably with `undefined is not a constructor`.

function _stubThrow() {
  throw new Error(
    "[CesiumJS] WebGPU code was reached in a WebGL-only build. " +
      "Either pick the dual or webgpu-only build, or set " +
      "contextOptions.renderer = 'webgl' to keep the WebGL path.",
  );
}

const _stub = new Proxy(
  // Use a function as the proxy target so callers that try to invoke or
  // construct it (the most common pattern) hit our explicit error.
  function _StubModule() {
    _stubThrow();
  },
  {
    get(_target, prop) {
      void _target;
      // Allow common module-introspection properties to read as undefined
      // without throwing — those happen at module-load time.
      if (
        prop === "__esModule" ||
        prop === Symbol.toStringTag ||
        prop === "then" // Promise interop probe
      ) {
        return undefined;
      }
      return _stubThrow;
    },
    construct() {
      _stubThrow();
      return {};
    },
    apply() {
      _stubThrow();
    },
  },
);

export default _stub;
