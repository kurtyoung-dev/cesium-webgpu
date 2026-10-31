// capture-urls.mjs — a rig's page, the url it becomes on a caller's origin, and the BEFORE/AFTER origins.
//
// @purpose URL piece of capture.mjs: resolveRigPage (a rig's page as a kind and a path), captureUrlFor (the url a rig has on a caller's origin) and resolveCaptureOrigins (the required BEFORE and AFTER origins, verbatim, never defaulted), all pure.
// @status ACTIVE
//
// WHY A PIECE. These moved out of `capture.mjs` when that module passed 1,000
// lines (DX-KIT-CAPTURE-SEAM-OVER-SIZE). `capture.mjs` re-exports every name,
// so importers such as the probes that call `captureUrlFor` are unchanged.

import { ProbeRefusal } from "./probe-refusal.mjs";
import {
  ABSOLUTE_SCHEME,
  CAPTURE_SLOTS,
  ORIGIN_REFUSAL_MESSAGE,
} from "./capture-vocabulary.mjs";

/**
 * Normalise the two forms a rig may declare its page in.
 *
 * `validateRig` (`rig-registry.mjs:163`) requires exactly one of `page` or
 * `url`, and the two forms differ in a way that matters here: at the time of
 * writing 25 rigs declare an origin-RELATIVE `page`, 10 declare an ABSOLUTE
 * `url` on `http://localhost:8080`, and 4 declare `page: null`. Passing an
 * absolute `url` through to the browser would re-introduce the very literal
 * this row exists to retire — the AFTER leg would silently be captured from
 * the BEFORE server. So the declared origin is stripped off and recorded, and
 * only the path survives to be re-based onto the caller's origin.
 *
 * The form is decided by the VALUE's scheme, not by the field's name, so a rig
 * that spells a relative path under `url` still resolves correctly.
 *
 * @param {object} rig A rig record.
 * @returns {{kind: "relative", path: string}
 *   | {kind: "absolute", path: string, declaredOrigin: string}
 *   | {kind: "none", reason: string}} The resolved page.
 */
export function resolveRigPage(rig) {
  const record = rig ?? {};
  const hasPage = Object.hasOwn(record, "page");
  const hasUrl = Object.hasOwn(record, "url");
  if (hasPage === hasUrl) {
    return Object.freeze({
      kind: "none",
      reason: hasPage
        ? "rig declares both page and url — exactly one is required"
        : "rig declares neither page nor url — exactly one is required",
    });
  }

  const field = hasPage ? "page" : "url";
  const declared = hasPage ? record.page : record.url;
  if (declared === null) {
    return Object.freeze({
      kind: "none",
      reason: `rig declares ${field}: null — no page exists for this rig yet`,
    });
  }
  if (typeof declared !== "string" || declared.length === 0) {
    return Object.freeze({
      kind: "none",
      reason: `rig ${field} must be a non-empty string or null, got ${typeof declared}`,
    });
  }

  if (!ABSOLUTE_SCHEME.test(declared)) {
    return Object.freeze({
      kind: "relative",
      path: stripLeadingSlashes(declared),
    });
  }

  let parsed;
  try {
    parsed = new URL(declared);
  } catch {
    return Object.freeze({
      kind: "none",
      reason: `rig ${field} looks absolute but is not a url: ${declared}`,
    });
  }
  // The declared origin is REPORTED, never returned as part of `path`. A
  // `path` that still carried its own scheme would win over the base in
  // `new URL(path, base)` and the re-basing below would be a no-op.
  return Object.freeze({
    kind: "absolute",
    path: `${stripLeadingSlashes(parsed.pathname)}${parsed.search}${parsed.hash}`,
    declaredOrigin: parsed.origin,
  });
}

function stripLeadingSlashes(value) {
  return String(value).replace(/^\/+/, "");
}

/**
 * Turn a declared origin into a base a relative path can be resolved against.
 *
 * @param {unknown} origin The caller's origin.
 * @returns {string} The origin with a trailing slash.
 * @throws {ProbeRefusal} `capture-origin-absent` or `capture-origin-invalid`.
 */
function requireOriginBase(origin) {
  if (typeof origin !== "string" || origin.trim().length === 0) {
    throw new ProbeRefusal(
      "capture-origin-absent",
      ORIGIN_REFUSAL_MESSAGE["capture-origin-absent"],
      { origin: origin ?? null },
    );
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ProbeRefusal(
      "capture-origin-invalid",
      ORIGIN_REFUSAL_MESSAGE["capture-origin-invalid"],
      { origin },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProbeRefusal(
      "capture-origin-invalid",
      ORIGIN_REFUSAL_MESSAGE["capture-origin-invalid"],
      { origin, protocol: parsed.protocol },
    );
  }
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

/**
 * The absolute url one cell fetches: the rig's path, re-based onto the
 * caller's origin.
 *
 * @param {object} options Inputs.
 * @param {object} options.rig The rig.
 * @param {string} options.origin The origin this leg is captured from.
 * @returns {string} The absolute url.
 * @throws {ProbeRefusal} `capture-rig-has-no-page` for a rig with no page, or
 *   an origin refusal for an absent or unusable origin.
 */
export function captureUrlFor({ rig, origin }) {
  const page = resolveRigPage(rig);
  if (page.kind === "none") {
    throw new ProbeRefusal(
      "capture-rig-has-no-page",
      `rig ${rig?.id ?? "(unnamed)"} cannot be captured: ${page.reason}`,
      { rig: rig?.id ?? null, reason: page.reason },
    );
  }
  return new URL(page.path, requireOriginBase(origin)).href;
}

// ---------------------------------------------------------------------------
// 3. Origins — required, verbatim, never defaulted
// ---------------------------------------------------------------------------

/**
 * Resolve the BEFORE and AFTER origins a run was given.
 *
 * Both are REQUIRED. There is no fallback, no `options.port`, and no
 * `http://localhost:8080`; absence is the refusal `capture-origin-absent`.
 * An accepted result carries the caller's own strings VERBATIM rather than the
 * parsed forms, because the manifest records what was asked for, and a
 * silently normalised origin is a different fact from the one the caller
 * stated.
 *
 * @param {object} options Options carrying `origins`.
 * @param {{BEFORE?: string, AFTER?: string}} [options.origins] The two origins.
 * @returns {{ok: true, origins: {BEFORE: string, AFTER: string}}
 *   | {ok: false, reason: string, details: object}} The resolution.
 */
export function resolveCaptureOrigins(options = {}) {
  const declared = options?.origins;
  if (declared === null || typeof declared !== "object") {
    return Object.freeze({
      ok: false,
      reason: "capture-origin-absent",
      details: Object.freeze({
        missing: [...CAPTURE_SLOTS],
        declared: declared ?? null,
      }),
    });
  }

  const missing = [];
  const invalid = [];
  for (const slot of CAPTURE_SLOTS) {
    const value = declared[slot];
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push(slot);
      continue;
    }
    try {
      requireOriginBase(value);
    } catch (error) {
      invalid.push({ slot, value, reason: error?.reason ?? "unknown" });
    }
  }
  if (missing.length > 0) {
    return Object.freeze({
      ok: false,
      reason: "capture-origin-absent",
      details: Object.freeze({ missing }),
    });
  }
  if (invalid.length > 0) {
    return Object.freeze({
      ok: false,
      reason: "capture-origin-invalid",
      details: Object.freeze({ invalid }),
    });
  }
  return Object.freeze({
    ok: true,
    origins: Object.freeze({
      BEFORE: declared.BEFORE,
      AFTER: declared.AFTER,
    }),
  });
}
