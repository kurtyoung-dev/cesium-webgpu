/**
 * Reads and checks the `experimental` block a rig may declare beside its
 * `dials`: the values for the dials on `CloudVolumetrics#experimental`.
 * @purpose Pure Node-side validation and copying of a rig's `experimental` block (plain object, `cloud[A-Z]` keys, boolean or finite-number values), shared by the rig registry and both stage payload builders.
 * @status ACTIVE
 *
 * WHY A SEPARATE BLOCK. The experimental dials are not properties of the
 * `CloudVolumetrics` instance: they live on a namespace object it owns, so the
 * harness assigns and reads them there and nowhere else. A rig keeps them in
 * their own block so the top-level dial path is unchanged for every rig that
 * does not use one.
 *
 * WHAT IS NOT CHECKED HERE. Whether a key names a dial the class declares is
 * decided in the page, by the namespace's own enumerable keys, where the real
 * class is. This piece only refuses a block that could not be staged at all.
 */

/** The shape every experimental dial name has, as every `CloudVolumetrics` dial does. */
export const EXPERIMENTAL_DIAL_KEY_RE = /^cloud[A-Z]/;

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * What is wrong with a rig's `experimental` block; empty when it is sound or
 * absent.
 *
 * @param {unknown} block The rig's `experimental` field.
 * @returns {string[]} One message per violation, each naming the key at fault.
 */
export function violations(block) {
  if (block === undefined) {
    return [];
  }
  if (!isPlainObject(block) || Object.keys(block).length === 0) {
    return ["experimental must be a non-empty plain object"];
  }
  const violations = [];
  for (const [key, value] of Object.entries(block)) {
    if (!EXPERIMENTAL_DIAL_KEY_RE.test(key)) {
      violations.push(
        `experimental key ${key} does not match cloud followed by an upper-case letter`,
      );
    } else if (
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      violations.push(
        `experimental.${key} must be a boolean or a finite number, got ${JSON.stringify(value)}`,
      );
    }
  }
  return violations;
}

/**
 * A copy of a rig's `experimental` block, or `undefined` when the rig declares
 * none, so a payload can leave the key out.
 *
 * @param {object} rig A rig record.
 * @returns {Record<string, boolean|number>|undefined}
 */
export function copy(rig) {
  return rig?.experimental === undefined ? undefined : { ...rig.experimental };
}
