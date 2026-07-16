/**
 * Add-only identifiers for resource ownership policy and telemetry.
 *
 * Values are persistent cache/diagnostic identities. Never reorder, renumber,
 * or reuse an existing value. Deprecated families remain reserved.
 */
const ResourceFamily = Object.freeze({
  GEOMETRY: 1,
  TEXTURE: 2,
  TERRAIN: 3,
  FEATURE_TABLE: 4,
  SAMPLER: 5,
  SHADER_MODULE: 6,
  PIPELINE: 7,
  BIND_GROUP: 8,
  PLACEHOLDER: 9,
  RENDER_TARGET: 10,
  READBACK: 11,
} as const);

type ResourceFamily = (typeof ResourceFamily)[keyof typeof ResourceFamily];

const RESOURCE_FAMILY_VALUES: readonly ResourceFamily[] = Object.freeze([
  ResourceFamily.GEOMETRY,
  ResourceFamily.TEXTURE,
  ResourceFamily.TERRAIN,
  ResourceFamily.FEATURE_TABLE,
  ResourceFamily.SAMPLER,
  ResourceFamily.SHADER_MODULE,
  ResourceFamily.PIPELINE,
  ResourceFamily.BIND_GROUP,
  ResourceFamily.PLACEHOLDER,
  ResourceFamily.RENDER_TARGET,
  ResourceFamily.READBACK,
]);

function isResourceFamily(value: number): value is ResourceFamily {
  return RESOURCE_FAMILY_VALUES.some((family) => family === value);
}

function resourceFamilyName(family: ResourceFamily): string {
  switch (family) {
    case ResourceFamily.GEOMETRY:
      return "GEOMETRY";
    case ResourceFamily.TEXTURE:
      return "TEXTURE";
    case ResourceFamily.TERRAIN:
      return "TERRAIN";
    case ResourceFamily.FEATURE_TABLE:
      return "FEATURE_TABLE";
    case ResourceFamily.SAMPLER:
      return "SAMPLER";
    case ResourceFamily.SHADER_MODULE:
      return "SHADER_MODULE";
    case ResourceFamily.PIPELINE:
      return "PIPELINE";
    case ResourceFamily.BIND_GROUP:
      return "BIND_GROUP";
    case ResourceFamily.PLACEHOLDER:
      return "PLACEHOLDER";
    case ResourceFamily.RENDER_TARGET:
      return "RENDER_TARGET";
    case ResourceFamily.READBACK:
      return "READBACK";
  }
}

export {
  RESOURCE_FAMILY_VALUES,
  isResourceFamily,
  ResourceFamily,
  resourceFamilyName,
};
export type { ResourceFamily as ResourceFamilyId };
export default ResourceFamily;
