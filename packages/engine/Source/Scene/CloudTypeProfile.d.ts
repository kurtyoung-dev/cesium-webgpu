// Co-located ambient types for the plain-JS CloudTypeProfile.js. A sibling
// .d.ts overrides JS inference for TypeScript importers, so the WebGPU renderer
// can read `.get(type).shape` and the rest without `any`.

export interface CloudProfile {
  /** Altitude deck (CloudDeck: LOW=0/MID=1/HIGH=2). */
  deck: number;
  /** Height-gradient shape (CloudHeightGradientShape: SLAB=0/BILLOWY=1/TOWERING_ANVIL=2). */
  shape: number;
  /** Base density 0-1. */
  baseDensity: number;
  /** Optical extinction 0-1. */
  extinction: number;
  /** Henyey-Greenstein anisotropy (~0.9 ice / ~0.75 water). */
  phaseG: number;
  /** Erosion style (CloudErosionStyle: FIBROUS=0/PUFFY=1). */
  erosion: number;
}

interface CloudDeckEnum {
  LOW: number;
  MID: number;
  HIGH: number;
  bounds: number[][];
}
interface CloudHeightGradientShapeEnum {
  SLAB: number;
  BILLOWY: number;
  TOWERING_ANVIL: number;
}
interface CloudErosionStyleEnum {
  FIBROUS: number;
  PUFFY: number;
}

export interface CloudFibreMorphology {
  /** Fibrous carve depth in [0,1]; 0 is the identity (PUFFY water genera). */
  strength: number;
  /** Filament length:width aspect ratio along the wind; 1 is isotropic. */
  anisotropy: number;
  /** Fallstreak along-wind lag per unit shell height, in noise units. */
  shear: number;
}

interface CloudTypeProfileStatic {
  PROFILES: ReadonlyArray<CloudProfile>;
  /** Returns the profile for a genus, falling back to CUMULUS if out of range. */
  get(cloudType: number): CloudProfile;
  FIBRE_MORPHOLOGY: ReadonlyArray<CloudFibreMorphology>;
  /** Returns the fibrous-morphology row for a genus, or the identity row. */
  getFibreMorphology(cloudType: number): CloudFibreMorphology;
  CloudDeck: CloudDeckEnum;
  CloudHeightGradientShape: CloudHeightGradientShapeEnum;
  CloudErosionStyle: CloudErosionStyleEnum;
}

declare const CloudTypeProfile: CloudTypeProfileStatic;
export default CloudTypeProfile;
export const CloudDeck: CloudDeckEnum;
export const CloudHeightGradientShape: CloudHeightGradientShapeEnum;
export const CloudErosionStyle: CloudErosionStyleEnum;
