// probe-frame-write.mjs — the one place a probe frame reaches the disk.
//
// @purpose The single frame-write primitive behind captureElement and bankPngCapture: refuses to replace an existing frame in the shared Tools/visual-regression/output root unless the runtime lifted the guard for an explicit --output, and decodes a same-task PNG data URL or refuses it by name.
// @status ACTIVE
//
// WHY THE GUARD IS DECIDED FROM THE PATH. A probe descriptor that declares
// `outputSubdirectory: ""` writes its frames straight into the shared
// `Tools/visual-regression/output/` root, which is where the fleet's
// pre-migration frames are banked (the voxel, cloud, oit and polyline-velocity
// descriptors keep that on purpose, so their artifact paths survive the
// migration). A default run of one of them therefore used to replace banked
// evidence silently. `captureElement` cannot know whether `--output` was
// parsed — it is handed a directory and nothing else — so the decision has to
// be made from what every writer does have: the path. A write whose directory
// IS the shared root refuses before an existing file there is replaced; a
// per-probe subdirectory under it is never guarded, and neither is any
// directory outside it.
//
// THE LIFT. `runProbe` knows whether `--output` was passed, and passing it is
// the operator saying "write here". So the runtime lifts the guard for the one
// directory it resolved from that flag, for the duration of that run, and
// releases it when the run ends. Nothing else lifts it.
//
// FRAMES, NOT RECEIPTS. The runtime's own receipt writes do not come through
// here: a receipt is replaced only on a MEASURED run, by design (see the
// `probe-runtime.mjs` header), and a refused run writes a sidecar instead.
//
// THE DECODER. A probe that reads its canvas in the same task as the render
// hands back `canvas.toDataURL("image/png")`. Every copy of the decode in the
// fleet sliced at the first comma and trusted `Buffer.from(…, "base64")`, which
// never throws: an empty string, a JPEG URL or a truncated payload came back as
// a short buffer and was banked under a PNG name. Here each of those refuses,
// naming the capture.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ProbeRefusal } from "./probe-refusal.mjs";

/** The trailing path segments of the shared output root, in order. */
const SHARED_OUTPUT_ROOT_SEGMENTS = Object.freeze([
  "tools",
  "visual-regression",
  "output",
]);

/** The prefix every same-task canvas read produces. */
export const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Directories the runtime has lifted the guard for, keyed by
 * {@link directoryKey}, with a count so nested lifts release independently.
 */
const liftedDirectories = new Map();

/**
 * @param {string} directory Any directory path.
 * @returns {string} The resolved path in the form two spellings of one
 *   directory share (case-folded on Windows, where the file system is).
 */
function directoryKey(directory) {
  const resolved = path.resolve(directory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Whether `directory` resolves to the shared `Tools/visual-regression/output`
 * root of SOME tree — the seat, a worker clone or a spec's temp fixture. A
 * subdirectory of the root is not the root.
 *
 * @param {string} directory Directory to classify.
 * @returns {boolean} True for the shared root itself.
 */
export function isSharedOutputRootDirectory(directory) {
  const segments = path
    .resolve(directory)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  const tail = segments.slice(-SHARED_OUTPUT_ROOT_SEGMENTS.length);
  return (
    tail.length === SHARED_OUTPUT_ROOT_SEGMENTS.length &&
    tail.every(
      (segment, index) => segment === SHARED_OUTPUT_ROOT_SEGMENTS[index],
    )
  );
}

/**
 * Lift the shared-root guard for one directory. Only `runProbe` calls this,
 * and only for the directory it resolved from an explicit `--output`.
 *
 * @param {string} directory The directory the operator named.
 * @returns {() => void} Releases this lift; calling it again does nothing.
 */
export function liftSharedRootGuard(directory) {
  const key = directoryKey(directory);
  liftedDirectories.set(key, (liftedDirectories.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (liftedDirectories.get(key) ?? 1) - 1;
    if (remaining > 0) {
      liftedDirectories.set(key, remaining);
    } else {
      liftedDirectories.delete(key);
    }
  };
}

/**
 * @param {string} directory Directory to check.
 * @returns {boolean} Whether a lift is currently held for it.
 */
function isLifted(directory) {
  return liftedDirectories.has(directoryKey(directory));
}

/**
 * Write one frame. Every frame write in the runtime goes through here.
 *
 * Refuses `frame-overwrite-shared-root` — before anything is written — when the
 * target's directory is the shared output root, a file already exists at the
 * target, and no lift is held for that directory. The refusal names the path
 * and the sha256 of the bytes it declined to replace.
 *
 * @param {object} options Options.
 * @param {string} options.file Target path.
 * @param {Buffer|Uint8Array} options.bytes The frame.
 * @returns {string} The resolved path written.
 */
export function writeFrameFile({ file, bytes }) {
  const target = path.resolve(file);
  const directory = path.dirname(target);
  if (isSharedOutputRootDirectory(directory) && !isLifted(directory)) {
    let existing = null;
    try {
      existing = fs.lstatSync(target);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (existing !== null) {
      const digest = existing.isFile()
        ? createHash("sha256").update(fs.readFileSync(target)).digest("hex")
        : null;
      throw new ProbeRefusal(
        "frame-overwrite-shared-root",
        `refusing to replace ${target} (sha256 ${digest ?? "not a regular file"}): ` +
          "it sits in the shared Tools/visual-regression/output root, where banked frames live. " +
          "Pass --output <dir> to write this run somewhere else (or to name this root explicitly).",
        { path: target, sha256: digest },
      );
    }
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

/**
 * @param {string} payload Candidate base64 text.
 * @returns {boolean} Whether it is canonical padded base64 (the alphabet
 *   `toDataURL` emits, length a multiple of four, `=` only as padding).
 */
function isStrictBase64(payload) {
  if (payload.length === 0 || payload.length % 4 !== 0) {
    return false;
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const body = payload.length - padding;
  for (let index = 0; index < body; index++) {
    const code = payload.charCodeAt(index);
    const ok =
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) || // 0-9
      code === 43 || // +
      code === 47; // /
    if (!ok) {
      return false;
    }
  }
  return true;
}

/**
 * Refuse a data URL by name.
 *
 * @param {string} name The capture being banked.
 * @param {"empty"|"not-png"|"undecodable"} defect What is wrong with it.
 * @param {string} detail The sentence that says so.
 */
function refuseDataUrl(name, defect, detail) {
  throw new ProbeRefusal(
    "capture-data-url-invalid",
    `"${name}" was not banked: ${detail}`,
    { name, defect },
  );
}

/**
 * Decode a same-task `data:image/png;base64,…` URL to its PNG bytes.
 *
 * @param {unknown} dataUrl What the page handed back.
 * @param {{name?: string}} [options] The capture name, for the refusal.
 * @returns {Buffer} The PNG bytes (signature checked).
 */
export function decodePngDataUrl(dataUrl, { name = "capture" } = {}) {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    refuseDataUrl(name, "empty", "the page returned no data URL");
  }
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    refuseDataUrl(
      name,
      "not-png",
      `the data URL does not start with ${PNG_DATA_URL_PREFIX}`,
    );
  }
  const payload = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (payload.length === 0) {
    refuseDataUrl(name, "empty", "the PNG data URL carries no payload");
  }
  if (!isStrictBase64(payload)) {
    refuseDataUrl(
      name,
      "undecodable",
      "the PNG data URL payload is not canonical base64",
    );
  }
  const bytes = Buffer.from(payload, "base64");
  if (
    bytes.length <= PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    refuseDataUrl(
      name,
      "not-png",
      "the decoded payload does not carry a PNG signature",
    );
  }
  return bytes;
}
