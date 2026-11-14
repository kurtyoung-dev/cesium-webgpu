/**
 * The volumetric-fog dials a landing cell's rig declares, and how the stage
 * applies them on the globe's fog block.
 * @purpose Fog dial family for the landing stage: names the rig dials that set the globe's volumetric fog block (volumetricFogEnabled, volumetricFogDensity, cloudShadowHiFi), validates their values in Node before a browser is involved, and applies each in the page on viewer.scene.globe.atmosphericConditions.volumetricFog, reading every value back as {requested, observed, applied}, so a rig with the lit-terrain-plus-fog scene stages through the landing probe and a fog dial the tree did not take is a NOT RUN, never a silent plain frame.
 * @status ACTIVE
 *
 * WHERE THE DIALS LAND. `AtmosphericConditions#volumetricFog` returns the block
 * the WebGPU volumetric fog renderer reads (`ac.volumetricFog`): `enabled` and
 * `density` are fields `buildVolumetricFog` declares, and the renderer reads the
 * high-fidelity cloud-shadow switch as `vf.cloudShadowHiFi`, a field the default
 * block does not declare, so that one is written even when absent. The block is
 * reached through `Globe#atmosphericConditions`.
 *
 * READ BACK, NOT ASSUMED. A dial is applied only when the value read back equals
 * the one requested; a missing block, a missing declared field, an assignment
 * that throws (a frozen block) and a value that did not stick are each
 * `applied: false` with the reason.
 *
 * @module Tools/visual-regression/lib/landing-fog-dials
 */

/**
 * The rig dials this module owns, in the order they are applied, and the
 * property each sets on the fog block.
 */
export const LANDING_FOG_DIALS = Object.freeze([
  "volumetricFogEnabled",
  "volumetricFogDensity",
  "cloudShadowHiFi",
]);

/** The property of the fog block each dial sets. */
export const LANDING_FOG_PROPERTIES = Object.freeze({
  volumetricFogEnabled: "enabled",
  volumetricFogDensity: "density",
  cloudShadowHiFi: "cloudShadowHiFi",
});

/**
 * Why a fog dial value cannot be applied. Pure.
 *
 * @param {Record<string, unknown>} fog The declared fog dials by rig name.
 * @returns {string[]} One `<dial>=<value>` string per refused dial.
 */
export function fogDialViolations(fog) {
  const violations = [];
  for (const [key, value] of Object.entries(fog ?? {})) {
    if (key === "volumetricFogEnabled" || key === "cloudShadowHiFi") {
      if (typeof value !== "boolean") {
        violations.push(`${key}=${JSON.stringify(value)}`);
      }
    } else if (key === "volumetricFogDensity") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        violations.push(`${key}=${JSON.stringify(value)}`);
      }
    } else {
      violations.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return violations;
}

/**
 * PAGE SIDE. Apply the fog dials on the globe's volumetric fog block and read
 * each back. Self-contained.
 *
 * @param {Record<string, unknown>} fog The payload's fog dials by rig name.
 * @returns {Record<string, {requested: unknown, observed: unknown,
 *   applied: boolean, reason?: string}>}
 */
export function pageApplyFogDials(fog) {
  const properties = {
    volumetricFogEnabled: "enabled",
    volumetricFogDensity: "density",
    cloudShadowHiFi: "cloudShadowHiFi",
  };
  // `cloudShadowHiFi` is read by the renderer but not declared by the default
  // block, so it may be created; the other two must already be there.
  const mayCreate = { cloudShadowHiFi: true };
  const seam = "viewer.scene.globe.atmosphericConditions.volumetricFog";
  const block = /** @type {any} */ (globalThis).viewer?.scene?.globe
    ?.atmosphericConditions?.volumetricFog;
  const rows = {};
  for (const [dial, requested] of Object.entries(fog ?? {})) {
    const property = properties[dial];
    if (!block || typeof block !== "object") {
      rows[dial] = {
        requested,
        observed: undefined,
        applied: false,
        reason: `NOT AVAILABLE: ${seam}`,
      };
      continue;
    }
    if (!(property in block) && mayCreate[dial] !== true) {
      rows[dial] = {
        requested,
        observed: undefined,
        applied: false,
        reason: `${property} is not a property of ${seam}`,
      };
      continue;
    }
    try {
      block[property] = requested;
    } catch (error) {
      rows[dial] = {
        requested,
        observed: block[property],
        applied: false,
        reason: `assignment threw: ${String(error && error.message ? error.message : error)}`,
      };
      continue;
    }
    const observed = block[property];
    const applied = Object.is(observed, requested);
    rows[dial] = {
      requested,
      observed,
      applied,
      ...(applied
        ? {}
        : { reason: `${seam}.${property} reads back ${String(observed)}` }),
    };
  }
  return rows;
}
