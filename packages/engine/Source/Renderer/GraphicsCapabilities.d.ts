export interface KTX2TranscodeTargets {
  readonly s3tc: boolean;
  readonly pvrtc: boolean;
  readonly astc: boolean;
  readonly etc: boolean;
  readonly etc1: boolean;
  readonly bc7: boolean;
  readonly cacheKey: string;
}

export interface GraphicsCapabilitiesRecord {
  readonly maximumCombinedTextureImageUnits: number;
  readonly maximumCubeMapSize: number;
  readonly maximumFragmentUniformVectors: number;
  readonly maximumTextureImageUnits: number;
  readonly maximumRenderbufferSize: number;
  readonly maximumTextureSize: number;
  readonly maximum3DTextureSize: number;
  readonly maximumArrayTextureLayers: number;
  readonly maximumVaryingVectors: number;
  readonly maximumVertexAttributes: number;
  readonly maximumVertexTextureImageUnits: number;
  readonly maximumVertexUniformVectors: number;
  readonly minimumAliasedLineWidth: number;
  readonly maximumAliasedLineWidth: number;
  readonly minimumAliasedPointSize: number;
  readonly maximumAliasedPointSize: number;
  readonly maximumViewportWidth: number;
  readonly maximumViewportHeight: number;
  readonly maximumTextureFilterAnisotropy: number;
  readonly maximumDrawBuffers: number;
  readonly maximumColorAttachments: number;
  readonly maximumSamples: number;
  readonly highpFloatSupported: boolean;
  readonly highpIntSupported: boolean;
  readonly ktx2TranscodeTargets: KTX2TranscodeTargets;
  readonly ktx2TranscodeTargetKey: string;
  readonly supportsBasis: boolean;
}

declare const GraphicsCapabilities: {
  readonly EMPTY: GraphicsCapabilitiesRecord;
  create(
    options?: Partial<GraphicsCapabilitiesRecord>,
  ): GraphicsCapabilitiesRecord;
  fromWebGPUDevice(device: GPUDevice): GraphicsCapabilitiesRecord;
  createKTX2TranscodeTargets(
    formats?: Partial<KTX2TranscodeTargets>,
  ): KTX2TranscodeTargets;
};

export default GraphicsCapabilities;
