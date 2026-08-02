/**
 * Resolves the Moon's public normal-map controls into the one relief strength
 * consumed by both render backends.
 *
 * @param {string|null|undefined} normalMapUrl The selected normal-map URL.
 * @param {boolean} enabled Whether lunar normal mapping is enabled.
 * @param {number|null|undefined} strength The requested relief strength.
 * @returns {number} A finite, nonnegative strength. Zero also means that no
 *          normal-map source or upload work is currently demanded.
 *
 * @private
 */
function resolveMoonNormalMapStrength(normalMapUrl, enabled, strength) {
  if (normalMapUrl === undefined || normalMapUrl === null || enabled !== true) {
    return 0.0;
  }

  const resolved = strength ?? 1.0;
  return typeof resolved === "number" &&
    Number.isFinite(resolved) &&
    resolved >= 0.0
    ? resolved
    : 0.0;
}

export default resolveMoonNormalMapStrength;
