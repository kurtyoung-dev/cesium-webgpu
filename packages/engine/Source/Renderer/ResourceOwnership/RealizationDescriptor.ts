import type { ResourceFamilyId } from "./ResourceFamily.js";

/** Add-only physical realization categories. */
const RealizationKind = Object.freeze({
  BUFFER: 1,
  TEXTURE: 2,
  GEOMETRY: 3,
  TERRAIN_MESH: 4,
  FEATURE_TABLE: 5,
  SAMPLER: 6,
  SHADER_MODULE: 7,
  PIPELINE: 8,
  BIND_GROUP: 9,
  RENDER_TARGET: 10,
  READBACK_BUFFER: 11,
} as const);

type RealizationKind = (typeof RealizationKind)[keyof typeof RealizationKind];

function requireFingerprint(value: string, name: string): string {
  if (value.length === 0) {
    throw new Error(`${name} must be explicit and non-empty.`);
  }
  return value;
}

function requireInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

interface RealizationDescriptorOptions {
  family: ResourceFamilyId;
  kind: RealizationKind;
  usageMask: number;
  byteLength: number;
  width: number;
  height: number;
  depthOrArrayLayers: number;
  mipLevelCount: number;
  sampleCount: number;
  mutable: boolean;
  formatFingerprint: string;
  layoutFingerprint: string;
  shaderFingerprint: string;
  renderStateFingerprint: string;
  variantFingerprint: string;
  updateContractFingerprint: string;
}

/**
 * Exact realization identity. Fields that do not apply are still explicit
 * (for example, `"none"`) so omitted state cannot alias a cache entry.
 */
class RealizationDescriptor {
  readonly family: ResourceFamilyId;
  readonly kind: RealizationKind;
  readonly usageMask: number;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly mutable: boolean;
  readonly formatFingerprint: string;
  readonly layoutFingerprint: string;
  readonly shaderFingerprint: string;
  readonly renderStateFingerprint: string;
  readonly variantFingerprint: string;
  readonly updateContractFingerprint: string;
  readonly fingerprint: string;

  constructor(options: RealizationDescriptorOptions) {
    this.family = options.family;
    this.kind = options.kind;
    this.usageMask = requireInteger(options.usageMask, "usageMask", 0);
    this.byteLength = requireInteger(options.byteLength, "byteLength", 0);
    this.width = requireInteger(options.width, "width", 1);
    this.height = requireInteger(options.height, "height", 1);
    this.depthOrArrayLayers = requireInteger(
      options.depthOrArrayLayers,
      "depthOrArrayLayers",
      1,
    );
    this.mipLevelCount = requireInteger(
      options.mipLevelCount,
      "mipLevelCount",
      1,
    );
    this.sampleCount = requireInteger(options.sampleCount, "sampleCount", 1);
    this.mutable = options.mutable;
    this.formatFingerprint = requireFingerprint(
      options.formatFingerprint,
      "formatFingerprint",
    );
    this.layoutFingerprint = requireFingerprint(
      options.layoutFingerprint,
      "layoutFingerprint",
    );
    this.shaderFingerprint = requireFingerprint(
      options.shaderFingerprint,
      "shaderFingerprint",
    );
    this.renderStateFingerprint = requireFingerprint(
      options.renderStateFingerprint,
      "renderStateFingerprint",
    );
    this.variantFingerprint = requireFingerprint(
      options.variantFingerprint,
      "variantFingerprint",
    );
    this.updateContractFingerprint = requireFingerprint(
      options.updateContractFingerprint,
      "updateContractFingerprint",
    );
    this.fingerprint = JSON.stringify([
      this.family,
      this.kind,
      this.usageMask,
      this.byteLength,
      this.width,
      this.height,
      this.depthOrArrayLayers,
      this.mipLevelCount,
      this.sampleCount,
      this.mutable,
      this.formatFingerprint,
      this.layoutFingerprint,
      this.shaderFingerprint,
      this.renderStateFingerprint,
      this.variantFingerprint,
      this.updateContractFingerprint,
    ]);
    Object.freeze(this);
  }
}

export { RealizationDescriptor, RealizationKind };
export type {
  RealizationDescriptorOptions,
  RealizationKind as RealizationKindId,
};
export default RealizationDescriptor;
