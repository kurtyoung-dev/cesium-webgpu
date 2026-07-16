import { type ResourceFamilyId, ResourceFamily } from "./ResourceFamily.js";

type DecodedByteSource = ArrayBuffer | ArrayBufferView;

function requireNonEmpty(value: string, name: string): string {
  if (value.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  return value;
}

function requireInteger(value: number, name: string, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${minimum}.`,
    );
  }
  return value;
}

function copySourceBytes(source: DecodedByteSource): Uint8Array {
  const view =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return Uint8Array.from(view);
}

/**
 * A decoded byte product that never exposes its mutable backing store.
 * Consumers request a copy until a future read-only arena contract exists.
 */
class ImmutableDecodedBytes {
  readonly byteLength: number;
  readonly fingerprint: string;
  readonly #bytes: Uint8Array;

  constructor(source: DecodedByteSource, fingerprint: string) {
    this.#bytes = copySourceBytes(source);
    this.byteLength = this.#bytes.byteLength;
    this.fingerprint = requireNonEmpty(fingerprint, "fingerprint");
    Object.freeze(this);
  }

  copyBytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

interface DecodedAssetIdOptions {
  family: ResourceFamilyId;
  logicalAssetId: string;
  sourceFingerprint: string;
  decodeFingerprint: string;
  revision: number;
}

/** Stable identity for one exact immutable decoded product. */
class DecodedAssetId {
  readonly family: ResourceFamilyId;
  readonly logicalAssetId: string;
  readonly sourceFingerprint: string;
  readonly decodeFingerprint: string;
  readonly revision: number;
  readonly fingerprint: string;

  constructor(options: DecodedAssetIdOptions) {
    this.family = options.family;
    this.logicalAssetId = requireNonEmpty(
      options.logicalAssetId,
      "logicalAssetId",
    );
    this.sourceFingerprint = requireNonEmpty(
      options.sourceFingerprint,
      "sourceFingerprint",
    );
    this.decodeFingerprint = requireNonEmpty(
      options.decodeFingerprint,
      "decodeFingerprint",
    );
    this.revision = requireInteger(options.revision, "revision");
    this.fingerprint = JSON.stringify([
      this.family,
      this.logicalAssetId,
      this.sourceFingerprint,
      this.decodeFingerprint,
      this.revision,
    ]);
    Object.freeze(this);
  }
}

const GeometryAttributeSemantic = Object.freeze({
  POSITION: 1,
  POSITION_HIGH: 2,
  POSITION_LOW: 3,
  NORMAL: 4,
  TANGENT: 5,
  TEXCOORD_0: 6,
  TEXCOORD_1: 7,
  COLOR_0: 8,
  JOINTS_0: 9,
  WEIGHTS_0: 10,
  FEATURE_ID_0: 11,
} as const);

type GeometryAttributeSemantic =
  (typeof GeometryAttributeSemantic)[keyof typeof GeometryAttributeSemantic];

const DecodedComponentType = Object.freeze({
  UINT8: 1,
  SINT8: 2,
  UINT16: 3,
  SINT16: 4,
  UINT32: 5,
  SINT32: 6,
  FLOAT16: 7,
  FLOAT32: 8,
  FLOAT64: 9,
} as const);

type DecodedComponentType =
  (typeof DecodedComponentType)[keyof typeof DecodedComponentType];

const GeometryTopology = Object.freeze({
  POINT_LIST: 1,
  LINE_LIST: 2,
  LINE_STRIP: 3,
  TRIANGLE_LIST: 4,
  TRIANGLE_STRIP: 5,
} as const);

type GeometryTopology =
  (typeof GeometryTopology)[keyof typeof GeometryTopology];

interface DecodedGeometryAttributeOptions {
  semantic: GeometryAttributeSemantic;
  componentType: DecodedComponentType;
  componentCount: number;
  normalized: boolean;
  byteStride: number;
  data: ImmutableDecodedBytes;
}

class DecodedGeometryAttribute {
  readonly semantic: GeometryAttributeSemantic;
  readonly componentType: DecodedComponentType;
  readonly componentCount: number;
  readonly normalized: boolean;
  readonly byteStride: number;
  readonly data: ImmutableDecodedBytes;

  constructor(options: DecodedGeometryAttributeOptions) {
    this.semantic = options.semantic;
    this.componentType = options.componentType;
    this.componentCount = requireInteger(
      options.componentCount,
      "componentCount",
      1,
    );
    this.normalized = options.normalized;
    this.byteStride = requireInteger(options.byteStride, "byteStride", 1);
    this.data = options.data;
    Object.freeze(this);
  }
}

interface GeometryPayloadOptions {
  id: DecodedAssetId;
  attributes: readonly DecodedGeometryAttribute[];
  indices: ImmutableDecodedBytes | null;
  indexComponentType: DecodedComponentType | null;
  vertexCount: number;
  indexCount: number;
  topology: GeometryTopology;
  boundsMinimum: readonly [number, number, number];
  boundsMaximum: readonly [number, number, number];
}

class GeometryPayload {
  readonly id: DecodedAssetId;
  readonly attributes: readonly DecodedGeometryAttribute[];
  readonly indices: ImmutableDecodedBytes | null;
  readonly indexComponentType: DecodedComponentType | null;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly topology: GeometryTopology;
  readonly boundsMinimum: readonly [number, number, number];
  readonly boundsMaximum: readonly [number, number, number];

  constructor(options: GeometryPayloadOptions) {
    if (options.id.family !== ResourceFamily.GEOMETRY) {
      throw new Error("GeometryPayload requires a GEOMETRY DecodedAssetId.");
    }
    if (options.attributes.length === 0) {
      throw new Error("GeometryPayload requires at least one attribute.");
    }
    if ((options.indices === null) !== (options.indexComponentType === null)) {
      throw new Error(
        "indices and indexComponentType must either both be present or both be null.",
      );
    }
    this.id = options.id;
    this.attributes = Object.freeze(Array.from(options.attributes));
    this.indices = options.indices;
    this.indexComponentType = options.indexComponentType;
    this.vertexCount = requireInteger(options.vertexCount, "vertexCount");
    this.indexCount = requireInteger(options.indexCount, "indexCount");
    this.topology = options.topology;
    this.boundsMinimum = Object.freeze([
      options.boundsMinimum[0],
      options.boundsMinimum[1],
      options.boundsMinimum[2],
    ]);
    this.boundsMaximum = Object.freeze([
      options.boundsMaximum[0],
      options.boundsMaximum[1],
      options.boundsMaximum[2],
    ]);
    Object.freeze(this);
  }
}

const DecodedTextureFormat = Object.freeze({
  R8_UNORM: 1,
  RG8_UNORM: 2,
  RGBA8_UNORM: 3,
  RGBA8_SRGB: 4,
  RGBA16_FLOAT: 5,
  RGBA32_FLOAT: 6,
  BC1_RGBA_UNORM: 7,
  BC3_RGBA_UNORM: 8,
  BC7_RGBA_UNORM: 9,
  ETC2_RGBA8_UNORM: 10,
  ASTC_4X4_UNORM: 11,
} as const);

type DecodedTextureFormat =
  (typeof DecodedTextureFormat)[keyof typeof DecodedTextureFormat];

const DecodedColorSpace = Object.freeze({
  LINEAR: 1,
  SRGB: 2,
  DISPLAY_P3: 3,
} as const);

type DecodedColorSpace =
  (typeof DecodedColorSpace)[keyof typeof DecodedColorSpace];

interface TextureMipPayloadOptions {
  level: number;
  width: number;
  height: number;
  depthOrArrayLayers: number;
  data: ImmutableDecodedBytes;
}

class TextureMipPayload {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly data: ImmutableDecodedBytes;

  constructor(options: TextureMipPayloadOptions) {
    this.level = requireInteger(options.level, "level");
    this.width = requireInteger(options.width, "width", 1);
    this.height = requireInteger(options.height, "height", 1);
    this.depthOrArrayLayers = requireInteger(
      options.depthOrArrayLayers,
      "depthOrArrayLayers",
      1,
    );
    this.data = options.data;
    Object.freeze(this);
  }
}

interface TexturePayloadOptions {
  id: DecodedAssetId;
  format: DecodedTextureFormat;
  colorSpace: DecodedColorSpace;
  premultipliedAlpha: boolean;
  mips: readonly TextureMipPayload[];
}

class TexturePayload {
  readonly id: DecodedAssetId;
  readonly format: DecodedTextureFormat;
  readonly colorSpace: DecodedColorSpace;
  readonly premultipliedAlpha: boolean;
  readonly mips: readonly TextureMipPayload[];

  constructor(options: TexturePayloadOptions) {
    if (options.id.family !== ResourceFamily.TEXTURE) {
      throw new Error("TexturePayload requires a TEXTURE DecodedAssetId.");
    }
    if (options.mips.length === 0 || options.mips[0].level !== 0) {
      throw new Error("TexturePayload requires a level-zero mip.");
    }
    for (let index = 0; index < options.mips.length; index++) {
      if (options.mips[index].level !== index) {
        throw new Error("TexturePayload mip levels must be contiguous.");
      }
    }
    this.id = options.id;
    this.format = options.format;
    this.colorSpace = options.colorSpace;
    this.premultipliedAlpha = options.premultipliedAlpha;
    this.mips = Object.freeze(Array.from(options.mips));
    Object.freeze(this);
  }
}

interface TerrainPayloadOptions {
  id: DecodedAssetId;
  encodedVertices: ImmutableDecodedBytes;
  indices: ImmutableDecodedBytes;
  indexComponentType: DecodedComponentType;
  vertexEncodingFingerprint: string;
  minimumHeight: number;
  maximumHeight: number;
  childTileMask: number;
}

class TerrainPayload {
  readonly id: DecodedAssetId;
  readonly encodedVertices: ImmutableDecodedBytes;
  readonly indices: ImmutableDecodedBytes;
  readonly indexComponentType: DecodedComponentType;
  readonly vertexEncodingFingerprint: string;
  readonly minimumHeight: number;
  readonly maximumHeight: number;
  readonly childTileMask: number;

  constructor(options: TerrainPayloadOptions) {
    if (options.id.family !== ResourceFamily.TERRAIN) {
      throw new Error("TerrainPayload requires a TERRAIN DecodedAssetId.");
    }
    if (options.maximumHeight < options.minimumHeight) {
      throw new Error(
        "maximumHeight must be greater than or equal to minimumHeight.",
      );
    }
    this.id = options.id;
    this.encodedVertices = options.encodedVertices;
    this.indices = options.indices;
    this.indexComponentType = options.indexComponentType;
    this.vertexEncodingFingerprint = requireNonEmpty(
      options.vertexEncodingFingerprint,
      "vertexEncodingFingerprint",
    );
    this.minimumHeight = options.minimumHeight;
    this.maximumHeight = options.maximumHeight;
    this.childTileMask = requireInteger(options.childTileMask, "childTileMask");
    Object.freeze(this);
  }
}

interface FeatureTablePropertyOptions {
  propertyId: string;
  componentType: DecodedComponentType;
  componentCount: number;
  normalized: boolean;
  data: ImmutableDecodedBytes;
}

class FeatureTableProperty {
  readonly propertyId: string;
  readonly componentType: DecodedComponentType;
  readonly componentCount: number;
  readonly normalized: boolean;
  readonly data: ImmutableDecodedBytes;

  constructor(options: FeatureTablePropertyOptions) {
    this.propertyId = requireNonEmpty(options.propertyId, "propertyId");
    this.componentType = options.componentType;
    this.componentCount = requireInteger(
      options.componentCount,
      "componentCount",
      1,
    );
    this.normalized = options.normalized;
    this.data = options.data;
    Object.freeze(this);
  }
}

interface FeatureTablePayloadOptions {
  id: DecodedAssetId;
  featureCount: number;
  schemaFingerprint: string;
  properties: readonly FeatureTableProperty[];
}

class FeatureTablePayload {
  readonly id: DecodedAssetId;
  readonly featureCount: number;
  readonly schemaFingerprint: string;
  readonly properties: readonly FeatureTableProperty[];

  constructor(options: FeatureTablePayloadOptions) {
    if (options.id.family !== ResourceFamily.FEATURE_TABLE) {
      throw new Error(
        "FeatureTablePayload requires a FEATURE_TABLE DecodedAssetId.",
      );
    }
    const propertyIds = new Set<string>();
    for (const property of options.properties) {
      if (propertyIds.has(property.propertyId)) {
        throw new Error(
          `Duplicate feature-table property ${property.propertyId}.`,
        );
      }
      propertyIds.add(property.propertyId);
    }
    this.id = options.id;
    this.featureCount = requireInteger(options.featureCount, "featureCount");
    this.schemaFingerprint = requireNonEmpty(
      options.schemaFingerprint,
      "schemaFingerprint",
    );
    this.properties = Object.freeze(Array.from(options.properties));
    Object.freeze(this);
  }
}

type DecodedPayload =
  GeometryPayload | TexturePayload | TerrainPayload | FeatureTablePayload;

export {
  DecodedAssetId,
  DecodedColorSpace,
  DecodedComponentType,
  DecodedTextureFormat,
  FeatureTablePayload,
  FeatureTableProperty,
  GeometryAttributeSemantic,
  GeometryPayload,
  GeometryTopology,
  ImmutableDecodedBytes,
  TerrainPayload,
  TextureMipPayload,
  TexturePayload,
};
export type {
  DecodedAssetIdOptions,
  DecodedByteSource,
  DecodedColorSpace as DecodedColorSpaceId,
  DecodedComponentType as DecodedComponentTypeId,
  DecodedGeometryAttributeOptions,
  DecodedPayload,
  DecodedTextureFormat as DecodedTextureFormatId,
  FeatureTablePayloadOptions,
  FeatureTablePropertyOptions,
  GeometryAttributeSemantic as GeometryAttributeSemanticId,
  GeometryPayloadOptions,
  GeometryTopology as GeometryTopologyId,
  TerrainPayloadOptions,
  TextureMipPayloadOptions,
  TexturePayloadOptions,
};
export { DecodedGeometryAttribute };
