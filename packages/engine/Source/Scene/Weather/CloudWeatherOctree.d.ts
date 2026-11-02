export interface CloudWeatherOctreeOptions {
  equatorialRadius: number;
  polarRadius: number;
  bottom: number;
  top: number;
  blockSize?: number;
  tightBounds?: boolean;
  baseHeightStrength?: number;
  layers?: number[][];
  verticalHeights?: Uint8Array;
}

export interface CloudWeatherOctreeNode {
  min: number[];
  max: number[];
  escape: number;
  region: number;
  maximumCoverage: number;
}

export function buildCloudWeatherOctree(
  weather: Uint8Array,
  width: number,
  height: number,
  options: CloudWeatherOctreeOptions,
): {
  root: unknown;
  nodes: CloudWeatherOctreeNode[];
  regions: {
    min: number[];
    max: number[];
    texels: number[];
    id: number;
    maximumCoverage: number;
  }[];
  tightBounds: boolean;
  verticalBounds: boolean;
  refinements: number;
};

export default buildCloudWeatherOctree;
