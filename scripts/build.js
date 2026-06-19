// @ts-check

import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";
import { globby } from "globby";
// @ts-expect-error Types unavailable.
import glslStripComments from "glsl-strip-comments";
// @ts-expect-error Types unavailable for gulp v5.
import gulp from "gulp";
import { rimraf } from "rimraf";

import { bundleVariantPlugin } from "./bundleVariantPlugin.js";

import { mkdirp } from "mkdirp";
import assert from "node:assert";

// Determines the scope of the workspace packages. If the scope is set to cesium, the workspaces should be @cesium/engine.
// This should match the scope of the dependencies of the root level package.json.
const scope = "cesium";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");

export async function getVersion() {
  const data = await readFile(packageJsonPath, "utf8");
  const { version } = JSON.parse(data);
  return version;
}

async function getCopyrightHeader() {
  const copyrightHeaderTemplate = await readFile(
    path.join("Source", "copyrightHeader.js"),
    "utf8",
  );
  return copyrightHeaderTemplate.replace("${version}", await getVersion());
}

/** @param {string} token */
function escapeCharacters(token) {
  return token.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}

/**
 * @param {string} pragma
 * @param {boolean} exclusive
 */
function constructRegex(pragma, exclusive) {
  const prefix = exclusive ? "exclude" : "include";
  pragma = escapeCharacters(pragma);

  const s =
    `[\\t ]*\\/\\/>>\\s?${prefix}Start\\s?\\(\\s?(["'])${pragma}\\1\\s?,\\s?pragmas\\.${pragma}\\s?\\)\\s?;?` +
    // multiline code block
    `[\\s\\S]*?` +
    // end comment
    `[\\t ]*\\/\\/>>\\s?${prefix}End\\s?\\(\\s?(["'])${pragma}\\2\\s?\\)\\s?;?\\s?[\\t ]*\\n?`;

  return new RegExp(s, "gm");
}

/** @type {Record<string, boolean>} */
const pragmas = { debug: false };

/** @type {esbuild.Plugin} */
const stripPragmaPlugin = {
  name: "strip-pragmas",
  setup: (build) => {
    // Match .js AND .ts files so WebGPU TypeScript diagnostics wrapped in
    // pragma tags get stripped in production builds too. The regex
    // replacement is source-level (before TS→JS transpilation) so the
    // pragma comment syntax works identically in both languages.
    build.onLoad({ filter: /\.[jt]sx?$/ }, async (args) => {
      let source = await readFile(args.path, { encoding: "utf8" });

      try {
        for (const key in pragmas) {
          if (pragmas.hasOwnProperty(key)) {
            source = source.replace(constructRegex(key, pragmas[key]), "");
          }
        }

        // Tell esbuild which loader to use. Without an explicit `loader`
        // return value, esbuild *mostly* infers from `args.path`'s
        // extension — but when a `.js` import path resolves to a `.ts`
        // file via resolveExtensions, the path reported here is the
        // resolved TS path but some edges of esbuild's inference have
        // treated contents as JS and choked on `interface` / `enum`.
        // Explicit mapping removes the ambiguity.
        const ext = args.path.slice(args.path.lastIndexOf("."));
        /** @type {esbuild.Loader} */
        const loader =
          ext === ".ts"
            ? "ts"
            : ext === ".tsx"
              ? "tsx"
              : ext === ".jsx"
                ? "jsx"
                : "js";
        return { contents: source, loader };
      } catch (e) {
        return {
          errors: [{ text: /** @type {Error} */ (e).message }],
        };
      }
    });
  },
};

/**
 * Print an esbuild warning
 * @param {esbuild.Message} message
 */
function printBuildWarning({ location, text }) {
  assert(location, "Missing message.location.");
  const { column, file, line, lineText, suggestion } = location;

  let message = `\n
  > ${file}:${line}:${column}: warning: ${text}
  ${lineText}
  `;

  if (suggestion && suggestion !== "") {
    message += `\n${suggestion}`;
  }

  console.log(message);
}

/**
 * Ignore `eval` warnings in third-party code we don't have control over
 * @param {esbuild.BuildResult} result
 */
function handleBuildWarnings(result) {
  for (const warning of result.warnings) {
    if (!warning.location?.file.includes("protobufjs.js")) {
      printBuildWarning(warning);
    }
  }
}

/** @returns {Partial<esbuild.BuildOptions>} */
export const defaultESBuildOptions = () => {
  return {
    bundle: true,
    color: true,
    legalComments: `inline`,
    logLimit: 0,
    target: `es2020`,
    // Explicit loader map prevents the intermittent "Expected ')'" parse
    // failure when a generated entry re-exports a `.js`-spelled specifier
    // that resolves to a `.ts` file on disk. esbuild's extension inference
    // can race with stale generated entries from a prior variant build.
    loader: {
      ".ts": "ts",
      ".tsx": "tsx",
      ".js": "js",
      ".mjs": "js",
      ".cjs": "js",
      ".json": "json",
    },
  };
};

const inlineWorkerPath = "Build/InlineWorkers.js";

/**
 * @typedef {object} CesiumBundles
 * @property {object} esm The ESM bundle.
 * @property {object} iife The IIFE bundle, for use in browsers.
 * @property {esbuild.BuildResult|esbuild.BuildContext} [iifeWorkers] The IIFE worker bundle, for use in browsers.
 * @property {object} node The CommonJS bundle, for use in NodeJS.
 */

/**
 * Bundles all individual modules, optionally minifying and stripping out debug pragmas.
 * @param {object} options
 * @param {string} options.path Directory where build artifacts are output
 * @param {boolean} [options.minify=false] true if the output should be minified
 * @param {boolean} [options.removePragmas=false] true if the output should have debug pragmas stripped out
 * @param {boolean} [options.sourcemap=false] true if an external sourcemap should be generated
 * @param {boolean} [options.iife=false] true if an IIFE style module should be built
 * @param {boolean} [options.node=false] true if a CJS style node module should be built
 * @param {boolean} [options.incremental=false] true if build output should be cached for repeated builds
 * @param {boolean} [options.write=true] true if build output should be written to disk. If false, the files that would have been written as in-memory buffers
 * @param {BundleVariant} [options.variant="dual"] Build variant — see entryFileForVariant
 * @param {string} [options.entryPoint] Override entry file (defaults to variant's entry)
 * @param {boolean} [options.metafile=false] When true, write `metafile.json` next to the bundle for analyzeBuild.js
 * @param {boolean} [options.splitting=false] Enable ESM code splitting (chunks/ subdir). Disabled for dev builds.
 * @returns {Promise<CesiumBundles>}
 */
export async function bundleCesiumJs(options) {
  /** @type {BundleVariant} */
  const variant = options.variant ?? "dual";
  const entryPoint = options.entryPoint ?? entryFileForVariant(variant);

  const buildConfig = defaultESBuildOptions();
  buildConfig.entryPoints = [entryPoint];
  buildConfig.minify = options.minify;
  buildConfig.sourcemap = options.sourcemap;
  // Emit a metafile so `scripts/analyzeBuild.js` can identify top
  // contributors to the bundle without re-running the build. The file
  // is small (~few MB JSON) and only written when the caller explicitly
  // asks via `metafile: true` — buildAllVariants leaves it off by
  // default to avoid the disk-write overhead on the hot path.
  if (options.metafile) {
    buildConfig.metafile = true;
  }
  // Compose plugins: stripPragma (debug pragma removal in release) + the
  // variant alias plugin that redirects backend-specific imports to empty
  // stubs. The variant plugin returns null for "dual" so we filter falsy.
  /** @type {esbuild.Plugin[]} */
  const plugins = [];
  if (options.removePragmas) {
    plugins.push(stripPragmaPlugin);
  }
  const variantPlugin = bundleVariantPlugin(variant);
  if (variantPlugin) {
    plugins.push(variantPlugin);
  }
  buildConfig.plugins = plugins;
  buildConfig.write = options.write;
  buildConfig.banner = {
    js: await getCopyrightHeader(),
  };
  // print errors immediately, and collect warnings so we can filter out known ones
  buildConfig.logLevel = "info";

  /** @type {CesiumBundles} */
  const contexts = {};
  const incremental = options.incremental;
  const build = incremental ? esbuild.context : esbuild.build;

  // Build ESM. Code splitting is opt-in via `options.splitting` (default
  // false). When enabled, the dynamic `await import("./WebGPU/WebGPUContext.js")`
  // in ContextFactory creates a separate chunk that loads on demand. The
  // dual variant benefits the most: WebGPU code lives in its own chunk
  // and only downloads when the user actually picks WebGPU.
  //
  // Splitting is DISABLED for dev builds (`gulp build` / `npm run restart`)
  // because the dev server doesn't serve the chunk sub-directory correctly
  // (NS_ERROR_CORRUPTED_CONTENT on Firefox, MIME issues on some setups).
  // Release and variant builds enable it explicitly.
  //
  // When splitting is ON: output is outdir/index.js + outdir/chunks/*.js
  // When splitting is OFF: output is a single outdir/index.js (outfile)
  const useSplitting = options.splitting ?? false;
  /** @type {esbuild.BuildOptions} */
  const esmConfig = {
    ...buildConfig,
    format: /** @type {esbuild.Format} */ ("esm"),
  };
  if (useSplitting) {
    esmConfig.splitting = true;
    esmConfig.outdir = options.path;
    esmConfig.entryNames = "index";
    esmConfig.chunkNames = "chunks/[name]-[hash]";
  } else {
    esmConfig.outfile = path.join(options.path, "index.js");
  }
  const esm = await build(esmConfig);

  if (incremental) {
    contexts.esm = esm;
  } else {
    handleBuildWarnings(/** @type {esbuild.BuildResult} */ (esm));
  }

  // Persist the metafile alongside the bundle so analyzeBuild.js can
  // open it without re-bundling. Only the ESM build's metafile is kept
  // — the IIFE/CJS variants share the same module graph and would
  // overwrite each other anyway.
  if (options.metafile && !incremental) {
    const metafileResult = /** @type {esbuild.BuildResult} */ (esm);
    if (metafileResult.metafile) {
      await writeFile(
        path.join(options.path, "metafile.json"),
        JSON.stringify(metafileResult.metafile, null, 2),
        "utf8",
      );
    }
  }

  // Build IIFE
  if (options.iife) {
    const iifeWorkers = await bundleWorkers({
      iife: true,
      minify: options.minify,
      sourcemap: false,
      path: options.path,
      removePragmas: options.removePragmas,
      incremental: incremental,
      write: options.write,
    });

    const iife = await build({
      ...buildConfig,
      format: "iife",
      inject: [inlineWorkerPath],
      globalName: "Cesium",
      outfile: path.join(options.path, "Cesium.js"),
      logOverride: {
        "empty-import-meta": "silent",
      },
    });

    if (incremental) {
      contexts.iife = iife;
      contexts.iifeWorkers = /** @type {esbuild.BuildContext} */ (iifeWorkers);
    } else {
      handleBuildWarnings(/** @type {esbuild.BuildResult} */ (iife));
      rimraf.sync(inlineWorkerPath);
    }
  }

  if (options.node) {
    const node = await build({
      ...buildConfig,
      format: "cjs",
      platform: "node",
      logOverride: {
        "empty-import-meta": "silent",
      },
      define: {
        // TransformStream is a browser-only implementation depended on by zip.js
        TransformStream: "null",
      },
      outfile: path.join(options.path, "index.cjs"),
    });

    if (incremental) {
      contexts.node = node;
    } else {
      handleBuildWarnings(/** @type {esbuild.BuildResult} */ (node));
    }
  }

  return contexts;
}

/** @param {string} moduleId */
function filePathToModuleId(moduleId) {
  return moduleId.substring(0, moduleId.lastIndexOf(".")).replace(/\\/g, "/");
}

/** @typedef {'engine'|'widgets'} Workspace */

/** @type {Record<Workspace, string[]>} */
const workspaceSourceFiles = {
  engine: [
    "packages/engine/Source/**/*.js",
    "!packages/engine/Source/*.js",
    "!packages/engine/Source/Core/globalTypes.js",
    "!packages/engine/Source/Workers/**",
    "packages/engine/Source/Workers/createTaskProcessorWorker.js",
    "!packages/engine/Source/ThirdParty/Workers/**.js",
    "!packages/engine/Source/ThirdParty/google-earth-dbroot-parser.js",
    "!packages/engine/Source/ThirdParty/_*",
  ],
  widgets: ["packages/widgets/Source/**/*.js"],
};

/**
 * Generates export declaration from a file from a workspace.
 *
 * @param {string} workspace The workspace the file belongs to.
 * @param {string} file The file.
 * @returns {string} The export declaration.
 */
function generateDeclaration(workspace, file) {
  let assignmentName = path.basename(file, path.extname(file));

  let moduleId = file;
  moduleId = filePathToModuleId(moduleId);

  if (moduleId.indexOf("Source/Shaders") > -1) {
    // For WebGPU shaders, include parent directory to avoid name collisions
    if (moduleId.indexOf("Source/Shaders/WebGPU/") > -1) {
      const parts = moduleId.split("/");
      const parentDir = parts[parts.length - 2];
      if (parentDir !== "WebGPU" && parentDir !== "chunks") {
        assignmentName = `_shaders${parentDir}_${assignmentName}`;
      } else {
        assignmentName = `_shaders${assignmentName}`;
      }
    } else {
      assignmentName = `_shaders${assignmentName}`;
    }
  }
  assignmentName = assignmentName.replace(/(\.|-)/g, "_");
  return `export { ${assignmentName} } from '@${scope}/${workspace}';`;
}

/**
 * Returns true if a generated barrel file path should be excluded for the
 * given build variant. The variant filter only changes which entries are
 * exposed on the synthesized barrel — the actual size shrinkage comes
 * from `bundleVariantPlugin` aliasing imports to empty stubs at bundle
 * time. Filtering the barrel here is still useful because it removes the
 * `Cesium.<name>` global namespace entries that would otherwise point at
 * empty stubs (which would be confusing for users introspecting the API).
 *
 * @param {string} file Source file path
 * @param {BundleVariant} variant
 */
function shouldExcludeFromVariantBarrel(file, variant) {
  const p = file.replace(/\\/g, "/");
  if (variant === "webgpu-only") {
    // GLSL string modules under Source/Shaders/ (not under WebGPU/)
    return (
      p.includes("/Source/Shaders/") && !p.includes("/Source/Shaders/WebGPU/")
    );
  }
  if (variant === "webgl-only") {
    return (
      p.includes("/Source/Renderer/WebGPU/") ||
      p.includes("/Source/Shaders/WebGPU/")
    );
  }
  return false;
}

/** @typedef {"dual" | "webgl-only" | "webgpu-only"} BundleVariant */

/**
 * Maps a build variant to the source-side entry-point filename it
 * generates under `Source/`. The IIFE/ESM bundlers consume the file
 * at this path. The "dual" variant keeps the historical `Source/Cesium.js`
 * filename so existing build paths and downstream tooling don't break.
 *
 * @param {BundleVariant} variant
 */
function entryFileForVariant(variant) {
  switch (variant) {
    case "webgl-only":
      return "Source/CesiumWebGLOnly.js";
    case "webgpu-only":
      return "Source/CesiumWebGPUOnly.js";
    case "dual":
    default:
      return "Source/Cesium.js";
  }
}

/**
 * Creates a single entry point file (Source/Cesium.js or a variant-named
 * sibling), which imports all individual modules exported from the
 * Cesium API. The dual webgpu-first entry is the historical default;
 * webgl-only / webgpu-only variants exclude the irrelevant backend's
 * modules from the export list, and a `setGlobalDefaultRenderer` call
 * is appended so the runtime auto-selection picks the matching backend.
 *
 * @param {BundleVariant} [variant="dual"] Build variant
 * @returns {Promise<string>} contents
 */
export async function createCesiumJs(variant = "dual") {
  const version = await getVersion();
  let contents = `export const VERSION = '${version}';\n`;

  // Iterate over each workspace and generate declarations for each file.
  for (const workspace of Object.keys(workspaceSourceFiles)) {
    const files = await globby(
      workspaceSourceFiles[/** @type {Workspace} */ (workspace)],
    );
    const declarations = files
      .filter((file) => !shouldExcludeFromVariantBarrel(file, variant))
      .map((file) => generateDeclaration(workspace, file));
    contents += declarations.join(`${EOL}`);
    contents += "\n";
  }

  // Batch 142 — Slice 5d step 2 public API. LightTypes.ts defines the
  // multi-light classes (PointLight / SpotLight / LightCollection /
  // LightType) but the workspace `.js` glob doesn't pick up .ts files.
  // Re-export explicitly so users can do `new Cesium.PointLight(...)`
  // from the main bundle. Always-on (not variant-gated) — these
  // classes are backend-agnostic.
  //
  // The base `Light` class is intentionally NOT re-exported here — the
  // upstream `Scene/Light.js` already occupies that name and serves as
  // an abstract type marker. Users construct concrete subclasses; they
  // don't reference the base directly.
  contents +=
    `\n// Slice 5d step 2 — multi-light public API (Batch 142).\n` +
    `export { LightCollection, PointLight, SpotLight, LightType } from '@${scope}/engine/Source/Scene/LightTypes.js';\n`;
  // NOTE: the WebGPU cluster renderer + lighting re-exports (Slice 5d,
  // Batches 147–150) are now gated below with the other WebGPU-source
  // re-exports — they import from `index-wgsl.js` and are skipped for the
  // webgl-only variant (whose alias plugin strips Source/Renderer/WebGPU/* to
  // empty stubs, which would fail ESM's static named-re-export check).
  // (NEW-WEBGL-ONLY-CLUSTER-EXPORT-GATING.)

  // FORK-16: Re-export TypeScript-only WGSL preprocessor + library
  // surface that the .js glob in workspaceSourceFiles can't pick up.
  // The webgpu-only and dual variants both need it; webgl-only does
  // not because the WGSL preprocessor is dead code in that build.
  //
  // We import from `@cesium/engine/index-wgsl.js` rather than the main
  // `@cesium/engine` barrel so that the webgl-only bundle doesn't even
  // see the WebGPU-source re-exports in its module graph. That avoids
  // the esbuild "No matching export" error when the alias plugin
  // rewrites those paths to the empty-module stub in webgl-only mode.
  if (variant !== "webgl-only") {
    contents +=
      `\n// Slice 5d cluster renderer + lighting public API (Batches 147–150).\n` +
      `// Imported from index-wgsl.js (not the WebGPU source directly) so this\n` +
      `// block shares the same webgl-only gating as the WGSL re-exports below.\n` +
      `export { WebGPUClusterBoundsRenderer, CLUSTER_TILE_COUNT_X, CLUSTER_TILE_COUNT_Y, CLUSTER_SLICE_COUNT_Z, CLUSTER_TOTAL_COUNT, CLUSTER_BOUNDS_STORAGE_BYTES } from '@${scope}/engine/index-wgsl.js';\n` +
      `export { WebGPUClusterAssignRenderer, CLUSTER_MAX_LIGHTS, CLUSTER_MAX_LIGHTS_PER_CLUSTER, CLUSTER_LIGHT_STORAGE_BYTES, CLUSTER_LIGHT_COUNT_STORAGE_BYTES, CLUSTER_LIGHT_INDICES_STORAGE_BYTES } from '@${scope}/engine/index-wgsl.js';\n` +
      `export { WebGPUClusterDebugRenderer } from '@${scope}/engine/index-wgsl.js';\n` +
      `export { WebGPUClusteredLightingDispatcher } from '@${scope}/engine/index-wgsl.js';\n` +
      `\n// TypeScript-only WGSL preprocessor exports — needed by wgsl-import-test.html\n` +
      `export { WGSLShaderPreprocessor, WGSLShaderLibrary } from '@${scope}/engine/index-wgsl.js';\n` +
      `export { createDefaultWGSLLibrary, WGSLBuiltinChunks } from '@${scope}/engine/index-wgsl.js';\n` +
      // WebGL compat stub helpers live on index-wgsl.js too so apps
      // that register a shader translator or consume
      // extractPipelineStateFromStub don't have to reach into
      // private WebGPU/ paths. Same webgl-only gating as the WGSL
      // preprocessor above — webgl-only doesn't need the stub.
      `export { registerShaderTranslator, getActiveShaderTranslator, subscribeToShaderTranslatorChange, registerShaderPreprocessor, getActiveShaderPreprocessor, parseNagaReflection, buildBindGroupLayoutDescriptors, buildBindGroupLayoutsFromProgram, WGSLPassthroughTranslator, NotSupportedTranslator, NagaShaderTranslator, nagaTranspileGLSL, isNagaReady, isNagaUnavailable, extractPipelineStateFromStub, extractRenderPassStateFromStub, applyStubVariantToBuilder, getCompiledShaderForProgram } from '@${scope}/engine/index-wgsl.js';\n`;
  }

  // Append the runtime default-renderer hint so this entry's bundle picks
  // the right backend on first `Viewer({ contextOptions: { renderer: 'auto' } })`.
  // The dual entry leaves the default at WEBGPU (set by RendererType.ts);
  // we still emit the call explicitly so the intent is visible in source.
  const defaultRenderer = variant === "webgl-only" ? "WEBGL" : "WEBGPU";
  contents +=
    `\n// Build variant: ${variant} — set the runtime default renderer.\n` +
    `import { setGlobalDefaultRenderer, RendererType } from '@${scope}/engine';\n` +
    `setGlobalDefaultRenderer(RendererType.${defaultRenderer});\n`;

  const outFile = entryFileForVariant(variant);
  await writeFile(outFile, contents, { encoding: "utf-8" });

  return contents;
}

/**
 * Bundles all individual modules, optionally minifying and stripping out debug pragmas.
 * @param {object} options
 * @param {string} options.outputDirectory Directory where build artifacts are output
 * @param {string} options.entryPoint script to bundle
 * @param {boolean} [options.minify=false] true if the output should be minified
 * @param {boolean} [options.removePragmas=false] true if the output should have debug pragmas stripped out
 * @param {boolean} [options.sourcemap=false] true if an external sourcemap should be generated
 * @param {boolean} [options.incremental=false] true if build output should be cached for repeated builds
 * @param {boolean} [options.write=true] true if build output should be written to disk. If false, the files that would have been written as in-memory buffers
 */
export async function bundleIndexJs(options) {
  /** @type {esbuild.BuildOptions} */
  const buildConfig = {
    ...defaultESBuildOptions(),
    entryPoints: [options.entryPoint],
    minify: options.minify,
    sourcemap: options.sourcemap,
    plugins: options.removePragmas ? [stripPragmaPlugin] : undefined,
    write: options.write,
    banner: {
      js: await getCopyrightHeader(),
    },
    // print errors immediately, and collect warnings so we can filter out known ones
    logLevel: "info",
  };

  /** @type {CesiumBundles} */
  const contexts = {};
  const incremental = options.incremental ?? false;
  const build = incremental ? esbuild.context : esbuild.build;

  // Build ESM
  const esm = await build({
    ...buildConfig,
    format: "esm",
    outfile: path.join(options.outputDirectory, "index.js"),
    // NOTE: doing this requires an importmap defined in the browser but avoids multiple CesiumJS instances
    external: options.entryPoint.includes("engine") ? [] : ["@cesium/engine"],
  });

  if (incremental) {
    contexts.esm = esm;
  } else {
    handleBuildWarnings(/** @type {esbuild.BuildResult} */ (esm));
  }

  return contexts;
}

/** @type {Record<Workspace, string[]>} */
const workspaceSpecFiles = {
  engine: ["packages/engine/Specs/**/*Spec.js"],
  widgets: ["packages/widgets/Specs/**/*Spec.js"],
};

/**
 * Creates a single entry point file, Specs/SpecList.js, which imports all individual spec files.
 * @returns {Promise<string>} contents
 */
export async function createCombinedSpecList() {
  const version = await getVersion();
  let contents = `export const VERSION = '${version}';\n`;

  for (const workspace of Object.keys(workspaceSpecFiles)) {
    const files = await globby(
      workspaceSpecFiles[/** @type {Workspace} */ (workspace)],
    );
    for (const file of files) {
      contents += `import '../${file}';\n`;
    }
  }

  await writeFile(path.join("Specs", "SpecList.js"), contents, {
    encoding: "utf-8",
  });

  return contents;
}

/**
 * @param {object} options
 * @param {string} options.path output directory
 * @param {boolean} [options.iife=false] true if the worker output should be inlined into a top-level iife file, ie. in Cesium.js
 * @param {boolean} [options.minify=false] true if the worker output should be minified
 * @param {boolean} [options.removePragmas=false] true if debug pragma should be removed
 * @param {boolean} [options.sourcemap=false] true if an external sourcemap should be generated
 * @param {boolean} [options.incremental=false] true if build output should be cached for repeated builds
 * @param {boolean} [options.write=true] true if build output should be written to disk. If false, the files that would have been written as in-memory buffers
 */
export async function bundleWorkers(options) {
  // Copy ThirdParty workers
  const thirdPartyWorkers = await globby([
    "packages/engine/Source/ThirdParty/Workers/**.js",
    "!packages/engine/Source/ThirdParty/Workers/basis_transcoder.js",
  ]);

  const thirdPartyWorkerConfig = defaultESBuildOptions();
  thirdPartyWorkerConfig.bundle = false;
  thirdPartyWorkerConfig.entryPoints = thirdPartyWorkers;
  thirdPartyWorkerConfig.outdir = options.path;
  thirdPartyWorkerConfig.minify = options.minify;
  thirdPartyWorkerConfig.outbase = "packages/engine/Source";
  await esbuild.build(thirdPartyWorkerConfig);

  // Bundle Cesium workers
  const workers = await globby(["packages/engine/Source/Workers/**"]);
  const workerConfig = defaultESBuildOptions();
  workerConfig.bundle = true;
  workerConfig.external = ["fs", "path"];

  // ── IIFE-inline exclusion list ──────────────────────────────────────
  // Workers that dynamically import `@cesium/engine` (scene-in-worker
  // renderer threads) pull the ENTIRE engine into the worker bundle.
  // Inlining that bundle into the IIFE Cesium.js via base64 injection
  // doubled the main bundle's size in prior builds (6.8 MB → 13.3 MB
  // minified). Such workers also require `import.meta.url` at the call
  // site, which is undefined in IIFE context — so they aren't usable
  // from IIFE consumers anyway. We keep them as separate files in
  // `Build/<variant>/Workers/` (emitted by the non-IIFE pass) and
  // skip them in the base64-inline pass.
  const IIFE_WORKER_EXCLUDE_PATTERNS = [
    /RendererWorker\.js$/, // Scene-in-worker renderer thread entry
  ];
  /** @param {string} file */
  const isExcludedFromIIFE = (file) =>
    IIFE_WORKER_EXCLUDE_PATTERNS.some((re) =>
      re.test(file.replace(/\\/g, "/")),
    );

  if (options.iife) {
    let contents = ``;
    const files = (await globby(workers)).filter((f) => !isExcludedFromIIFE(f));
    const declarations = files.map((file) => {
      let assignmentName = path.basename(file, path.extname(file));
      assignmentName = assignmentName.replace(/(\.|-)/g, "_");
      return `export const ${assignmentName} = () => { import('./${file}'); };`;
    });
    contents += declarations.join(`${EOL}`);
    contents += "\n";

    workerConfig.globalName = "CesiumWorkers";
    workerConfig.format = "iife";
    workerConfig.stdin = {
      contents: contents,
      resolveDir: ".",
    };
    workerConfig.minify = options.minify;
    workerConfig.write = false;
    workerConfig.logOverride = {
      "empty-import-meta": "silent",
    };

    // Plugin: redirect excluded workers (e.g. RendererWorker) to an
    // empty stub in the IIFE worker bundle. The top-level exclusion
    // above only removes them from the stdin wrappers; esbuild still
    // pulls them in via `createGeometry`'s template-literal dynamic
    // imports (`import('./${name}.js')`), which esbuild resolves by
    // bundling every sibling. This plugin fires during resolve and
    // sends any RendererWorker candidate to the empty-shader stub,
    // dropping ~6 MB of transitively-pulled engine code.
    //
    // esbuild's template-literal dynamic import (e.g. `import(./${x}.js)`
    // in `createGeometry.js`) walks the directory and bundles every
    // matching sibling WITHOUT going through onResolve — so a filter on
    // the import path string never fires for those. We have to intercept
    // at `onLoad` instead, replacing the file contents with an empty
    // export before esbuild parses it.
    /** @type {esbuild.Plugin} */
    const excludeWorkerStubPlugin = {
      name: "cesium-exclude-iife-workers",
      setup(build) {
        build.onLoad({ filter: /RendererWorker\.js$/ }, () => ({
          contents: "export default {};\n",
          loader: "js",
        }));
      },
    };
    workerConfig.plugins = [excludeWorkerStubPlugin];
    if (options.removePragmas) {
      workerConfig.plugins.push(stripPragmaPlugin);
    }
  } else {
    workerConfig.format = "esm";
    workerConfig.splitting = true;
    workerConfig.banner = {
      js: await getCopyrightHeader(),
    };
    workerConfig.entryPoints = workers;
    workerConfig.outdir = path.join(options.path, "Workers");
    workerConfig.minify = options.minify;
    workerConfig.write = options.write;
    // Hash-orphan cleanup: esbuild's `splitting: true` mode emits
    // content-hashed chunk filenames (e.g. `WebGPUContext-2BFCGMXC.js`).
    // Each build with code changes produces new hashes; the old hash
    // files are NOT removed unless we clean the outdir first. Without
    // this cleanup, `Build/Workers/` accumulates duplicate WebGPUContext
    // copies forever — observed at 3.2 GB / 249 copies after enough
    // dev cycles. Skip when `options.write === false` (incremental
    // mode keeps results in memory and the user manages outdir).
    if (options.write !== false) {
      await rimraf(workerConfig.outdir);
    }
  }

  const incremental = options.incremental;
  const build = incremental ? esbuild.context : esbuild.build;

  if (!options.iife) {
    return build(workerConfig);
  }

  /**
   * if iife, write this output to it's own file in which the script content is exported
   * @param {esbuild.BuildResult} result
   */
  const writeInjectionCode = (result) => {
    assert(result.outputFiles, "Missing BuildResult.outputFiles");
    const bundle = result.outputFiles[0].contents;
    const base64 = Buffer.from(bundle).toString("base64");
    const contents = `globalThis.CESIUM_WORKERS = atob("${base64}");`;
    return writeFile(inlineWorkerPath, contents);
  };

  if (incremental) {
    const context = /** @type {esbuild.BuildContext} */ (
      await build(workerConfig)
    );
    const rebuild = context.rebuild;
    context.rebuild = async () => {
      const result = await rebuild();
      if (result) {
        await writeInjectionCode(result);
      }
      return result;
    };
    return context;
  }

  const result = await build(workerConfig);
  return writeInjectionCode(/** @type {esbuild.BuildResult} */ (result));
}

const shaderFiles = [
  "packages/engine/Source/Shaders/**/*.glsl",
  "packages/engine/Source/ThirdParty/Shaders/*.glsl",
];

const wgslShaderFiles = ["packages/engine/Source/Shaders/WebGPU/**/*.wgsl"];

/**
 * @param {boolean} minify
 * @param {string} minifyStateFilePath
 * @param {Workspace} workspace
 */
export async function glslToJavaScript(minify, minifyStateFilePath, workspace) {
  // Ensure the directory for the state file exists. On a fresh CI
  // checkout `Build/` does not exist yet; the original ordering ran
  // `wgslToJavaScript` first (which only reads this path), and the
  // bundle steps below were what eventually created `Build/`. Now
  // that `glslToJavaScript` runs before any bundler step (per the
  // gulpfile `build()` order so tsc can resolve the .js shader
  // imports), this function has to create its own parent dir or it
  // fails with ENOENT immediately on a clean checkout.
  await mkdirp(path.dirname(minifyStateFilePath));
  await writeFile(minifyStateFilePath, minify.toString());
  const minifyStateFileLastModified = existsSync(minifyStateFilePath)
    ? statSync(minifyStateFilePath).mtime.getTime()
    : 0;

  // collect all currently existing JS files into a set, later we will remove the ones
  // we still are using from the set, then delete any files remaining in the set.
  // EXCLUDE `Shaders/WebGPU/**/*.js` — those are WGSL-derived mirrors managed
  // by `wgslToJavaScript`. Without the exclusion, this function deletes them
  // as "leftovers" because no .glsl source corresponds to them, breaking the
  // bundle on every dev-server `glslToJavaScript` invocation triggered by a
  // .glsl edit.
  /** @type {Record<string, boolean>} */
  const leftOverJsFiles = {};

  const files = await globby([
    `packages/${workspace}/Source/Shaders/**/*.js`,
    `packages/${workspace}/Source/ThirdParty/Shaders/*.js`,
    `!packages/${workspace}/Source/Shaders/WebGPU/**/*.js`,
  ]);
  files.forEach(function (file) {
    leftOverJsFiles[path.normalize(file)] = true;
  });

  /** @type {string[]} */
  const builtinFunctions = [];
  /** @type {string[]} */
  const builtinConstants = [];
  /** @type {string[]} */
  const builtinStructs = [];

  const glslFiles = await globby(shaderFiles);
  await Promise.all(
    glslFiles.map(async function (glslFile) {
      glslFile = path.normalize(glslFile);
      const baseName = path.basename(glslFile, ".glsl");
      const jsFile = `${path.join(path.dirname(glslFile), baseName)}.js`;

      // identify built in functions, structs, and constants
      const baseDir = path.join(
        `packages/${workspace}/`,
        "Source",
        "Shaders",
        "Builtin",
      );
      if (
        glslFile.indexOf(path.normalize(path.join(baseDir, "Functions"))) === 0
      ) {
        builtinFunctions.push(baseName);
      } else if (
        glslFile.indexOf(path.normalize(path.join(baseDir, "Constants"))) === 0
      ) {
        builtinConstants.push(baseName);
      } else if (
        glslFile.indexOf(path.normalize(path.join(baseDir, "Structs"))) === 0
      ) {
        builtinStructs.push(baseName);
      }

      delete leftOverJsFiles[jsFile];

      const jsFileExists = existsSync(jsFile);
      const jsFileModified = jsFileExists
        ? statSync(jsFile).mtime.getTime()
        : 0;
      const glslFileModified = statSync(glslFile).mtime.getTime();

      if (
        jsFileExists &&
        jsFileModified > glslFileModified &&
        jsFileModified > minifyStateFileLastModified
      ) {
        return;
      }

      let contents = await readFile(glslFile, { encoding: "utf8" });
      contents = contents.replace(/\r\n/gm, "\n");

      let copyrightComments = "";
      const extractedCopyrightComments = contents.match(
        /\/\*\*(?:[^*\/]|\*(?!\/)|\n)*?@license(?:.|\n)*?\*\//gm,
      );
      if (extractedCopyrightComments) {
        copyrightComments = `${extractedCopyrightComments.join("\n")}\n`;
      }

      if (minify) {
        contents = glslStripComments(contents);
        contents = contents
          .replace(/\s+$/gm, "")
          .replace(/^\s+/gm, "")
          .replace(/\n+/gm, "\n");
        contents += "\n";
      }

      contents = contents.split('"').join('\\"').replace(/\n/gm, "\\n\\\n");
      contents = `${copyrightComments}\
//This file is automatically rebuilt by the Cesium build process.\n\
export default "${contents}";\n`;

      return writeFile(jsFile, contents);
    }),
  );

  // delete any left over JS files from old shaders
  Object.keys(leftOverJsFiles).forEach(function (filepath) {
    rimraf.sync(filepath);
  });

  /**
   * @param {typeof contents} contents
   * @param {string[]} builtins
   * @param {string} path
   */
  const generateBuiltinContents = function (contents, builtins, path) {
    for (let i = 0; i < builtins.length; i++) {
      const builtin = builtins[i];
      contents.imports.push(
        `import czm_${builtin} from './${path}/${builtin}.js'`,
      );
      contents.builtinLookup.push(`czm_${builtin} : ` + `czm_${builtin}`);
    }
  };

  //generate the JS file for Built-in GLSL Functions, Structs, and Constants
  const contents = {
    imports: /** @type {string[]} */ ([]),
    builtinLookup: /** @type {string[]} */ ([]),
  };
  generateBuiltinContents(contents, builtinConstants, "Constants");
  generateBuiltinContents(contents, builtinStructs, "Structs");
  generateBuiltinContents(contents, builtinFunctions, "Functions");

  const fileContents = `//This file is automatically rebuilt by the Cesium build process.\n${contents.imports.join(
    "\n",
  )}\n\nexport default {\n    ${contents.builtinLookup.join(",\n    ")}\n};\n`;

  return writeFile(
    path.join(
      `packages/${workspace}/`,
      "Source",
      "Shaders",
      "Builtin",
      "CzmBuiltins.js",
    ),
    fileContents,
  );
}

/**
 * Converts WGSL shader files to JavaScript modules, similar to glslToJavaScript.
 * Each .wgsl file becomes a .js module exporting its source as a string.
 * Also generates CsmBuiltins.js index for WebGPU shader chunks.
 * @param {boolean} minify
 * @param {string} minifyStateFilePath
 * @param {Workspace} workspace
 * @returns {Promise<void>}
 */
export async function wgslToJavaScript(minify, minifyStateFilePath, workspace) {
  const minifyStateFileLastModified = existsSync(minifyStateFilePath)
    ? statSync(minifyStateFilePath).mtime.getTime()
    : 0;

  /** @type {Record<string, boolean>} */
  const leftOverJsFiles = {};
  const existingJsFiles = await globby([
    `packages/${workspace}/Source/Shaders/WebGPU/**/*.js`,
  ]);
  existingJsFiles.forEach(function (file) {
    leftOverJsFiles[path.normalize(file)] = true;
  });

  /** @type {string[]} */
  const builtinFunctions = [];
  /** @type {string[]} */
  const builtinStructs = [];

  const wgslFiles = await globby(wgslShaderFiles);
  await Promise.all(
    wgslFiles.map(async function (wgslFile) {
      wgslFile = path.normalize(wgslFile);
      const baseName = path.basename(wgslFile, ".wgsl");
      const jsFile = `${path.join(path.dirname(wgslFile), baseName)}.js`;

      const chunkBase = path.join(
        `packages/${workspace}/`,
        "Source",
        "Shaders",
        "WebGPU",
        "chunks",
      );
      const funcDir = path.normalize(path.join(chunkBase, "functions"));
      const structDir = path.normalize(path.join(chunkBase, "structs"));

      if (wgslFile.indexOf(funcDir) === 0) {
        builtinFunctions.push(baseName);
      } else if (wgslFile.indexOf(structDir) === 0) {
        builtinStructs.push(baseName);
      }

      delete leftOverJsFiles[jsFile];

      const jsFileExists = existsSync(jsFile);
      const jsFileModified = jsFileExists
        ? statSync(jsFile).mtime.getTime()
        : 0;
      const wgslFileModified = statSync(wgslFile).mtime.getTime();

      if (
        jsFileExists &&
        jsFileModified > wgslFileModified &&
        jsFileModified > minifyStateFileLastModified
      ) {
        return;
      }

      let contents = await readFile(wgslFile, { encoding: "utf8" });
      contents = contents.replace(/\r\n/gm, "\n");

      if (minify) {
        contents = contents
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//gm, "");
        contents = contents
          .replace(/\s+$/gm, "")
          .replace(/^\s+/gm, "")
          .replace(/\n+/gm, "\n");
        contents += "\n";
      }

      contents = contents.split('"').join('\\"').replace(/\n/gm, "\\n\\\n");
      contents = `\
//This file is automatically rebuilt by the Cesium build process.\n\
export default "${contents}";\n`;

      return writeFile(jsFile, contents);
    }),
  );

  Object.keys(leftOverJsFiles).forEach(function (filepath) {
    rimraf.sync(filepath);
  });

  /** @type {string[]} */
  const builtinImports = [];
  /** @type {string[]} */
  const builtinLookup = [];

  builtinStructs.forEach((name) => {
    builtinImports.push(`import ${name} from './structs/${name}.js'`);
    builtinLookup.push(`${name} : ${name}`);
  });
  builtinFunctions.forEach((name) => {
    builtinImports.push(`import ${name} from './functions/${name}.js'`);
    builtinLookup.push(`${name} : ${name}`);
  });

  const builtinsContent = `\
//This file is automatically rebuilt by the Cesium build process.\n\
${builtinImports.join("\n")}\n\n\
export default {\n    ${builtinLookup.join(",\n    ")}\n};\n`;

  const chunksDir = path.join(
    `packages/${workspace}/`,
    "Source",
    "Shaders",
    "WebGPU",
    "chunks",
  );
  await mkdirp(chunksDir);
  return writeFile(path.join(chunksDir, "CsmBuiltins.js"), builtinsContent);
}

/** @type {esbuild.Plugin} */
const externalResolvePlugin = {
  name: "external-cesium",
  setup: (build) => {
    // In Specs, when we import files from the source files, we import
    // them from the index.js files. This plugin replaces those imports
    // with the IIFE Cesium.js bundle that's loaded in the browser
    // in SpecRunner.html.
    build.onResolve({ filter: new RegExp(`index\.js$`) }, () => {
      return {
        path: "Cesium",
        namespace: "external-cesium",
      };
    });

    build.onResolve({ filter: /@cesium/ }, () => {
      return {
        path: "Cesium",
        namespace: "external-cesium",
      };
    });

    build.onLoad(
      {
        filter: new RegExp(`^Cesium$`),
        namespace: "external-cesium",
      },
      () => {
        const contents = `module.exports = Cesium`;
        return {
          contents,
        };
      },
    );
  },
};

/** @typedef {{name: string, isNew: boolean, img?: string}} DemoObject */

/**
 * Helper function to copy files.
 *
 * @param {string[]} globs The file globs to be copied.
 * @param {string} destination The path to copy the files to.
 * @param {string} base The base path to omit from the globs when files are copied. Defaults to "".
 * @returns {Promise<NodeJS.ReadWriteStream>} A promise resolving to the stream.
 */
export async function copyFiles(globs, destination, base) {
  const stream = gulp
    .src(globs, { base: base ?? "", encoding: false })
    .pipe(gulp.dest(destination));

  await finished(stream);
  return stream;
}

/**
 * Copy assets from engine.
 *
 * @param {string} destination The path to copy files to.
 * @returns {Promise<void>} A promise that completes when all assets are copied to the destination.
 */
export async function copyEngineAssets(destination) {
  const engineStaticAssets = [
    "packages/engine/Source/**",
    "!packages/engine/Source/**/*.js",
    "!packages/engine/Source/**/*.ts",
    "!packages/engine/Source/**/*.glsl",
    "!packages/engine/Source/**/*.css",
    "!packages/engine/Source/**/*.md",
  ];

  await copyFiles(engineStaticAssets, destination, "packages/engine/Source");

  // Since the CesiumWidget was part of the Widgets folder, the files must be manually
  // copied over to the right directory.

  await copyFiles(
    ["packages/engine/Source/Widget/**", "!packages/engine/Source/Widget/*.js"],
    path.join(destination, "Widgets/CesiumWidget"),
    "packages/engine/Source/Widget",
  );
}

/**
 * Map a build variant name to the directory suffix used by `buildCesium`
 * (`Build/Cesium${suffix}` and `Build/Cesium${suffix}Unminified`).
 *
 * @param {BundleVariant} variant
 */
function variantDirSuffix(variant) {
  if (variant === "webgl-only") {
    return "WebGL";
  }
  if (variant === "webgpu-only") {
    return "WebGPU";
  }
  return "";
}

/**
 * Copy variant-independent build artifacts (Workers, ThirdParty, Widgets,
 * Assets, CSS) from one variant's output directory into another's. Used
 * by the `buildAllVariants` task to avoid rebuilding the same workers /
 * CSS / static assets for every variant — the dual variant builds them
 * once into `Build/Cesium{Unminified}/`, and the other variants pick up
 * the result instead of rerunning bundleWorkers, bundleCSS, etc.
 *
 * The bundle entry files themselves (`index.js`, `Cesium.js`, `index.cjs`,
 * and the `chunks/` directory) are deliberately NOT copied — those are
 * variant-specific and the variant build will have already produced them.
 *
 * Both the unminified and minified output dirs are mirrored.
 *
 * @param {BundleVariant} fromVariant The source variant (typically "dual")
 * @param {BundleVariant} toVariant   The destination variant
 */
export async function copyVariantSharedAssets(fromVariant, toVariant) {
  const fromSuffix = variantDirSuffix(fromVariant);
  const toSuffix = variantDirSuffix(toVariant);

  // Mirror both flavours of the build dir.
  for (const buildSuffix of ["", "Unminified"]) {
    const fromDir = path.join("Build", `Cesium${fromSuffix}${buildSuffix}`);
    const toDir = path.join("Build", `Cesium${toSuffix}${buildSuffix}`);

    if (!existsSync(fromDir)) {
      continue;
    }
    if (!existsSync(toDir)) {
      mkdirp.sync(toDir);
    }

    // Glob everything under fromDir EXCEPT the variant-specific bundle
    // entries. The exclusions cover ESM (index.js + sourcemap), IIFE
    // (Cesium.js + sourcemap), CJS (index.cjs + sourcemap), the split
    // chunks subdir, and the package.json shim that buildCesium writes
    // for CJS interop.
    const globs = [
      `${fromDir.replace(/\\/g, "/")}/**/*`,
      `!${fromDir.replace(/\\/g, "/")}/index.js`,
      `!${fromDir.replace(/\\/g, "/")}/index.js.map`,
      `!${fromDir.replace(/\\/g, "/")}/index.cjs`,
      `!${fromDir.replace(/\\/g, "/")}/index.cjs.map`,
      `!${fromDir.replace(/\\/g, "/")}/Cesium.js`,
      `!${fromDir.replace(/\\/g, "/")}/Cesium.js.map`,
      `!${fromDir.replace(/\\/g, "/")}/chunks/**`,
    ];

    await copyFiles(globs, toDir, fromDir);
  }
}

/**
 * Copy assets from widgets.
 *
 * @param {string} destination The path to copy files to.
 * @returns {Promise<void>} A promise that completes when all assets are copied to the destination.
 */
export async function copyWidgetsAssets(destination) {
  const widgetsStaticAssets = [
    "packages/widgets/Source/**",
    "!packages/widgets/Source/**/*.js",
    "!packages/widgets/Source/**/*.ts",
    "!packages/widgets/Source/**/*.css",
    "!packages/widgets/Source/**/*.glsl",
    "!packages/widgets/Source/**/*.md",
  ];

  await copyFiles(widgetsStaticAssets, destination, "packages/widgets/Source");
}

/**
 * Bundles spec files for testing in the browser and on the command line with karma.
 * @param {object} options
 * @param {boolean} [options.incremental=false] true if the build should be cached for repeated rebuilds
 * @param {boolean} [options.write=false] true if build output should be written to disk. If false, the files that would have been written as in-memory buffers
 * @returns {Promise<esbuild.BuildResult|esbuild.BuildContext>}
 */
export async function bundleCombinedSpecs(options) {
  options = options || {};

  const build = options.incremental ? esbuild.context : esbuild.build;

  return build({
    entryPoints: [
      "Specs/spec-main.js",
      "Specs/SpecList.js",
      "Specs/karma-main.js",
    ],
    bundle: true,
    format: "esm",
    sourcemap: true,
    outdir: path.join("Build", "Specs"),
    plugins: [externalResolvePlugin],
    write: options.write,
  });
}

/**
 * Bundles test worker in used specs.
 * @param {object} options
 * @param {boolean} [options.incremental=false] true if the build should be cached for repeated rebuilds
 * @param {boolean} [options.write=false] true if build output should be written to disk. If false, the files that would have been written as in-memory buffers
 * @returns {Promise<esbuild.BuildResult|esbuild.BuildContext>}
 */
export async function bundleTestWorkers(options) {
  options = options || {};

  const build = options.incremental ? esbuild.context : esbuild.build;

  const workers = await globby(["Specs/TestWorkers/**.js"]);
  return build({
    entryPoints: workers,
    bundle: true,
    format: "esm",
    sourcemap: true,
    outdir: path.join("Build", "Specs", "TestWorkers"),
    external: ["fs", "path"],
    write: options.write,
  });
}

/**
 * Creates the index.js for a package.
 *
 * @param {Workspace} workspace The workspace to create the index.js for.
 * @returns {Promise<string>}
 */
export async function createIndexJs(workspace) {
  const version = await getVersion();
  let contents = `globalThis.CESIUM_VERSION = "${version}";\n`;

  // Iterate over all provided source files for the workspace and export the assignment based on file name.
  const workspaceSources = workspaceSourceFiles[workspace];
  if (!workspaceSources) {
    throw new Error(`Unable to find source files for workspace: ${workspace}`);
  }

  const files = await globby(workspaceSources);
  files.forEach(function (file) {
    file = path.relative(`packages/${workspace}`, file);

    let moduleId = file;
    moduleId = filePathToModuleId(moduleId);

    // Rename shader files, such that ViewportQuadFS.glsl is exported as _shadersViewportQuadFS in JS.

    let assignmentName = path.basename(file, path.extname(file));
    if (moduleId.indexOf(`Source/Shaders/`) === 0) {
      // For WebGPU shaders that collide with WebGL shader names (e.g. FXAA),
      // include the parent directory in the export name to disambiguate.
      if (moduleId.indexOf(`Source/Shaders/WebGPU/`) === 0) {
        const parts = moduleId.split("/");
        const parentDir = parts[parts.length - 2]; // e.g. "PostProcess", "Advanced", etc.
        // Only add parent prefix if it would otherwise collide (i.e., the name
        // is not already unique). We prefix WebGPU sub-directory shaders.
        if (parentDir !== "WebGPU" && parentDir !== "chunks") {
          assignmentName = `_shaders${parentDir}_${assignmentName}`;
        } else {
          assignmentName = `_shaders${assignmentName}`;
        }
      } else {
        assignmentName = `_shaders${assignmentName}`;
      }
    }
    assignmentName = assignmentName.replace(/(\.|-)/g, "_");
    contents += `export { default as ${assignmentName} } from './${moduleId}.js';${EOL}`;
  });

  // Append re-exports for TypeScript-only public API that the file glob
  // above can't pick up (it only matches `.js`). Without this the build
  // variants can't call `setGlobalDefaultRenderer` from the entry barrel.
  //
  // IMPORTANT: we split these into "always-safe" (renderer-type / factory /
  // registry exports, which don't reach into WebGPU source) and "WebGPU-only"
  // (WGSL preprocessor + library). The WebGPU-only re-exports would crash a
  // webgl-only bundle because the alias plugin rewrites their source paths
  // to `emptyModule.js`, which has only a default export — esbuild then
  // can't find the NAMED exports referenced here. They're still safe for
  // the dual and webgpu-only variants, which do include the real WebGPU
  // modules in their graph.
  if (workspace === "engine") {
    contents +=
      `${EOL}// TypeScript-only re-exports — needed by build-variant entry points${EOL}` +
      `export { default as RendererType, setGlobalDefaultRenderer, getGlobalDefaultRenderer, getDefaultRendererType, isWebGPUSupported, isValidRendererType } from './Source/Renderer/RendererType.js';${EOL}` +
      `export { default as ContextFactory } from './Source/Renderer/ContextFactory.js';${EOL}` +
      `export { default as GraphicsContext } from './Source/Renderer/GraphicsContext.js';${EOL}` +
      `export { default as ContextRegistry } from './Source/Renderer/ContextRegistry.js';${EOL}` +
      // Batch 142 — Slice 5d step 2 multi-light public API.
      // LightTypes.ts defines PointLight / SpotLight / LightCollection /
      // LightType (the `Light` base class is intentionally NOT re-
      // exported under that name — the upstream `Scene/Light.js`
      // already occupies the slot as an abstract type marker). Users
      // construct concrete subclasses (PointLight / SpotLight /
      // DirectionalLight) via `scene.lights.add(...)`. Backend-agnostic
      // so always included regardless of variant.
      `export { LightCollection, PointLight, SpotLight, LightType } from './Source/Scene/LightTypes.js';${EOL}`;
    // NOTE: the WebGPU cluster renderer + lighting re-exports (Slice 5d,
    // Batches 147–150) used to live here in the MAIN index.js, but they
    // reference `Source/Renderer/WebGPU/*` which the webgl-only variant alias
    // plugin rewrites to the empty-module stub — and ESM's static named
    // re-export check then fails the whole webgl-only build ("No matching
    // export in emptyModule.js for WebGPUClusterBoundsRenderer", etc.). They
    // now live in `index-wgsl.js` below (the dual + webgpu-only entry barrels
    // import it; webgl-only deliberately does NOT), exactly like the WGSL
    // preprocessor + WebGL-compat-stub re-exports. (NEW-WEBGL-ONLY-CLUSTER-EXPORT-GATING.)

    // WGSL-adjacent re-exports live in a SEPARATE file (index-wgsl.js)
    // that the webgl-only variant entry barrel deliberately does NOT
    // import. Dual and webgpu-only variants import from here. This is
    // the right home for the WebGL compatibility stub helpers too —
    // they reference files under Source/Renderer/WebGPU/ (the
    // WebGLCompatibilityStub nexus + its per-domain sub-modules)
    // which the webgl-only variant's alias plugin strips to empty
    // stubs. ESM's static named-re-export check would fail if this
    // file were pulled into the webgl-only graph.
    // Emit PRETTIER-STABLE output (NEW-INDEXWGSL-CHURN, Batch 303): this file
    // is tracked + .prettierignore'd, but the commit hook's stash/restore had
    // left the committed copy in prettier's multi-line form while this emitter
    // produced the un-prettified single-line form — so `gulp build` re-dirtied
    // it every time. `prettierExport` reproduces prettier 3.x's exact wrapping
    // (multi-symbol → one symbol per indented line + trailing comma; single
    // symbol → one line; double-quoted module path) so the build output is
    // byte-identical to the committed copy and the churn stops at the source.
    // Keep this in sync with the repo prettier config if the print width changes.
    /**
     * @param {string[]} symbols
     * @param {string} modulePath
     * @returns {string}
     */
    const prettierExport = (symbols, modulePath) => {
      if (symbols.length === 1) {
        return `export { ${symbols[0]} } from "${modulePath}";${EOL}`;
      }
      const body = symbols
        .map((/** @type {string} */ s) => `  ${s},${EOL}`)
        .join("");
      return `export {${EOL}${body}} from "${modulePath}";${EOL}`;
    };
    // Assembled as an array + `.join("")` (not a `+`-chain) so eslint's
    // `prefer-template` rule stays satisfied — `prettierExport()` returns a
    // plain string, and concatenating a template literal with a plain-string
    // function call via `+` trips the rule.
    const wgslContents = [
      `// WebGPU cluster renderer + lighting re-exports (Slice 5d, Batches 147–150).${EOL}`,
      `// They reference Source/Renderer/WebGPU/* which the webgl-only variant strips${EOL}`,
      `// to empty stubs, so they live here (webgl-only does NOT import index-wgsl.js).${EOL}`,
      `// Exposed so the cluster probes + the Clustered Lighting Sandcastle can${EOL}`,
      `// construct + dispatch the renderers standalone. (NEW-WEBGL-ONLY-CLUSTER-EXPORT-GATING.)${EOL}`,
      prettierExport(
        [
          "WebGPUClusterBoundsRenderer",
          "CLUSTER_TILE_COUNT_X",
          "CLUSTER_TILE_COUNT_Y",
          "CLUSTER_SLICE_COUNT_Z",
          "CLUSTER_TOTAL_COUNT",
          "CLUSTER_BOUNDS_STORAGE_BYTES",
        ],
        "./Source/Renderer/WebGPU/WebGPUClusterBoundsRenderer.js",
      ),
      prettierExport(
        [
          "WebGPUClusterAssignRenderer",
          "CLUSTER_MAX_LIGHTS",
          "CLUSTER_MAX_LIGHTS_PER_CLUSTER",
          "CLUSTER_LIGHT_STORAGE_BYTES",
          "CLUSTER_LIGHT_COUNT_STORAGE_BYTES",
          "CLUSTER_LIGHT_INDICES_STORAGE_BYTES",
        ],
        "./Source/Renderer/WebGPU/WebGPUClusterAssignRenderer.js",
      ),
      prettierExport(
        ["WebGPUClusterDebugRenderer"],
        "./Source/Renderer/WebGPU/WebGPUClusterDebugRenderer.js",
      ),
      prettierExport(
        ["WebGPUClusteredLightingDispatcher"],
        "./Source/Renderer/WebGPU/WebGPUClusteredLightingDispatcher.js",
      ),
      `${EOL}// TypeScript-only WGSL preprocessor exports — for wgsl-import-test.html${EOL}`,
      prettierExport(
        ["WGSLShaderPreprocessor", "WGSLShaderLibrary"],
        "./Source/Renderer/WebGPU/WGSLShaderPreprocessor.js",
      ),
      prettierExport(
        ["createDefaultWGSLLibrary", "WGSLBuiltinChunks"],
        "./Source/Renderer/WebGPU/WGSLBuiltins.js",
      ),
      // WebGL compatibility stub helpers — apps on the dual or
      // webgpu-only variant can register a shader translator
      // (naga-wasm adapter, etc.) and build pipelines from tracked
      // gl.* state without reaching into the WebGPU renderer's
      // private directory structure.
      `${EOL}// WebGL compatibility stub — translator registry + pipeline extractor${EOL}`,
      prettierExport(
        [
          "registerShaderTranslator",
          "getActiveShaderTranslator",
          "subscribeToShaderTranslatorChange",
          "registerShaderPreprocessor",
          "getActiveShaderPreprocessor",
          "parseNagaReflection",
          "buildBindGroupLayoutDescriptors",
          "buildBindGroupLayoutsFromProgram",
          "WGSLPassthroughTranslator",
          "NotSupportedTranslator",
          "NagaShaderTranslator",
          "nagaTranspileGLSL",
          "isNagaReady",
          "isNagaUnavailable",
          "extractPipelineStateFromStub",
          "extractRenderPassStateFromStub",
          "applyStubVariantToBuilder",
          "getCompiledShaderForProgram",
        ],
        "./Source/Renderer/WebGPU/WebGLCompatibilityStub.js",
      ),
    ].join("");
    await writeFile(`packages/${workspace}/index-wgsl.js`, wgslContents, {
      encoding: "utf-8",
    });
  }

  await writeFile(`packages/${workspace}/index.js`, contents, {
    encoding: "utf-8",
  });

  return contents;
}

/**
 * Creates a single entry point file by importing all individual spec files.
 * @param {string[]} files The individual spec files.
 * @param {Workspace} workspace The workspace.
 * @param {string} outputPath The path the file is written to.
 * @returns {Promise<string>}
 */
async function createSpecListForWorkspace(files, workspace, outputPath) {
  let contents = "";
  files.forEach(function (file) {
    contents += `import './${filePathToModuleId(file).replace(
      `packages/${workspace}/Specs/`,
      "",
    )}.js';\n`;
  });

  await writeFile(outputPath, contents, {
    encoding: "utf-8",
  });

  return contents;
}

/**
 * Bundles CSS files.
 *
 * @param {object} options
 * @param {string[]} options.filePaths The file paths to bundle.
 * @param {boolean} [options.sourcemap]
 * @param {boolean} [options.minify]
 * @param {string} options.outdir The output directory.
 * @param {string} options.outbase The
 */
async function bundleCSS(options) {
  // Configure options for esbuild.
  const esBuildOptions = defaultESBuildOptions();
  esBuildOptions.entryPoints = await globby(options.filePaths);
  esBuildOptions.loader = {
    ".gif": "text",
    ".png": "text",
  };
  esBuildOptions.sourcemap = options.sourcemap;
  esBuildOptions.minify = options.minify;
  esBuildOptions.outdir = options.outdir;
  esBuildOptions.outbase = options.outbase;

  await esbuild.build(esBuildOptions);
}

const workspaceCssFiles = {
  engine: ["packages/engine/Source/**/*.css"],
  widgets: ["packages/widgets/Source/**/*.css"],
};

/**
 * Bundles spec files for testing in the browser.
 *
 * @param {object} options
 * @param {boolean} [options.incremental=false] True if builds should be generated incrementally.
 * @param {string} options.outbase The base path the output files are relative to.
 * @param {string} options.outdir The directory to place the output in.
 * @param {string} options.specListFile The path to the SpecList.js file
 * @param {boolean} [options.write=true] True if bundles generated are written to files instead of in-memory buffers.
 * @returns {Promise<esbuild.BuildResult|esbuild.BuildContext>} The bundle generated from Specs.
 */
async function bundleSpecs(options) {
  const incremental = options.incremental ?? true;
  const write = options.write ?? true;

  /** @type {esbuild.BuildOptions} */
  const buildOptions = {
    bundle: true,
    format: "esm",
    outdir: options.outdir,
    sourcemap: true,
    target: "es2020",
    write: write,
  };

  const build = incremental ? esbuild.context : esbuild.build;

  // When bundling specs for a workspace, the spec-main.js and karma-main.js
  // are bundled separately since they use a different outbase than the workspace's SpecList.js.
  await build({
    ...buildOptions,
    entryPoints: ["Specs/spec-main.js", "Specs/karma-main.js"],
  });

  return build({
    ...buildOptions,
    entryPoints: [options.specListFile],
    outbase: options.outbase,
  });
}

/**
 * Builds the engine workspace.
 *
 * @param {object} options
 * @param {boolean} [options.incremental=false] True if builds should be generated incrementally.
 * @param {boolean} [options.minify=false] True if bundles should be minified.
 * @param {boolean} [options.write=true] True if bundles generated are written to files instead of in-memory buffers.
 */
export const buildEngine = async (options) => {
  options = options || {};

  const incremental = options.incremental ?? false;
  const minify = options.minify ?? false;
  const write = options.write ?? true;

  // Create Build folder to place build artifacts.
  mkdirp.sync("packages/engine/Build");

  // Convert GLSL files to JavaScript modules.
  await glslToJavaScript(
    minify,
    "packages/engine/Build/minifyShaders.state",
    "engine",
  );

  // Convert WGSL files to JavaScript modules.
  await wgslToJavaScript(
    minify,
    "packages/engine/Build/minifyShaders.state",
    "engine",
  );

  // Create index.js
  await createIndexJs("engine");

  const contexts = await bundleIndexJs({
    minify: minify,
    incremental: incremental,
    sourcemap: true,
    removePragmas: false,
    outputDirectory: path.join(
      `packages/engine/Build`,
      `${!minify ? "Unminified" : "Minified"}`,
    ),
    write: write,
    entryPoint: `packages/engine/index.js`,
  });

  // Build workers.
  await bundleWorkers({
    ...options,
    iife: false,
    path: "packages/engine/Build",
  });

  // Create SpecList.js
  const specFiles = await globby(workspaceSpecFiles["engine"]);
  const specListFile = path.join("packages/engine/Specs", "SpecList.js");
  await createSpecListForWorkspace(specFiles, "engine", specListFile);

  await bundleSpecs({
    incremental: incremental,
    outbase: "packages/engine/Specs",
    outdir: "packages/engine/Build/Specs",
    specListFile: specListFile,
    write: write,
  });

  return contexts;
};

/**
 * Builds the widgets workspace.
 *
 * @param {object} options
 * @param {boolean} [options.incremental=false] True if builds should be generated incrementally.
 * @param {boolean} [options.minify=false] True if bundles should be minified.
 * @param {boolean} [options.write=true] True if bundles generated are written to files instead of in-memory buffers.
 */
export const buildWidgets = async (options) => {
  options = options || {};

  const incremental = options.incremental ?? false;
  const minify = options.minify ?? false;
  const write = options.write ?? true;

  // Generate Build folder to place build artifacts.
  mkdirp.sync("packages/widgets/Build");

  // Create index.js
  await createIndexJs("widgets");

  const contexts = await bundleIndexJs({
    minify: minify,
    incremental: incremental,
    sourcemap: true,
    removePragmas: false,
    outputDirectory: path.join(
      `packages/widgets/Build`,
      `${!minify ? "Unminified" : "Minified"}`,
    ),
    write: write,
    entryPoint: `packages/widgets/index.js`,
  });

  // Create SpecList.js
  const specFiles = await globby(workspaceSpecFiles["widgets"]);
  const specListFile = path.join("packages/widgets/Specs", "SpecList.js");
  await createSpecListForWorkspace(specFiles, "widgets", specListFile);

  await bundleSpecs({
    incremental: incremental,
    outbase: "packages/widgets/Specs",
    outdir: "packages/widgets/Build/Specs",
    specListFile: specListFile,
    write: write,
  });

  return contexts;
};

/**
 * Build CesiumJS.
 *
 * @param {object} options
 * @param {boolean} [options.development=true] True if build is targeted for development.
 * @param {boolean} [options.iife=true] True if IIFE bundle should be generated.
 * @param {boolean} [options.incremental=true] True if builds should be generated incrementally.
 * @param {boolean} [options.minify=false] True if bundles should be minified.
 * @param {boolean} [options.node=true] True if CommonJS bundle should be generated.
 * @param {string} options.outputDirectory The directory where the output should go.
 * @param {boolean} [options.removePragmas=false] True if debug pragmas should be removed.
 * @param {boolean} [options.sourcemap=true] True if sourcemap should be included in the generated bundles.
 * @param {boolean} [options.write=true] True if bundles generated are written to files instead of in-memory buffers.
 * @param {BundleVariant} [options.variant="dual"] Which backend variant to bundle.
 * @param {boolean} [options.skipSharedAssets=false] When true, skips workers/CSS/specs/static-asset rebuilds — used by `buildAllVariants` after the dual variant has populated the shared output dirs.
 * @param {boolean} [options.metafile=false] When true, esbuild emits `metafile.json` next to the ESM bundle for use with `scripts/analyzeBuild.js`.
 */
export async function buildCesium(options) {
  const development = options.development ?? true;
  /** @type {BundleVariant} */
  const variant = options.variant ?? "dual";
  // The non-dual variants exist to feed tree-shaking-aware bundlers
  // IIFE / global-namespace bundle is built for every variant by
  // default because CDN consumers that use `<script src=...>`
  // benefit from the variant-specific tree-shaking (e.g.
  // `CesiumWebGPU.js` skips GLSL shaders). Caller can still force
  // it off explicitly if producing ESM-only distributions.
  const iife = options.iife ?? true;
  const incremental = options.incremental ?? false;
  const minify = options.minify ?? false;
  const node = options.node ?? true;
  const removePragmas = options.removePragmas ?? false;
  const sourcemap = options.sourcemap ?? true;
  const write = options.write ?? true;
  // When `buildAllVariants` runs the dual variant first, the variant-
  // independent steps (CSS bundle, workers, specs, static assets) are
  // already on disk under `Build/Cesium{Unminified}/`. Subsequent
  // variant builds set this flag so they only do the work that DEPENDS
  // on the variant — namely the consolidated JS bundle — and the
  // gulp task copies the shared output dirs after.
  const skipSharedAssets = options.skipSharedAssets ?? false;

  // Generate Build folder to place build artifacts.
  mkdirp.sync("Build");

  // Each variant gets its own output directory under Build/, so the
  // four bundles can coexist and be compared side-by-side. The historical
  // `Build/Cesium` / `Build/CesiumUnminified` paths are reserved for the
  // dual (default) variant so existing tooling and downstream consumers
  // don't break.
  const variantDirSuffix =
    variant === "webgl-only"
      ? "WebGL"
      : variant === "webgpu-only"
        ? "WebGPU"
        : "";
  const outputDirectory =
    options.outputDirectory ??
    path.join(
      "Build",
      `Cesium${variantDirSuffix}${!minify ? "Unminified" : ""}`,
    );
  rimraf.sync(outputDirectory);

  await writeFile(
    "Build/package.json",
    JSON.stringify({
      type: "commonjs",
    }),
    "utf8",
  );

  // Create the variant-specific entry barrel under Source/. The dual
  // variant continues to write `Source/Cesium.js`; the others write
  // sibling files (CesiumWebGLOnly.js / CesiumWebGPUOnly.js).
  await createCesiumJs(variant);

  // Create SpecList.js — variant-independent.
  if (!skipSharedAssets) {
    await createCombinedSpecList();

    // Bundle ThirdParty files.
    await bundleCSS({
      filePaths: [
        "packages/engine/Source/ThirdParty/google-earth-dbroot-parser.js",
      ],
      minify: minify,
      sourcemap: sourcemap,
      outdir: outputDirectory,
      outbase: "packages/engine/Source",
    });

    // Bundle CSS files.
    await bundleCSS({
      filePaths: workspaceCssFiles[`engine`],
      outdir: path.join(outputDirectory, "Widgets/CesiumWidget"),
      outbase: "packages/engine/Source/Widget",
    });
    await bundleCSS({
      filePaths: workspaceCssFiles[`widgets`],
      outdir: path.join(outputDirectory, "Widgets"),
      outbase: "packages/widgets/Source",
    });
  }

  // Workers are also variant-independent — the WGSL/GLSL split has no
  // bearing on terrain workers, polygon tessellation, etc.
  // `bundleWorkers` returns either a build context, a build result, or
  // void (the void path is the IIFE branch which writes the inline
  // worker file directly), so we use `any` rather than re-deriving the
  // union here.
  /** @type {any} */
  let workersContext = null;
  if (!skipSharedAssets) {
    workersContext = await bundleWorkers({
      iife: false,
      minify: minify,
      sourcemap: sourcemap,
      path: outputDirectory,
      removePragmas: removePragmas,
      incremental: incremental,
      write: write,
    });
  }

  // Generate bundles. The variant flows through bundleCesiumJs so the
  // alias plugin can rewrite backend-specific imports to empty stubs.
  // Code splitting is enabled for release builds (minify=true) and
  // variant builds (non-dual), but NOT for dev builds (npm run restart)
  // because the dev server can't serve the chunk sub-directory.
  const useSplitting = !development || variant !== "dual";
  const contexts = await bundleCesiumJs({
    minify: minify,
    iife: iife,
    incremental: incremental,
    sourcemap: sourcemap,
    removePragmas: removePragmas,
    path: outputDirectory,
    node: node,
    write: write,
    variant: variant,
    entryPoint: entryFileForVariant(variant),
    metafile: options.metafile,
    splitting: useSplitting,
  });

  /** @type {esbuild.BuildResult | esbuild.BuildContext | null} */
  let specsContext = null;
  /** @type {esbuild.BuildResult | esbuild.BuildContext | null} */
  let testWorkersContext = null;

  if (!skipSharedAssets) {
    // Generate Specs bundle.
    specsContext = await bundleCombinedSpecs({
      incremental: incremental,
      write: write,
    });

    testWorkersContext = await bundleTestWorkers({
      incremental: incremental,
      write: write,
    });

    // Copy static assets to the Build folder.

    await copyEngineAssets(outputDirectory);
    await copyWidgetsAssets(path.join(outputDirectory, "Widgets"));

    // Copy static assets to Source folder. These targets are
    // truly variant-independent (`Source/`, not `Build/`) so they only
    // need to run once across the whole multi-variant pipeline.

    await copyEngineAssets("Source");
    await copyFiles(
      ["packages/engine/Source/ThirdParty/**/*.js"],
      "Source/ThirdParty",
      "packages/engine/Source/ThirdParty",
    );

    await copyWidgetsAssets("Source/Widgets");
    await copyFiles(
      ["packages/widgets/Source/**/*.css"],
      "Source/Widgets",
      "packages/widgets/Source",
    );

    // WORKAROUND:
    // Since CesiumWidget was originally part of the Widgets folder, we need
    // to fix up any references to it when we put it back in the Widgets
    // folder, as expected by the combined CesiumJS structure.
    const widgetsCssBuffer = await readFile("Source/Widgets/widgets.css");
    const widgetsCssContents = widgetsCssBuffer
      .toString()
      .replace("../../engine/Source/Widget", "./CesiumWidget");
    await writeFile("Source/Widgets/widgets.css", widgetsCssContents);

    const lighterCssBuffer = await readFile("Source/Widgets/lighter.css");
    const lighterCssContents = lighterCssBuffer
      .toString()
      .replace("../../engine/Source/Widget", "./CesiumWidget");
    await writeFile("Source/Widgets/lighter.css", lighterCssContents);
  }

  return {
    esm: contexts.esm,
    iife: contexts.iife,
    iifeWorkers: contexts.iifeWorkers,
    node: contexts.node,
    specs: specsContext,
    workers: workersContext,
    testWorkers: testWorkersContext,
  };
}
