import assert from "node:assert/strict";

import {
  BackendDomain,
  BackendKind,
} from "../packages/engine/Source/Renderer/ResourceOwnership/BackendDomain.ts";
import {
  DecodedAssetId,
  DecodedColorSpace,
  DecodedComponentType,
  DecodedGeometryAttribute,
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
} from "../packages/engine/Source/Renderer/ResourceOwnership/DecodedPayload.ts";
import {
  RealizationDescriptor,
  RealizationKind,
} from "../packages/engine/Source/Renderer/ResourceOwnership/RealizationDescriptor.ts";
import {
  RealizationShadowCache,
  StaleBackendDomainError,
} from "../packages/engine/Source/Renderer/ResourceOwnership/RealizationShadowCache.ts";
import {
  RESOURCE_FAMILY_VALUES,
  ResourceFamily,
  type ResourceFamilyId,
} from "../packages/engine/Source/Renderer/ResourceOwnership/ResourceFamily.ts";
import {
  NativeCoverageProof,
  propagateResourceOwnershipToken,
  RequiredRenderPass,
  RequiredSceneMode,
  ResourceCoverageRequirement,
  ResourceFamilyOwnershipRule,
  ResourceOwnershipMode,
  ResourceOwnershipPolicy,
  ResourceOwnershipTelemetry,
  ResourceOwnershipToken,
  type ResourceOwnershipModeId,
} from "../packages/engine/Source/Renderer/ResourceOwnership/ResourceOwnershipPolicy.ts";
import { SubmissionSerialAuthority } from "../packages/engine/Source/Renderer/ResourceOwnership/SubmissionSerialAuthority.ts";

interface TestResource {
  readonly id: string;
}

class ControlledQueue {
  submitCount = 0;
  completionCallbackCount = 0;
  throwOnSubmit = false;
  readonly #completionResolvers: Array<() => void> = [];

  submit(_commandBuffers: readonly GPUCommandBuffer[]): void {
    if (this.throwOnSubmit) {
      throw new Error("submit rejected");
    }
    this.submitCount++;
  }

  onSubmittedWorkDone(): Promise<void> {
    this.completionCallbackCount++;
    return new Promise<void>((resolve) => {
      this.#completionResolvers.push(resolve);
    });
  }

  completeNext(): void {
    const resolve = this.#completionResolvers.shift();
    if (resolve === undefined) {
      throw new Error("No queue completion is pending.");
    }
    resolve();
  }

  get pendingCompletions(): number {
    return this.#completionResolvers.length;
  }
}

function asGpuQueue(queue: ControlledQueue): GPUQueue {
  return queue as unknown as GPUQueue;
}

function makeDomain(
  contextIdentity: string,
  contextGeneration: number,
  deviceIdentity = "device-a",
  deviceGeneration = 1,
): BackendDomain {
  return new BackendDomain({
    backend: BackendKind.WEBGPU,
    contextIdentity,
    contextGeneration,
    deviceIdentity,
    deviceGeneration,
    capabilityTier: "core:timestamp-query",
  });
}

function makeRules(): readonly ResourceFamilyOwnershipRule[] {
  return RESOURCE_FAMILY_VALUES.map(
    (family) =>
      new ResourceFamilyOwnershipRule({
        family,
        nativeSupported: true,
        nativeDeviceShareable:
          family === ResourceFamily.GEOMETRY ||
          family === ResourceFamily.TEXTURE ||
          family === ResourceFamily.TERRAIN,
      }),
  );
}

function makePolicy(
  mode: ResourceOwnershipModeId,
  domain: BackendDomain,
): ResourceOwnershipPolicy {
  return new ResourceOwnershipPolicy({
    mode,
    domain,
    familyRules: makeRules(),
  });
}

function makeRequirement(
  pass: (typeof RequiredRenderPass)[keyof typeof RequiredRenderPass],
  sceneMode: (typeof RequiredSceneMode)[keyof typeof RequiredSceneMode],
  variant: string,
): ResourceCoverageRequirement {
  return new ResourceCoverageRequirement({
    pass,
    sceneMode,
    materialFingerprint: `material:${variant}`,
    customShaderFingerprint: `custom:${variant}`,
    featureVariantFingerprint: `feature:${variant}`,
    targetFingerprint: `target:${variant}`,
    translucencyFingerprint: `translucency:${variant}`,
  });
}

const requiredCoverage = Object.freeze([
  makeRequirement(RequiredRenderPass.COLOR, RequiredSceneMode.SCENE3D, "base"),
  makeRequirement(RequiredRenderPass.PICK, RequiredSceneMode.SCENE3D, "pick"),
  makeRequirement(
    RequiredRenderPass.SHADOW,
    RequiredSceneMode.SCENE3D,
    "shadow",
  ),
  makeRequirement(
    RequiredRenderPass.CLASSIFICATION_TARGET,
    RequiredSceneMode.SCENE2D,
    "classification",
  ),
  makeRequirement(
    RequiredRenderPass.TRANSLUCENCY,
    RequiredSceneMode.MORPHING,
    "morph-material",
  ),
]);

function makeDecodedId(
  family: ResourceFamilyId = ResourceFamily.GEOMETRY,
): DecodedAssetId {
  return new DecodedAssetId({
    family,
    logicalAssetId: "asset://shared/42",
    sourceFingerprint: "sha256:source",
    decodeFingerprint: "decoder-v3:exact-output",
    revision: 7,
  });
}

function makeToken(
  policy: ResourceOwnershipPolicy,
  nativeCoverage: readonly ResourceCoverageRequirement[],
  deviceSharingApproved: boolean,
  logicalResourceId = "logical-resource-42",
): ResourceOwnershipToken {
  const domain = policy.captureDomain(
    ResourceFamily.GEOMETRY,
    deviceSharingApproved,
  );
  return new ResourceOwnershipToken({
    family: ResourceFamily.GEOMETRY,
    logicalResourceId,
    logicalVersion: 3,
    recoveryEpoch: 1,
    deviceSharingApproved,
    domain,
    decodedAssetId: makeDecodedId(),
    requiredCoverage,
    nativeCoverage: new NativeCoverageProof({
      domain,
      implementationFingerprint: "native-geometry-v9",
      requirements: nativeCoverage,
    }),
  });
}

function makeDescriptor(mutable = false): RealizationDescriptor {
  return new RealizationDescriptor({
    family: ResourceFamily.GEOMETRY,
    kind: RealizationKind.GEOMETRY,
    usageMask: 0x3c,
    byteLength: 4096,
    width: 4096,
    height: 1,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    mutable,
    formatFingerprint: "vertex:f32x3+index:u32",
    layoutFingerprint: "interleaved-v2:stride32",
    shaderFingerprint: "none",
    renderStateFingerprint: "none",
    variantFingerprint: "rte-high-low",
    updateContractFingerprint: mutable ? "dirty-ranges-v1" : "immutable-v1",
  });
}

function makeAuthority(queue: ControlledQueue, generation = 1) {
  return SubmissionSerialAuthority.forQueue(asGpuQueue(queue), generation);
}

function fakeCommandBuffer(): GPUCommandBuffer {
  return Object.freeze({}) as unknown as GPUCommandBuffer;
}

async function getRejection<T>(promise: Promise<T>): Promise<unknown> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    thrown = error;
  }
  assert.ok(thrown !== undefined);
  return thrown;
}

function testDecodedPayloadImmutability(): void {
  const source = new Uint8Array([1, 2, 3, 4]);
  const immutable = new ImmutableDecodedBytes(source, "bytes:01020304");
  source[0] = 99;
  assert.deepEqual(Array.from(immutable.copyBytes()), [1, 2, 3, 4]);
  const exposedCopy = immutable.copyBytes();
  exposedCopy[1] = 88;
  assert.deepEqual(Array.from(immutable.copyBytes()), [1, 2, 3, 4]);

  const geometryId = makeDecodedId(ResourceFamily.GEOMETRY);
  const attribute = new DecodedGeometryAttribute({
    semantic: GeometryAttributeSemantic.POSITION_HIGH,
    componentType: DecodedComponentType.FLOAT32,
    componentCount: 3,
    normalized: false,
    byteStride: 12,
    data: immutable,
  });
  const geometry = new GeometryPayload({
    id: geometryId,
    attributes: [attribute],
    indices: null,
    indexComponentType: null,
    vertexCount: 1,
    indexCount: 0,
    topology: GeometryTopology.POINT_LIST,
    boundsMinimum: [0, 0, 0],
    boundsMaximum: [1, 1, 1],
  });

  const texture = new TexturePayload({
    id: makeDecodedId(ResourceFamily.TEXTURE),
    format: DecodedTextureFormat.RGBA8_SRGB,
    colorSpace: DecodedColorSpace.SRGB,
    premultipliedAlpha: false,
    mips: [
      new TextureMipPayload({
        level: 0,
        width: 1,
        height: 1,
        depthOrArrayLayers: 1,
        data: immutable,
      }),
    ],
  });

  const terrain = new TerrainPayload({
    id: makeDecodedId(ResourceFamily.TERRAIN),
    encodedVertices: immutable,
    indices: immutable,
    indexComponentType: DecodedComponentType.UINT16,
    vertexEncodingFingerprint: "quantized-mesh-v1",
    minimumHeight: -10,
    maximumHeight: 120,
    childTileMask: 15,
  });

  const featureTable = new FeatureTablePayload({
    id: makeDecodedId(ResourceFamily.FEATURE_TABLE),
    featureCount: 1,
    schemaFingerprint: "schema-v1",
    properties: [
      new FeatureTableProperty({
        propertyId: "temperature",
        componentType: DecodedComponentType.FLOAT32,
        componentCount: 1,
        normalized: false,
        data: immutable,
      }),
    ],
  });

  for (const payload of [geometry, texture, terrain, featureTable]) {
    assert.equal(Object.isFrozen(payload), true);
    assert.equal(Object.isFrozen(payload.id), true);
  }
}

function testOwnershipProofAndPropagation(): void {
  const domain = makeDomain("context-a", 1);
  const mirrored = makePolicy(
    ResourceOwnershipMode.MIRRORED_COMPATIBILITY,
    domain,
  );
  const nativeContext = makePolicy(
    ResourceOwnershipMode.NATIVE_CONTEXT,
    domain,
  );

  const mirroredToken = makeToken(mirrored, requiredCoverage, false);
  const mirroredDecision = mirrored.resolve(mirroredToken);
  assert.equal(mirroredDecision.retainCompatibilityRealization, true);
  assert.equal(mirroredDecision.compatibilitySuppressionProven, false);

  const partialToken = makeToken(
    nativeContext,
    requiredCoverage.slice(0, requiredCoverage.length - 1),
    false,
  );
  const partialDecision = nativeContext.resolve(partialToken);
  assert.equal(partialToken.hasCompleteNativeCoverage, false);
  assert.equal(partialToken.missingNativeCoverage.length, 1);
  assert.equal(partialDecision.retainCompatibilityRealization, true);

  const completeToken = makeToken(nativeContext, requiredCoverage, false);
  const completeDecision = nativeContext.resolve(completeToken);
  assert.equal(completeDecision.retainCompatibilityRealization, false);
  assert.equal(completeDecision.compatibilitySuppressionProven, true);

  const nested = propagateResourceOwnershipToken(completeToken, {
    asynchronous: true,
  });
  assert.equal(nested.resourceOwnershipToken, completeToken);
  assert.equal(Object.isFrozen(nested), true);
  assert.throws(() => propagateResourceOwnershipToken(partialToken, nested));

  const telemetry = new ResourceOwnershipTelemetry();
  telemetry.record(mirroredDecision);
  telemetry.record(partialDecision);
  telemetry.record(completeDecision);
  const geometry = telemetry
    .snapshot()
    .find((entry) => entry.family === ResourceFamily.GEOMETRY);
  assert.equal(geometry?.decisions, 3);
  assert.equal(geometry?.compatibilityRetained, 2);
  assert.equal(geometry?.compatibilitySuppressed, 1);
}

async function acquireResource(
  cache: RealizationShadowCache<TestResource>,
  policy: ResourceOwnershipPolicy,
  token: ResourceOwnershipToken,
  id: string,
  createCount: { value: number },
  destroyCount: { value: number },
) {
  return cache.acquire({
    existingCacheKey: "proven-cache-key:42",
    policy,
    ownershipToken: token,
    descriptor: makeDescriptor(),
    sourceRevision: 7,
    create: async () => {
      createCount.value++;
      return { id };
    },
    destroy: () => {
      destroyCount.value++;
    },
  });
}

async function testDomainSharing(): Promise<void> {
  const queue = new ControlledQueue();
  const authority = makeAuthority(queue);
  assert.equal(makeAuthority(queue), authority);
  assert.notEqual(makeAuthority(queue, 2), authority);

  const cache = new RealizationShadowCache<TestResource>(authority);
  const contextPolicyA = makePolicy(
    ResourceOwnershipMode.NATIVE_CONTEXT,
    makeDomain("context-a", 1),
  );
  const contextPolicyB = makePolicy(
    ResourceOwnershipMode.NATIVE_CONTEXT,
    makeDomain("context-b", 1),
  );
  const tokenA = makeToken(contextPolicyA, requiredCoverage, false);
  const tokenB = makeToken(contextPolicyB, requiredCoverage, false);
  cache.activateDomain(tokenA.domain);
  cache.activateDomain(tokenB.domain);
  const creates = { value: 0 };
  const destroys = { value: 0 };
  const contextLeaseA = await acquireResource(
    cache,
    contextPolicyA,
    tokenA,
    "context-a-resource",
    creates,
    destroys,
  );
  const contextLeaseB = await acquireResource(
    cache,
    contextPolicyB,
    tokenB,
    "context-b-resource",
    creates,
    destroys,
  );
  assert.notEqual(contextLeaseA.resource, contextLeaseB.resource);
  assert.equal(creates.value, 2);

  const devicePolicyA = makePolicy(
    ResourceOwnershipMode.NATIVE_DEVICE,
    makeDomain("context-device-a", 1),
  );
  const devicePolicyB = makePolicy(
    ResourceOwnershipMode.NATIVE_DEVICE,
    makeDomain("context-device-b", 1),
  );
  const deviceTokenA = makeToken(devicePolicyA, requiredCoverage, true);
  const deviceTokenB = makeToken(devicePolicyB, requiredCoverage, true);
  assert.equal(
    deviceTokenA.domain.fingerprint,
    deviceTokenB.domain.fingerprint,
  );
  assert.equal(deviceTokenA.ownershipTokenId, deviceTokenB.ownershipTokenId);
  cache.activateDomain(deviceTokenA.domain);
  const deviceCreates = { value: 0 };
  const deviceDestroys = { value: 0 };
  const deviceLeaseA = await acquireResource(
    cache,
    devicePolicyA,
    deviceTokenA,
    "device-resource",
    deviceCreates,
    deviceDestroys,
  );
  const deviceLeaseB = await acquireResource(
    cache,
    devicePolicyB,
    deviceTokenB,
    "should-not-create",
    deviceCreates,
    deviceDestroys,
  );
  assert.equal(deviceLeaseA.resource, deviceLeaseB.resource);
  assert.equal(deviceCreates.value, 1);

  const otherDevicePolicy = makePolicy(
    ResourceOwnershipMode.NATIVE_DEVICE,
    makeDomain("context-c", 1, "device-b", 1),
  );
  const otherDeviceToken = makeToken(otherDevicePolicy, requiredCoverage, true);
  cache.activateDomain(otherDeviceToken.domain);
  const otherDeviceLease = await acquireResource(
    cache,
    otherDevicePolicy,
    otherDeviceToken,
    "other-device-resource",
    deviceCreates,
    deviceDestroys,
  );
  assert.notEqual(deviceLeaseA.resource, otherDeviceLease.resource);

  for (const lease of [
    contextLeaseA,
    contextLeaseB,
    deviceLeaseA,
    deviceLeaseB,
    otherDeviceLease,
  ]) {
    lease.release();
  }
}

async function testGenerationSafePublishAndStableFailure(): Promise<void> {
  const queue = new ControlledQueue();
  const cache = new RealizationShadowCache<TestResource>(makeAuthority(queue));
  const oldPolicy = makePolicy(
    ResourceOwnershipMode.NATIVE_CONTEXT,
    makeDomain("recovering-context", 1),
  );
  const oldToken = makeToken(oldPolicy, requiredCoverage, false);
  cache.activateDomain(oldToken.domain);

  let resolveCreation: ((resource: TestResource) => void) | undefined;
  const creation = new Promise<TestResource>((resolve) => {
    resolveCreation = resolve;
  });
  let staleDestroyCount = 0;
  const pendingLease = cache.acquire({
    existingCacheKey: "proven-cache-key:stale",
    policy: oldPolicy,
    ownershipToken: oldToken,
    descriptor: makeDescriptor(),
    sourceRevision: 7,
    create: () => creation,
    destroy: () => {
      staleDestroyCount++;
    },
  });

  const recoveredPolicy = makePolicy(
    ResourceOwnershipMode.NATIVE_CONTEXT,
    makeDomain("recovering-context", 2),
  );
  const recoveredToken = makeToken(recoveredPolicy, requiredCoverage, false);
  cache.activateDomain(recoveredToken.domain);
  assert.ok(resolveCreation !== undefined);
  resolveCreation({ id: "stale-resource" });
  const staleError = await getRejection(pendingLease);
  assert.ok(staleError instanceof StaleBackendDomainError);
  assert.equal(staleDestroyCount, 1);

  const failurePolicy = makePolicy(
    ResourceOwnershipMode.NATIVE_CONTEXT,
    makeDomain("failure-context", 1),
  );
  const failureToken = makeToken(failurePolicy, requiredCoverage, false);
  cache.activateDomain(failureToken.domain);
  let attempts = 0;
  const failureOptions = {
    existingCacheKey: "proven-cache-key:failure",
    policy: failurePolicy,
    ownershipToken: failureToken,
    descriptor: makeDescriptor(),
    sourceRevision: 7,
    create: async (): Promise<TestResource> => {
      attempts++;
      throw new Error("creation failed");
    },
    destroy: (): void => {},
  };
  await assert.rejects(cache.acquire(failureOptions), /creation failed/);
  await assert.rejects(cache.acquire(failureOptions), /creation failed/);
  assert.equal(attempts, 1);
}

async function testSubmissionLifetime(): Promise<void> {
  const queue = new ControlledQueue();
  const authority = makeAuthority(queue);
  const cache = new RealizationShadowCache<TestResource>(authority);
  const policy = makePolicy(
    ResourceOwnershipMode.NATIVE_CONTEXT,
    makeDomain("serial-context", 1),
  );
  const token = makeToken(policy, requiredCoverage, false);
  cache.activateDomain(token.domain);

  const creates = { value: 0 };
  const destroys = { value: 0 };
  const lease = await acquireResource(
    cache,
    policy,
    token,
    "serial-resource",
    creates,
    destroys,
  );
  const otherQueue = new ControlledQueue();
  const otherAuthority = makeAuthority(otherQueue);
  const wrongAuthorityEncoder = authority.beginEncoder();
  wrongAuthorityEncoder.use(lease);
  assert.throws(
    () => otherAuthority.submit(wrongAuthorityEncoder, [fakeCommandBuffer()]),
    /different queue authority/,
  );
  assert.equal(otherQueue.submitCount, 0);
  assert.equal(wrongAuthorityEncoder.abandon(), true);

  const encoder = authority.beginEncoder();
  encoder.use(lease).use(lease);
  assert.equal(encoder.retainedResourceCount, 1);
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  cache.retire(lease);
  assert.equal(cache.inspect(lease)?.leaseCount, 1);
  assert.equal(destroys.value, 0);

  const serial = authority.submit(encoder, [fakeCommandBuffer()]);
  assert.equal(serial, 1);
  assert.equal(cache.inspect(lease)?.lastUseSerial, 1);
  assert.equal(cache.inspect(lease)?.leaseCount, 0);
  assert.equal(destroys.value, 0);
  assert.equal(queue.completionCallbackCount, 1);
  assert.equal(queue.pendingCompletions, 1);
  const completed = authority.waitForSerial(serial);
  queue.completeNext();
  await completed;
  assert.equal(destroys.value, 1);
  assert.equal(cache.inspect(lease), null);

  const abandonDestroys = { value: 0 };
  const abandonLease = await acquireResource(
    cache,
    policy,
    makeToken(policy, requiredCoverage, false, "abandoned-resource"),
    "abandoned-resource",
    creates,
    abandonDestroys,
  );
  const abandonedEncoder = authority.beginEncoder();
  abandonedEncoder.use(abandonLease);
  abandonLease.release();
  cache.retire(abandonLease);
  assert.equal(abandonDestroys.value, 0);
  assert.equal(abandonedEncoder.abandon(), true);
  assert.equal(abandonedEncoder.abandon(), false);
  assert.equal(abandonDestroys.value, 1);

  const batchDestroys = { value: 0 };
  const batchTokenA = makeToken(
    policy,
    requiredCoverage,
    false,
    "batch-resource-a",
  );
  const batchTokenB = makeToken(
    policy,
    requiredCoverage,
    false,
    "batch-resource-b",
  );
  const batchLeaseA = await acquireResource(
    cache,
    policy,
    batchTokenA,
    "batch-a",
    creates,
    batchDestroys,
  );
  const batchLeaseB = await acquireResource(
    cache,
    policy,
    batchTokenB,
    "batch-b",
    creates,
    batchDestroys,
  );
  const batchEncoder = authority.beginEncoder();
  batchEncoder.use(batchLeaseA).use(batchLeaseB);
  batchLeaseA.release();
  batchLeaseB.release();
  cache.retire(batchLeaseA);
  cache.retire(batchLeaseB);
  const secondSerial = authority.submit(batchEncoder, [fakeCommandBuffer()]);
  assert.equal(secondSerial, 2);
  assert.equal(queue.completionCallbackCount, 2);
  assert.equal(queue.pendingCompletions, 1);
  const secondCompleted = authority.waitForSerial(secondSerial);
  queue.completeNext();
  await secondCompleted;
  assert.equal(batchDestroys.value, 2);

  const visibleToken = makeToken(
    policy,
    requiredCoverage,
    false,
    "visible-resource",
  );
  const visibleDestroys = { value: 0 };
  const visibleLease = await acquireResource(
    cache,
    policy,
    visibleToken,
    "visible",
    creates,
    visibleDestroys,
  );
  const decisionBefore = policy.resolve(visibleToken);
  const leasesBefore = cache.inspect(visibleLease)?.leaseCount;
  cache.markVisible(visibleLease, 99);
  const decisionAfter = policy.resolve(visibleToken);
  assert.equal(cache.inspect(visibleLease)?.lastVisibleEpoch, 99);
  assert.equal(cache.inspect(visibleLease)?.leaseCount, leasesBefore);
  assert.equal(
    decisionAfter.retainCompatibilityRealization,
    decisionBefore.retainCompatibilityRealization,
  );
  visibleLease.release();
  cache.retire(visibleLease);
  assert.equal(visibleDestroys.value, 1);
}

async function testRejectedSubmitAbandonsProvisionalUses(): Promise<void> {
  const queue = new ControlledQueue();
  const authority = makeAuthority(queue);
  const cache = new RealizationShadowCache<TestResource>(authority);
  const policy = makePolicy(
    ResourceOwnershipMode.NATIVE_CONTEXT,
    makeDomain("rejected-submit-context", 1),
  );
  const token = makeToken(policy, requiredCoverage, false);
  cache.activateDomain(token.domain);
  const creates = { value: 0 };
  const destroys = { value: 0 };
  const lease = await acquireResource(
    cache,
    policy,
    token,
    "rejected-submit",
    creates,
    destroys,
  );
  const encoder = authority.beginEncoder();
  encoder.use(lease);
  lease.release();
  cache.retire(lease);
  queue.throwOnSubmit = true;
  assert.throws(() => authority.submit(encoder, [fakeCommandBuffer()]), {
    message: "submit rejected",
  });
  assert.equal(authority.lastSubmittedSerial, 0);
  assert.equal(destroys.value, 1);
}

async function main(): Promise<void> {
  testDecodedPayloadImmutability();
  testOwnershipProofAndPropagation();
  await testDomainSharing();
  await testGenerationSafePublishAndStableFailure();
  await testSubmissionLifetime();
  await testRejectedSubmitAbandonsProvisionalUses();
  console.log("FAR-200 shadow self-test: all deterministic checks passed.");
}

await main();
