const BackendKind = Object.freeze({
  WEBGL: 1,
  WEBGPU: 2,
} as const);

type BackendKind = (typeof BackendKind)[keyof typeof BackendKind];

const BackendDomainScope = Object.freeze({
  CONTEXT: 1,
  DEVICE: 2,
} as const);

type BackendDomainScope =
  (typeof BackendDomainScope)[keyof typeof BackendDomainScope];

function requireIdentity(value: string, name: string): string {
  if (value.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  return value;
}

function requireGeneration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

interface BackendDomainOptions {
  backend: BackendKind;
  contextIdentity: string;
  contextGeneration: number;
  deviceIdentity: string | null;
  deviceGeneration: number | null;
  capabilityTier: string;
}

interface BackendDomainCaptureOptions {
  backend: BackendKind;
  scope: BackendDomainScope;
  identity: string;
  generation: number;
  capabilityTier: string;
}

/** Immutable generation capture used in tokens and cache keys. */
class BackendDomainCapture {
  readonly backend: BackendKind;
  readonly scope: BackendDomainScope;
  readonly identity: string;
  readonly generation: number;
  readonly capabilityTier: string;
  readonly lineageKey: string;
  readonly fingerprint: string;

  constructor(options: BackendDomainCaptureOptions) {
    this.backend = options.backend;
    this.scope = options.scope;
    this.identity = requireIdentity(options.identity, "identity");
    this.generation = requireGeneration(options.generation, "generation");
    this.capabilityTier = requireIdentity(
      options.capabilityTier,
      "capabilityTier",
    );
    this.lineageKey = JSON.stringify([this.backend, this.scope, this.identity]);
    this.fingerprint = JSON.stringify([
      this.lineageKey,
      this.generation,
      this.capabilityTier,
    ]);
    Object.freeze(this);
  }
}

/**
 * A backend domain carries both context and physical-device identity.
 * Policy selects which immutable capture is legal for each family.
 */
class BackendDomain {
  readonly backend: BackendKind;
  readonly contextIdentity: string;
  readonly contextGeneration: number;
  readonly deviceIdentity: string | null;
  readonly deviceGeneration: number | null;
  readonly capabilityTier: string;

  constructor(options: BackendDomainOptions) {
    const isWebGPU = options.backend === BackendKind.WEBGPU;
    if (
      isWebGPU &&
      (options.deviceIdentity === null || options.deviceGeneration === null)
    ) {
      throw new Error(
        "A WebGPU domain requires device identity and generation.",
      );
    }
    if (
      !isWebGPU &&
      (options.deviceIdentity !== null || options.deviceGeneration !== null)
    ) {
      throw new Error("A WebGL domain cannot claim a shareable device domain.");
    }

    this.backend = options.backend;
    this.contextIdentity = requireIdentity(
      options.contextIdentity,
      "contextIdentity",
    );
    this.contextGeneration = requireGeneration(
      options.contextGeneration,
      "contextGeneration",
    );
    this.deviceIdentity = options.deviceIdentity;
    this.deviceGeneration = options.deviceGeneration;
    this.capabilityTier = requireIdentity(
      options.capabilityTier,
      "capabilityTier",
    );
    Object.freeze(this);
  }

  capture(scope: BackendDomainScope): BackendDomainCapture {
    if (scope === BackendDomainScope.CONTEXT) {
      return new BackendDomainCapture({
        backend: this.backend,
        scope,
        identity: this.contextIdentity,
        generation: this.contextGeneration,
        capabilityTier: this.capabilityTier,
      });
    }

    if (
      this.backend !== BackendKind.WEBGPU ||
      this.deviceIdentity === null ||
      this.deviceGeneration === null
    ) {
      throw new Error("Only WebGPU domains can be captured at device scope.");
    }
    return new BackendDomainCapture({
      backend: this.backend,
      scope,
      identity: this.deviceIdentity,
      generation: this.deviceGeneration,
      capabilityTier: this.capabilityTier,
    });
  }
}

export { BackendDomain, BackendDomainCapture, BackendDomainScope, BackendKind };
export type {
  BackendDomainOptions,
  BackendDomainCaptureOptions,
  BackendDomainScope as BackendDomainScopeId,
  BackendKind as BackendKindId,
};
export default BackendDomain;
