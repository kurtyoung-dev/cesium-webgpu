import {
  BackendDomain,
  BackendDomainCapture,
  BackendDomainScope,
  BackendKind,
  type BackendDomainScopeId,
} from "./BackendDomain.js";
import { DecodedAssetId } from "./DecodedPayload.js";
import {
  RESOURCE_FAMILY_VALUES,
  type ResourceFamilyId,
} from "./ResourceFamily.js";

const ResourceOwnershipMode = Object.freeze({
  MIRRORED_COMPATIBILITY: 1,
  NATIVE_CONTEXT: 2,
  NATIVE_DEVICE: 3,
} as const);

type ResourceOwnershipMode =
  (typeof ResourceOwnershipMode)[keyof typeof ResourceOwnershipMode];

const RequiredRenderPass = Object.freeze({
  COLOR: 1,
  PICK: 2,
  DEPTH_FAIL: 3,
  SHADOW: 4,
  CLASSIFICATION: 5,
  CLASSIFICATION_TARGET: 6,
  TRANSLUCENCY: 7,
  DEPTH_ONLY: 8,
} as const);

type RequiredRenderPass =
  (typeof RequiredRenderPass)[keyof typeof RequiredRenderPass];

const RequiredSceneMode = Object.freeze({
  SCENE3D: 1,
  SCENE2D: 2,
  COLUMBUS_VIEW: 3,
  MORPHING: 4,
} as const);

type RequiredSceneMode =
  (typeof RequiredSceneMode)[keyof typeof RequiredSceneMode];

function requireNonEmpty(value: string, name: string): string {
  if (value.length === 0) {
    throw new Error(`${name} must be explicit and non-empty.`);
  }
  return value;
}

function requireVersion(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

interface ResourceCoverageRequirementOptions {
  pass: RequiredRenderPass;
  sceneMode: RequiredSceneMode;
  materialFingerprint: string;
  customShaderFingerprint: string;
  featureVariantFingerprint: string;
  targetFingerprint: string;
  translucencyFingerprint: string;
}

/** One exact member of the publicly reachable pass/mode/variant union. */
class ResourceCoverageRequirement {
  readonly pass: RequiredRenderPass;
  readonly sceneMode: RequiredSceneMode;
  readonly materialFingerprint: string;
  readonly customShaderFingerprint: string;
  readonly featureVariantFingerprint: string;
  readonly targetFingerprint: string;
  readonly translucencyFingerprint: string;
  readonly fingerprint: string;

  constructor(options: ResourceCoverageRequirementOptions) {
    this.pass = options.pass;
    this.sceneMode = options.sceneMode;
    this.materialFingerprint = requireNonEmpty(
      options.materialFingerprint,
      "materialFingerprint",
    );
    this.customShaderFingerprint = requireNonEmpty(
      options.customShaderFingerprint,
      "customShaderFingerprint",
    );
    this.featureVariantFingerprint = requireNonEmpty(
      options.featureVariantFingerprint,
      "featureVariantFingerprint",
    );
    this.targetFingerprint = requireNonEmpty(
      options.targetFingerprint,
      "targetFingerprint",
    );
    this.translucencyFingerprint = requireNonEmpty(
      options.translucencyFingerprint,
      "translucencyFingerprint",
    );
    this.fingerprint = JSON.stringify([
      this.pass,
      this.sceneMode,
      this.materialFingerprint,
      this.customShaderFingerprint,
      this.featureVariantFingerprint,
      this.targetFingerprint,
      this.translucencyFingerprint,
    ]);
    Object.freeze(this);
  }
}

function copyCoverageUnion(
  coverage: readonly ResourceCoverageRequirement[],
  name: string,
  allowEmpty: boolean,
): readonly ResourceCoverageRequirement[] {
  if (!allowEmpty && coverage.length === 0) {
    throw new Error(`${name} must contain every reachable requirement.`);
  }
  const sorted = Array.from(coverage).sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].fingerprint === sorted[index].fingerprint) {
      throw new Error(`${name} contains a duplicate requirement.`);
    }
  }
  return Object.freeze(sorted);
}

interface NativeCoverageProofOptions {
  domain: BackendDomainCapture;
  implementationFingerprint: string;
  requirements: readonly ResourceCoverageRequirement[];
}

/** Native implementation evidence bound to one backend generation/tier. */
class NativeCoverageProof {
  readonly domain: BackendDomainCapture;
  readonly implementationFingerprint: string;
  readonly requirements: readonly ResourceCoverageRequirement[];
  readonly fingerprint: string;
  readonly #requirementKeys: ReadonlySet<string>;

  constructor(options: NativeCoverageProofOptions) {
    this.domain = options.domain;
    this.implementationFingerprint = requireNonEmpty(
      options.implementationFingerprint,
      "implementationFingerprint",
    );
    this.requirements = copyCoverageUnion(
      options.requirements,
      "native coverage",
      true,
    );
    this.#requirementKeys = new Set(
      this.requirements.map((requirement) => requirement.fingerprint),
    );
    this.fingerprint = JSON.stringify([
      this.domain.fingerprint,
      this.implementationFingerprint,
      this.requirements.map((requirement) => requirement.fingerprint),
    ]);
    Object.freeze(this);
  }

  covers(requirement: ResourceCoverageRequirement): boolean {
    return this.#requirementKeys.has(requirement.fingerprint);
  }
}

interface ResourceOwnershipTokenOptions {
  family: ResourceFamilyId;
  logicalResourceId: string;
  logicalVersion: number;
  recoveryEpoch: number;
  deviceSharingApproved: boolean;
  domain: BackendDomainCapture;
  decodedAssetId: DecodedAssetId;
  requiredCoverage: readonly ResourceCoverageRequirement[];
  nativeCoverage: NativeCoverageProof | null;
}

/** Immutable owner decision input for one logical version/recovery epoch. */
class ResourceOwnershipToken {
  readonly family: ResourceFamilyId;
  readonly logicalResourceId: string;
  readonly logicalVersion: number;
  readonly recoveryEpoch: number;
  readonly deviceSharingApproved: boolean;
  readonly domain: BackendDomainCapture;
  readonly decodedAssetId: DecodedAssetId;
  readonly decodedFingerprint: string;
  readonly requiredCoverage: readonly ResourceCoverageRequirement[];
  readonly nativeCoverage: NativeCoverageProof | null;
  readonly missingNativeCoverage: readonly ResourceCoverageRequirement[];
  readonly hasCompleteNativeCoverage: boolean;
  readonly ownershipTokenId: string;

  constructor(options: ResourceOwnershipTokenOptions) {
    if (options.decodedAssetId.family !== options.family) {
      throw new Error("Ownership token family must match its decoded asset.");
    }
    this.family = options.family;
    this.logicalResourceId = requireNonEmpty(
      options.logicalResourceId,
      "logicalResourceId",
    );
    this.logicalVersion = requireVersion(
      options.logicalVersion,
      "logicalVersion",
    );
    this.recoveryEpoch = requireVersion(options.recoveryEpoch, "recoveryEpoch");
    this.deviceSharingApproved = options.deviceSharingApproved;
    this.domain = options.domain;
    this.decodedAssetId = options.decodedAssetId;
    this.decodedFingerprint = options.decodedAssetId.fingerprint;
    this.requiredCoverage = copyCoverageUnion(
      options.requiredCoverage,
      "required coverage",
      false,
    );
    this.nativeCoverage = options.nativeCoverage;

    const proofMatchesDomain =
      this.nativeCoverage !== null &&
      this.nativeCoverage.domain.fingerprint === this.domain.fingerprint;
    this.missingNativeCoverage = Object.freeze(
      proofMatchesDomain
        ? this.requiredCoverage.filter(
            (requirement) => !this.nativeCoverage?.covers(requirement),
          )
        : Array.from(this.requiredCoverage),
    );
    this.hasCompleteNativeCoverage =
      proofMatchesDomain && this.missingNativeCoverage.length === 0;
    this.ownershipTokenId = JSON.stringify([
      this.family,
      this.logicalResourceId,
      this.logicalVersion,
      this.recoveryEpoch,
      this.deviceSharingApproved,
      this.domain.fingerprint,
      this.decodedFingerprint,
      this.requiredCoverage.map((requirement) => requirement.fingerprint),
      this.nativeCoverage?.fingerprint ?? null,
    ]);
    Object.freeze(this);
  }
}

interface ResourceFamilyOwnershipRuleOptions {
  family: ResourceFamilyId;
  nativeSupported: boolean;
  nativeDeviceShareable: boolean;
}

class ResourceFamilyOwnershipRule {
  readonly family: ResourceFamilyId;
  readonly nativeSupported: boolean;
  readonly nativeDeviceShareable: boolean;

  constructor(options: ResourceFamilyOwnershipRuleOptions) {
    if (options.nativeDeviceShareable && !options.nativeSupported) {
      throw new Error("A device-shareable family must be natively supported.");
    }
    this.family = options.family;
    this.nativeSupported = options.nativeSupported;
    this.nativeDeviceShareable = options.nativeDeviceShareable;
    Object.freeze(this);
  }
}

const OwnershipDecisionReason = Object.freeze({
  WEBGL_CONTEXT: 1,
  MIRRORED_ROLLOUT: 2,
  NATIVE_UNSUPPORTED: 3,
  NATIVE_COVERAGE_INCOMPLETE: 4,
  NATIVE_COVERAGE_COMPLETE: 5,
} as const);

type OwnershipDecisionReason =
  (typeof OwnershipDecisionReason)[keyof typeof OwnershipDecisionReason];

interface ResourceOwnershipDecisionOptions {
  family: ResourceFamilyId;
  mode: ResourceOwnershipMode;
  nativeScope: BackendDomainScopeId;
  createNativeRealization: boolean;
  retainCompatibilityRealization: boolean;
  compatibilitySuppressionProven: boolean;
  reason: OwnershipDecisionReason;
}

class ResourceOwnershipDecision {
  readonly family: ResourceFamilyId;
  readonly mode: ResourceOwnershipMode;
  readonly nativeScope: BackendDomainScopeId;
  readonly createNativeRealization: boolean;
  readonly retainCompatibilityRealization: boolean;
  readonly compatibilitySuppressionProven: boolean;
  readonly reason: OwnershipDecisionReason;

  constructor(options: ResourceOwnershipDecisionOptions) {
    this.family = options.family;
    this.mode = options.mode;
    this.nativeScope = options.nativeScope;
    this.createNativeRealization = options.createNativeRealization;
    this.retainCompatibilityRealization =
      options.retainCompatibilityRealization;
    this.compatibilitySuppressionProven =
      options.compatibilitySuppressionProven;
    this.reason = options.reason;
    Object.freeze(this);
  }
}

interface ResourceOwnershipPolicyOptions {
  mode: ResourceOwnershipMode;
  domain: BackendDomain;
  familyRules: readonly ResourceFamilyOwnershipRule[];
}

/** Context-frozen rollout policy and complete family capability matrix. */
class ResourceOwnershipPolicy {
  readonly mode: ResourceOwnershipMode;
  readonly domain: BackendDomain;
  readonly familyRules: readonly ResourceFamilyOwnershipRule[];
  readonly #rulesByFamily: ReadonlyMap<
    ResourceFamilyId,
    ResourceFamilyOwnershipRule
  >;

  constructor(options: ResourceOwnershipPolicyOptions) {
    const rulesByFamily = new Map<
      ResourceFamilyId,
      ResourceFamilyOwnershipRule
    >();
    for (const rule of options.familyRules) {
      if (rulesByFamily.has(rule.family)) {
        throw new Error(`Duplicate ownership rule for family ${rule.family}.`);
      }
      rulesByFamily.set(rule.family, rule);
    }
    for (const family of RESOURCE_FAMILY_VALUES) {
      if (!rulesByFamily.has(family)) {
        throw new Error(`Missing ownership rule for family ${family}.`);
      }
    }
    if (rulesByFamily.size !== RESOURCE_FAMILY_VALUES.length) {
      throw new Error(
        "Ownership capability matrix contains an unknown family.",
      );
    }
    this.mode = options.mode;
    this.domain = options.domain;
    this.familyRules = Object.freeze(
      RESOURCE_FAMILY_VALUES.map((family) => {
        const rule = rulesByFamily.get(family);
        if (rule === undefined) {
          throw new Error(`Missing ownership rule for family ${family}.`);
        }
        return rule;
      }),
    );
    this.#rulesByFamily = rulesByFamily;
    Object.freeze(this);
  }

  nativeScopeFor(
    family: ResourceFamilyId,
    deviceSharingApproved = false,
  ): BackendDomainScopeId {
    const rule = this.#rulesByFamily.get(family);
    if (rule === undefined) {
      throw new Error(`No ownership rule exists for family ${family}.`);
    }
    return this.domain.backend === BackendKind.WEBGPU &&
      this.mode === ResourceOwnershipMode.NATIVE_DEVICE &&
      deviceSharingApproved &&
      rule.nativeDeviceShareable
      ? BackendDomainScope.DEVICE
      : BackendDomainScope.CONTEXT;
  }

  captureDomain(
    family: ResourceFamilyId,
    deviceSharingApproved = false,
  ): BackendDomainCapture {
    return this.domain.capture(
      this.nativeScopeFor(family, deviceSharingApproved),
    );
  }

  resolve(token: ResourceOwnershipToken): ResourceOwnershipDecision {
    const rule = this.#rulesByFamily.get(token.family);
    if (rule === undefined) {
      throw new Error(`No ownership rule exists for family ${token.family}.`);
    }
    const scope = this.nativeScopeFor(
      token.family,
      token.deviceSharingApproved,
    );
    const expectedDomain = this.domain.capture(scope);
    if (expectedDomain.fingerprint !== token.domain.fingerprint) {
      throw new Error(
        "Ownership token belongs to a different backend domain or generation.",
      );
    }

    if (this.domain.backend === BackendKind.WEBGL) {
      return new ResourceOwnershipDecision({
        family: token.family,
        mode: this.mode,
        nativeScope: scope,
        createNativeRealization: true,
        retainCompatibilityRealization: false,
        compatibilitySuppressionProven: true,
        reason: OwnershipDecisionReason.WEBGL_CONTEXT,
      });
    }

    if (!rule.nativeSupported) {
      return new ResourceOwnershipDecision({
        family: token.family,
        mode: this.mode,
        nativeScope: scope,
        createNativeRealization: false,
        retainCompatibilityRealization: true,
        compatibilitySuppressionProven: false,
        reason: OwnershipDecisionReason.NATIVE_UNSUPPORTED,
      });
    }

    if (this.mode === ResourceOwnershipMode.MIRRORED_COMPATIBILITY) {
      return new ResourceOwnershipDecision({
        family: token.family,
        mode: this.mode,
        nativeScope: scope,
        createNativeRealization: true,
        retainCompatibilityRealization: true,
        compatibilitySuppressionProven: false,
        reason: OwnershipDecisionReason.MIRRORED_ROLLOUT,
      });
    }

    const complete = token.hasCompleteNativeCoverage;
    return new ResourceOwnershipDecision({
      family: token.family,
      mode: this.mode,
      nativeScope: scope,
      createNativeRealization: true,
      retainCompatibilityRealization: !complete,
      compatibilitySuppressionProven: complete,
      reason: complete
        ? OwnershipDecisionReason.NATIVE_COVERAGE_COMPLETE
        : OwnershipDecisionReason.NATIVE_COVERAGE_INCOMPLETE,
    });
  }
}

interface NestedOwnershipCarrier {
  readonly resourceOwnershipToken: ResourceOwnershipToken;
}

function propagateResourceOwnershipToken<T extends object>(
  token: ResourceOwnershipToken,
  nestedOptions: T,
): Readonly<T & NestedOwnershipCarrier> {
  const existing = Reflect.get(nestedOptions, "resourceOwnershipToken") as
    unknown | undefined;
  if (existing !== undefined && existing !== token) {
    throw new Error("Nested resource already carries a different owner token.");
  }
  return Object.freeze(
    Object.assign({}, nestedOptions, { resourceOwnershipToken: token }),
  );
}

interface ResourceOwnershipFamilyTelemetry {
  readonly family: ResourceFamilyId;
  readonly decisions: number;
  readonly compatibilityRetained: number;
  readonly compatibilitySuppressed: number;
  readonly contextScoped: number;
  readonly deviceScoped: number;
}

class MutableFamilyTelemetry {
  decisions = 0;
  compatibilityRetained = 0;
  compatibilitySuppressed = 0;
  contextScoped = 0;
  deviceScoped = 0;
}

/** Per-context shadow telemetry; intentionally not a process singleton. */
class ResourceOwnershipTelemetry {
  readonly #byFamily = new Map<ResourceFamilyId, MutableFamilyTelemetry>();

  constructor() {
    for (const family of RESOURCE_FAMILY_VALUES) {
      this.#byFamily.set(family, new MutableFamilyTelemetry());
    }
  }

  record(decision: ResourceOwnershipDecision): void {
    const counters = this.#byFamily.get(decision.family);
    if (counters === undefined) {
      throw new Error(`Unknown resource family ${decision.family}.`);
    }
    counters.decisions++;
    if (decision.retainCompatibilityRealization) {
      counters.compatibilityRetained++;
    }
    if (decision.compatibilitySuppressionProven) {
      counters.compatibilitySuppressed++;
    }
    if (decision.nativeScope === BackendDomainScope.DEVICE) {
      counters.deviceScoped++;
    } else {
      counters.contextScoped++;
    }
  }

  snapshot(): readonly ResourceOwnershipFamilyTelemetry[] {
    return Object.freeze(
      RESOURCE_FAMILY_VALUES.map((family) => {
        const counters = this.#byFamily.get(family);
        if (counters === undefined) {
          throw new Error(`Unknown resource family ${family}.`);
        }
        return Object.freeze({ family, ...counters });
      }),
    );
  }
}

export {
  NativeCoverageProof,
  OwnershipDecisionReason,
  propagateResourceOwnershipToken,
  RequiredRenderPass,
  RequiredSceneMode,
  ResourceCoverageRequirement,
  ResourceFamilyOwnershipRule,
  ResourceOwnershipDecision,
  ResourceOwnershipMode,
  ResourceOwnershipPolicy,
  ResourceOwnershipTelemetry,
  ResourceOwnershipToken,
};
export type {
  NativeCoverageProofOptions,
  NestedOwnershipCarrier,
  OwnershipDecisionReason as OwnershipDecisionReasonId,
  RequiredRenderPass as RequiredRenderPassId,
  RequiredSceneMode as RequiredSceneModeId,
  ResourceCoverageRequirementOptions,
  ResourceFamilyOwnershipRuleOptions,
  ResourceOwnershipDecisionOptions,
  ResourceOwnershipFamilyTelemetry,
  ResourceOwnershipMode as ResourceOwnershipModeId,
  ResourceOwnershipPolicyOptions,
  ResourceOwnershipTokenOptions,
};
export default ResourceOwnershipPolicy;
