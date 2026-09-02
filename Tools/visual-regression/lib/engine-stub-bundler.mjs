// engine-stub-bundler.mjs — bundles one engine module with a named allowlist
// of real dependencies and a Proxy stub for everything else, so a spec can
// drive real engine code in Node without a browser, a device or a build.
//
// @purpose Bundles an engine entry module through esbuild with a named allowlist kept real and every other import stubbed, so specs can execute real engine code under fakes.
// @status ACTIVE
//
// The stub is an ES module exporting a Proxy per binding its importer asked
// for. A CommonJS proxy is not usable: esbuild's interop materialises a
// namespace by copying the module's OWN property names, and a Proxy has none,
// so every named import would arrive undefined.
//
// Three specs import this file. Two use `bundle`:
// `globe-cold-start-readiness.spec.mjs` and `globe-pipeline-prewarm.spec.mjs`,
// and for those two sharing keeps their stubbing identical - both build real
// pipeline-cache keys, and a divergence in what each stubs would leave one
// spec asserting a key shape the other, and the runtime, does not produce.
// The third, `webgpu-pick-emission-counters.spec.mjs`, imports only
// `mutateOrFail`. Sharing does not unify module graphs: each `bundle` call on
// a different entry source yields its own copy of the engine modules, so a
// key from one spec is never comparable with a key from the other. A spec
// that needs its warm and its request to share one module cache gets that by
// bundling both through a single entry, not from this file.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

// A stub module exports a Proxy for every binding its importer takes from it.
// A CommonJS proxy is not usable: esbuild's interop materialises a namespace by
// copying the module's OWN property names, and a proxy has none, so every named
// import would arrive undefined.
export const MAKE = [
  "const make = () =>",
  "  new Proxy(function () {}, {",
  "    get: (t, k) => (typeof k === 'symbol' ? undefined : make()),",
  "    apply: () => make(),",
  "    construct: () => make(),",
  "  });",
].join("\n");

/**
 * Maps each imported specifier in a source file to the binding names taken
 * from it, so a stub declares exactly what its importer asks for.
 *
 * @param {string} source Module source.
 * @returns {Map<string, {names: Set<string>, hasDefault: boolean}>} The map.
 */
export function scanImports(source) {
  const imports = new Map();
  // Anchored to the start of a line: these engine files carry prose comments
  // containing the word "import", and an unanchored match runs from inside a
  // comment to the next real specifier, inventing binding names the stub then
  // fails to export.
  const pattern = /^import\b([\s\S]*?)from\s*"([^"]+)"\s*;/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, rawClause, specifier] = match;
    const clause = rawClause.replace(/^\s*type\s+/, "").trim();
    const entry = imports.get(specifier) ?? {
      names: new Set(),
      hasDefault: false,
    };
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const name = part.replace(/^\s*type\s+/, "").trim();
        if (name.length === 0) {
          continue;
        }
        const exported = name.split(/\s+as\s+/)[0].trim();
        if (exported === "default") {
          entry.hasDefault = true;
        } else {
          entry.names.add(exported);
        }
      }
    }
    const defaultBinding = clause.split("{")[0].replace(/,\s*$/, "").trim();
    if (defaultBinding.length > 0) {
      entry.hasDefault = true;
    }
    imports.set(specifier, entry);
  }
  return imports;
}

/**
 * The basename of a module path with its extension dropped, so an allowlist
 * written against `Foo.ts` matches the `./Foo.js` specifier that imports it.
 *
 * @param {string} path A module path or specifier.
 * @returns {string} The extensionless basename.
 */
export function stem(path) {
  return path
    .split(/[\\/]/)
    .pop()
    .replace(/\.(ts|js|mjs)$/, "");
}

/**
 * Folds one scan of imports into the running map, so a stub declares the
 * union of every binding any importer in the graph takes from that specifier.
 *
 * @param {Map} into The running map.
 * @param {Map} scanned One file's scan.
 */
function mergeImports(into, scanned) {
  for (const [specifier, entry] of scanned) {
    const existing = into.get(specifier);
    if (existing) {
      for (const name of entry.names) {
        existing.names.add(name);
      }
    } else {
      into.set(specifier, entry);
    }
  }
}

/**
 * Applies a rewrite and refuses to continue if it changed nothing.
 *
 * @param {string} original The source to rewrite.
 * @param {Function} rewrite The rewrite.
 * @param {string} name The mutation's name.
 * @returns {string} The rewritten source.
 */
export function mutateOrFail(original, rewrite, name) {
  const rewritten = rewrite(original);
  assert.notEqual(
    rewritten,
    original,
    `the ${name} mutation changed nothing — its anchor text has moved, so ` +
      `this mutation test would pass vacuously and the result it exists to ` +
      `falsify would be unfalsifiable`,
  );
  return rewritten;
}

/**
 * Bundles one entry module, keeping a named allowlist of dependencies real and
 * stubbing every other import, optionally through a source mutation.
 *
 * @param {object} options Bundle options.
 * @param {string} options.path Entry module path.
 * @param {string} options.source Entry module source, LF-normalised.
 * @param {string[]} options.real Basenames kept real, resolved normally.
 * @param {string} [options.realDir] Absolute directory whose contents are all
 *   kept real. Used for `Core/`, where the module under test is a pure
 *   computation over a dozen dependency-free math modules and stubbing them
 *   would replace the computation with Proxies.
 * @param {Function} [options.mutate] Source rewrite.
 * @param {string} [options.label] Name used in the did-it-change assertion.
 * @param {string[]} [options.preseed] Absolute paths whose imports are folded
 *   into the stub map before the build starts. esbuild resolves in parallel,
 *   so a stub can be materialised before the real file that imports the most
 *   from it has been loaded; naming those files here removes the ordering
 *   dependency instead of leaving it to luck.
 * @param {Array} [options.overrides] Rewrites applied to a REAL dependency
 *   rather than to the entry, as `{basename, mutate, label}`. Each carries the
 *   same did-it-change assertion, so a moved anchor fails loudly instead of
 *   producing a mutation test that passes vacuously.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
export async function bundle({
  path,
  source,
  real,
  realDir,
  mutate,
  label,
  overrides = [],
  preseed = [],
}) {
  let text = source;
  if (mutate) {
    text = mutateOrFail(source, mutate, label);
  }
  const resolveDir = dirname(path);
  const sourcefile = path.split(/[\\/]/).pop();
  const loader = sourcefile.endsWith(".ts") ? "ts" : "js";
  // Collected per bundle so a stub declares the bindings ITS importer asked
  // for, not only the entry module's. Seeded from the entry text, which
  // arrives through stdin and so never reaches the loader below.
  const importsBySpecifier = scanImports(text);
  for (const seed of preseed) {
    const seedSource = await readFile(seed, "utf8");
    mergeImports(importsBySpecifier, scanImports(seedSource));
  }
  const result = await build({
    stdin: { contents: text, resolveDir, sourcefile, loader },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    logLevel: "silent",
    plugins: [
      {
        name: "stub-dependencies",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") {
              return undefined;
            }
            // Compared without the extension: TypeScript sources are
            // imported through their emitted `.js` specifier, so an
            // allowlist written against the real filenames would never match
            // and every "real" dependency would silently be stubbed.
            const base = stem(args.path);
            if (real.some((entry) => stem(entry) === base)) {
              return undefined;
            }
            if (
              realDir &&
              resolve(args.resolveDir, args.path).startsWith(realDir)
            ) {
              return undefined;
            }
            return { path: args.path, namespace: "stub" };
          });
          pluginBuild.onLoad({ filter: /.*/ }, async (args) => {
            if (args.namespace === "stub") {
              return undefined;
            }
            let contents = (await readFile(args.path, "utf8"))
              .split("\r\n")
              .join("\n");
            const loadedBase = stem(args.path);
            for (const override of overrides) {
              if (stem(override.basename) === loadedBase) {
                contents = mutateOrFail(
                  contents,
                  override.mutate,
                  override.label,
                );
              }
            }
            mergeImports(importsBySpecifier, scanImports(contents));
            return {
              contents,
              loader: args.path.endsWith(".ts") ? "ts" : "js",
            };
          });
          pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
            const entry = importsBySpecifier.get(args.path) ?? {
              names: new Set(),
            };
            const lines = [MAKE];
            for (const name of entry.names) {
              lines.push(`export const ${name} = make();`);
            }
            lines.push("export default make();");
            return { contents: lines.join("\n"), loader: "js" };
          });
        },
      },
    ],
  });
  const code = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}
