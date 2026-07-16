export interface ClipSpaceConventionRecord {
  readonly id: number;
  readonly name: "webgl" | "webgpu";
  readonly nearDepth: -1 | 0;
  readonly farDepth: 1;
  readonly depthRangeZeroToOne: boolean;
}

declare const ClipSpaceConvention: {
  readonly WEBGL: ClipSpaceConventionRecord;
  readonly WEBGPU: ClipSpaceConventionRecord;
  fromDepthRangeZeroToOne(
    depthRangeZeroToOne: boolean,
  ): ClipSpaceConventionRecord;
  normalize(convention?: ClipSpaceConventionRecord): ClipSpaceConventionRecord;
};

export default ClipSpaceConvention;
