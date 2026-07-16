# FAR-200 submission-authority adoption inventory — 2026-07-13

## Status and boundary

`SubmissionSerialAuthority` is shadow infrastructure. It deliberately uses an
explicit `authority.submit(encoderLease, commandBuffers)` API instead of
replacing or monkeypatching the browser-owned `GPUQueue.submit` method. Host
object method replacement is not a safe production invariant across WebGPU
implementations.

Consequently, the authority does **not** yet observe the direct submissions
below. Its monotonic serial, provisional lease, completion, and retirement
tests cover adopted calls only. Full physical-queue coverage must not be
claimed until every site is routed through the one authority obtained from
`SubmissionSerialAuthority.forQueue(queue, deviceGeneration)`.

## Direct `GPUQueue.submit` sites not yet adopted

The implementation-time static scan found 52 executable calls. Comment-only
examples are excluded.

| Production source | Direct submit lines |
| --- | --- |
| `Renderer/WebGPU/Stubs/WebGLStubShader.ts` | 796 |
| `Renderer/WebGPU/Stubs/WebGLStubTexture.ts` | 921 |
| `Renderer/WebGPU/WebGPUBrdfLutGenerator.ts` | 323, 365 |
| `Renderer/WebGPU/WebGPUBufferMapper.ts` | 156, 189 |
| `Renderer/WebGPU/WebGPUClippingPolygonCollection.ts` | 314 |
| `Renderer/WebGPU/WebGPUCloudNoiseResources.ts` | 212 |
| `Renderer/WebGPU/WebGPUCloudRenderer.ts` | 1441 |
| `Renderer/WebGPU/WebGPUComputeEngine.ts` | 172, 233 |
| `Renderer/WebGPU/WebGPUComputeInstanceRenderer.ts` | 1074, 1431 |
| `Renderer/WebGPU/WebGPUContactShadowsEffect.ts` | 283 |
| `Renderer/WebGPU/WebGPUContext.ts` | 2097, 2849 |
| `Renderer/WebGPU/WebGPUCSMRenderer.ts` | 1005, 1053 |
| `Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts` | 505 |
| `Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts` | 939, 1543, 1655 |
| `Renderer/WebGPU/WebGPUEffectsBindGroup.js` | 463, 609, 686 |
| `Renderer/WebGPU/WebGPUEntityClusterDispatcher.ts` | 343 |
| `Renderer/WebGPU/WebGPUFeatureIdTexture.ts` | 225 |
| `Renderer/WebGPU/WebGPUFlowFieldRenderer.ts` | 662 |
| `Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` | 1657 |
| `Renderer/WebGPU/WebGPUIBLPipeline.ts` | 314, 405, 545 |
| `Renderer/WebGPU/WebGPUImageryReprojection.ts` | 252 |
| `Renderer/WebGPU/WebGPUMipmapGenerator.ts` | 253 |
| `Renderer/WebGPU/WebGPUNPROutlineEffect.ts` | 232 |
| `Renderer/WebGPU/WebGPUOceanRenderer.ts` | 848 |
| `Renderer/WebGPU/WebGPUPickFramebuffer.ts` | 459, 624, 707, 796 |
| `Renderer/WebGPU/WebGPUPointCloudRenderer.ts` | 1760, 1980, 2102 |
| `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` | 2579 |
| `Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js` | 679 |
| `Renderer/WebGPU/WebGPUSSREffect.ts` | 324 |
| `Renderer/WebGPU/WebGPUTextureAtlas.ts` | 315 |
| `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` | 1452, 1685 |
| `Renderer/WebGPU/WebGPUVolumetricFogResources.ts` | 324 |
| `Renderer/WebGPU/WebGPUWeatherRenderer.ts` | 396 |
| `Scene/PickDepth.js` | 300 |

Re-run the inventory before adoption work because concurrent renderer changes
can move or add sites:

```powershell
rg -n --glob '*.{js,ts}' '\.submit\s*\(' packages/engine/Source/Renderer/WebGPU packages/engine/Source/Scene
```

## Adoption invariant

Each encoder creator obtains a provisional encoder lease before recording,
retains every referenced `RealizationLease`, and then takes exactly one of two
paths:

- submit through the authority, which assigns one serial and atomically stamps
  all retained uses before releasing their provisional references; or
- abandon the encoder lease, which releases provisional references without a
  serial.

Initialization, normal-frame, and readback submissions must share the same
authority for the physical queue/device generation. Retirement uses the
authority's coalesced queue-wide completion drain; resources must not attach
individual `onSubmittedWorkDone()` callbacks.
