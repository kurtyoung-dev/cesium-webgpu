// Empty shader stub used by the build-variant alias plugin.
//
// In a WebGPU-only build, every static `import FooFS from
// '../Shaders/FooFS.js'` is rewritten by `bundleVariantPlugin` to point at
// THIS file. The Scene/Renderer files that import these shader strings
// still resolve at module load (so no runtime crash), but the WebGL code
// path that would consume them is never reached because the WebGPU
// feature renderer intercepts first.
//
// The opposite stub for WebGPU-only modules is `emptyModule.js`.

export default "";
