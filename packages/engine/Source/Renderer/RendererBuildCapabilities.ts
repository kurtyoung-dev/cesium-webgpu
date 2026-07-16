export interface RendererBuildCapabilities {
  readonly webgl: boolean;
  readonly webgpu: boolean;
}

const rendererBuildCapabilities: RendererBuildCapabilities = Object.freeze({
  webgl: true,
  webgpu: true,
});

export default rendererBuildCapabilities;
