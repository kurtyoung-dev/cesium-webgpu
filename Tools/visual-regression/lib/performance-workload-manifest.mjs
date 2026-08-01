import Ajv from "ajv";

function schemaForInstalledValidator(schema) {
  // The repository's locked AJV is the draft-07 implementation used by the
  // lint toolchain. This workload schema only uses draft-07 keywords, but its
  // declaration advertises the newer 2020-12 metaschema. Remove only that
  // declaration from the in-memory copy so validation remains driven by the
  // checked-in schema without requiring a network-fetched metaschema.
  const copy = JSON.parse(JSON.stringify(schema));
  delete copy.$schema;
  return copy;
}

function formatValidationError(error) {
  const path = error.dataPath || "$";
  const details = error.params?.missingProperty
    ? ` (${error.params.missingProperty})`
    : "";
  return `${path} ${error.message || "is invalid"}${details}`;
}

/**
 * Validate a performance workload manifest against the checked-in JSON
 * schema. Keeping this in one shared module prevents the Node contract and the
 * executable runner from accepting different manifest shapes.
 *
 * @param {object} manifest
 * @param {object} schema
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validatePerformanceWorkloadManifest(manifest, schema) {
  const ajv = new Ajv({
    allErrors: true,
    jsonPointers: true,
    schemaId: "auto",
    logger: false,
  });
  const validate = ajv.compile(schemaForInstalledValidator(schema));
  const valid = validate(manifest) === true;
  return {
    valid,
    errors: valid ? [] : (validate.errors || []).map(formatValidationError),
  };
}

/**
 * Throw a bounded, actionable error when a runner manifest violates the
 * checked-in schema.
 *
 * @param {object} manifest
 * @param {object} schema
 */
export function assertPerformanceWorkloadManifest(manifest, schema) {
  const result = validatePerformanceWorkloadManifest(manifest, schema);
  if (!result.valid) {
    throw new Error(
      `Invalid performance workload manifest:\n- ${result.errors.join("\n- ")}`,
    );
  }
}
