/**
 * Lets a pure-Node spec execute engine TypeScript that is NOT a leaf module.
 *
 * Engine source uses the CesiumJS convention of writing `.js` specifiers even
 * between `.ts` files (the extension the build emits). Node's built-in type
 * stripping does not perform that remap, so `node --test` can only statically
 * import engine `.ts` modules with zero relative imports. That silently pushed
 * every earlier spec toward leaf-only modules and toward re-implementing the
 * logic it wanted to pin — which is exactly how a CPU twin drifts.
 *
 * This registers a synchronous resolve hook (Node >= 22.15) that rewrites a
 * relative `./x.js` specifier to `./x.ts` ONLY when the `.js` does not exist and
 * the sibling `.ts` does. It cannot shadow a real build output, and it never
 * touches bare or `node:` specifiers.
 *
 * Usage — the hook must be installed before the modules are loaded, so the spec
 * imports them dynamically:
 *
 *   import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
 *   enableEngineTsResolution();
 *   const { thing } = await import("../../packages/engine/Source/.../Thing.ts");
 */
import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

let registered = false;

export function enableEngineTsResolution() {
  if (registered) {
    return;
  }
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        specifier.endsWith(".js") &&
        typeof context.parentURL === "string" &&
        context.parentURL.startsWith("file:")
      ) {
        const asJs = new URL(specifier, context.parentURL);
        if (!fs.existsSync(fileURLToPath(asJs))) {
          const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
          const asTs = new URL(tsSpecifier, context.parentURL);
          if (fs.existsSync(fileURLToPath(asTs))) {
            return nextResolve(tsSpecifier, context);
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
