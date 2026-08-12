export interface VoxelDisposableContent {
  destroy?: () => unknown;
  isDestroyed?: () => boolean;
}

export interface VoxelResourceLifecycle {
  readonly device: GPUDevice;
  readonly resourceGeneration: number;
  epoch: number;
  detached: boolean;
  readonly contentRefCounts: Map<VoxelDisposableContent, number>;
  readonly disposedContents: WeakSet<VoxelDisposableContent>;
  slotGenerations: Float64Array;
  atlasReuseEpoch: number;
  contentRevision: number;
}

export interface VoxelAtlasDemandState {
  lastDemandFrame: number;
}

export interface VoxelAsyncFailureState {
  error: Error | null;
  reported: boolean;
}

export const VOXEL_PICK_SLOT_REUSE_GUARD_FRAMES: number;

export function createVoxelResourceLifecycle(
  device: GPUDevice,
  resourceGeneration: number,
  slotCapacity?: number,
): VoxelResourceLifecycle;

export function createVoxelAsyncFailureState(): VoxelAsyncFailureState;

export function recordVoxelAsyncFailure(
  lifecycle: VoxelResourceLifecycle,
  token: number,
  state: VoxelAsyncFailureState,
  reason: unknown,
): Error | null;

export function resetVoxelAsyncFailure(state: VoxelAsyncFailureState): void;

export function takeVoxelAsyncFailure(
  state: VoxelAsyncFailureState,
): Error | null;

export function ensureVoxelAtlasSlotCapacity(
  lifecycle: VoxelResourceLifecycle,
  slotCapacity: number,
): void;

export function isVoxelResourceLifecycleCurrent(
  lifecycle: VoxelResourceLifecycle,
  device: GPUDevice,
  resourceGeneration: number,
): boolean;

export function captureVoxelResourceLifecycleToken(
  lifecycle: VoxelResourceLifecycle,
): number;

export function isVoxelResourceLifecycleTokenCurrent(
  lifecycle: VoxelResourceLifecycle,
  token: number,
): boolean;

export function detachVoxelResourceLifecycle(
  lifecycle: VoxelResourceLifecycle,
): void;

export function disposeAllVoxelContents(
  lifecycle: VoxelResourceLifecycle,
): void;

export function disposeVoxelContentOnce(
  lifecycle: VoxelResourceLifecycle,
  content: VoxelDisposableContent,
): void;

export function disposeUnpublishedVoxelContent(
  lifecycle: VoxelResourceLifecycle,
  content: VoxelDisposableContent,
): void;

export function retainVoxelContent(
  lifecycle: VoxelResourceLifecycle,
  content: VoxelDisposableContent,
): boolean;

export function tryRetainVoxelContentForToken(
  lifecycle: VoxelResourceLifecycle,
  token: number,
  content: VoxelDisposableContent,
): boolean;

export function releaseVoxelContent(
  lifecycle: VoxelResourceLifecycle,
  content: VoxelDisposableContent | null,
): void;

export function publishVoxelAtlasSlot(
  lifecycle: VoxelResourceLifecycle,
  slot: number,
): number;

export function retireVoxelAtlasSlot(
  lifecycle: VoxelResourceLifecycle,
  slot: number,
  generation: number,
): boolean;

export function stampVoxelAtlasDemandFrame(
  states: readonly VoxelAtlasDemandState[],
  demandLevel: number,
  demandMask: Uint8Array | null,
  frameIndex: number,
): number;

export function selectVoxelAtlasLruVictim(
  slots: ArrayLike<number>,
  states: readonly VoxelAtlasDemandState[],
  frameIndex: number,
): number;

export function isVoxelAtlasSlotCurrent(
  lifecycle: VoxelResourceLifecycle,
  slot: number,
  generation: number,
): boolean;

export function isVoxelAtlasSlotPickSafe(
  lifecycle: VoxelResourceLifecycle,
  slot: number,
  generation: number,
): boolean;

declare const WebGPUVoxelResourceLifecycle: {
  VOXEL_PICK_SLOT_REUSE_GUARD_FRAMES: typeof VOXEL_PICK_SLOT_REUSE_GUARD_FRAMES;
  captureVoxelResourceLifecycleToken: typeof captureVoxelResourceLifecycleToken;
  createVoxelAsyncFailureState: typeof createVoxelAsyncFailureState;
  createVoxelResourceLifecycle: typeof createVoxelResourceLifecycle;
  detachVoxelResourceLifecycle: typeof detachVoxelResourceLifecycle;
  disposeAllVoxelContents: typeof disposeAllVoxelContents;
  disposeUnpublishedVoxelContent: typeof disposeUnpublishedVoxelContent;
  disposeVoxelContentOnce: typeof disposeVoxelContentOnce;
  ensureVoxelAtlasSlotCapacity: typeof ensureVoxelAtlasSlotCapacity;
  isVoxelAtlasSlotCurrent: typeof isVoxelAtlasSlotCurrent;
  isVoxelAtlasSlotPickSafe: typeof isVoxelAtlasSlotPickSafe;
  isVoxelResourceLifecycleCurrent: typeof isVoxelResourceLifecycleCurrent;
  isVoxelResourceLifecycleTokenCurrent: typeof isVoxelResourceLifecycleTokenCurrent;
  publishVoxelAtlasSlot: typeof publishVoxelAtlasSlot;
  recordVoxelAsyncFailure: typeof recordVoxelAsyncFailure;
  releaseVoxelContent: typeof releaseVoxelContent;
  retireVoxelAtlasSlot: typeof retireVoxelAtlasSlot;
  resetVoxelAsyncFailure: typeof resetVoxelAsyncFailure;
  retainVoxelContent: typeof retainVoxelContent;
  selectVoxelAtlasLruVictim: typeof selectVoxelAtlasLruVictim;
  stampVoxelAtlasDemandFrame: typeof stampVoxelAtlasDemandFrame;
  takeVoxelAsyncFailure: typeof takeVoxelAsyncFailure;
  tryRetainVoxelContentForToken: typeof tryRetainVoxelContentForToken;
};

export default WebGPUVoxelResourceLifecycle;
