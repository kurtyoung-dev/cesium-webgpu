/**
 * Postinstall patch: normalize eslint-seatbelt's path keys to forward slashes.
 * @purpose postinstall patch normalizing eslint-seatbelt path keys to forward slashes so the committed POSIX seatbelt.tsv grandfathers on Windows.
 * @status ACTIVE
 *
 * eslint-seatbelt@0.1.x keys its eslint.seatbelt.tsv entries via
 * `path.relative(...)`, which uses OS-native separators. Our committed
 * eslint.seatbelt.tsv uses forward slashes — it is generated/maintained as POSIX
 * because the lint CI gate (.github/workflows/{dev,prod}.yml) runs on
 * ubuntu-latest. On Windows the backslash lookup never matches the POSIX keys, so
 * every grandfathered violation surfaces as an error and the pre-commit hook
 * fails locally. Forcing forward-slash keys makes the single committed .tsv
 * grandfather correctly on BOTH Windows and POSIX (a no-op on POSIX, where the
 * separator is already "/").
 *
 * Implemented as a postinstall script rather than patch-package because this fork
 * does not commit a lockfile (patch-package requires one). Idempotent + tolerant
 * of eslint-seatbelt being absent. cesium-webgpu fork — see
 * migration_doc/UPSTREAM_MERGE_2026-06_CHANGELOG.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "node_modules", "eslint-seatbelt", "dist");

const NEEDLE = "return nodePath.relative(this.dirname, filename);";
const REPLACEMENT =
  'return nodePath.relative(this.dirname, filename).split(nodePath.sep).join("/");';

let patched = 0;
let alreadyPatched = 0;
try {
  for (const file of fs.readdirSync(distDir)) {
    if (!/\.(c?js|mjs)$/.test(file)) {
      continue;
    }
    const filePath = path.join(distDir, file);
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes(REPLACEMENT)) {
      alreadyPatched++;
      continue;
    }
    if (source.includes(NEEDLE)) {
      fs.writeFileSync(filePath, source.split(NEEDLE).join(REPLACEMENT));
      patched++;
    }
  }
  console.log(
    `[patch-eslint-seatbelt] posix path keys: ${patched} patched, ${alreadyPatched} already-patched`,
  );
} catch (e) {
  // eslint-seatbelt not installed (e.g. a production-only install) — nothing to do.
  console.log(`[patch-eslint-seatbelt] skipped: ${e.message}`);
}
