import type { BackendDomainCapture } from "./BackendDomain.js";
import type { RealizationDescriptor } from "./RealizationDescriptor.js";
import {
  RealizationLease,
  type RealizationLeaseTarget,
} from "./RealizationLease.js";
import type {
  ResourceOwnershipPolicy,
  ResourceOwnershipToken,
} from "./ResourceOwnershipPolicy.js";
import { SubmissionSerialAuthority } from "./SubmissionSerialAuthority.js";

const RealizationEntryState = Object.freeze({
  CREATING: "creating",
  READY: "ready",
  RETIRING: "retiring",
  FAILED: "failed",
} as const);

type RealizationEntryState =
  (typeof RealizationEntryState)[keyof typeof RealizationEntryState];

function requireNonEmpty(value: string, name: string): string {
  if (value.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  return value;
}

function requireRevision(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

interface RealizationIdentityOptions {
  existingCacheKey: string;
  policy: ResourceOwnershipPolicy;
  ownershipToken: ResourceOwnershipToken;
  descriptor: RealizationDescriptor;
  sourceRevision: number;
}

/** Exact immutable key layered over an already-proven cache identity. */
class RealizationIdentity {
  readonly existingCacheKey: string;
  readonly ownershipToken: ResourceOwnershipToken;
  readonly domain: BackendDomainCapture;
  readonly descriptor: RealizationDescriptor;
  readonly sourceRevision: number;
  readonly fingerprint: string;

  constructor(options: RealizationIdentityOptions) {
    if (options.ownershipToken.family !== options.descriptor.family) {
      throw new Error("Ownership token and descriptor families must match.");
    }
    if (
      options.descriptor.mutable &&
      options.ownershipToken.deviceSharingApproved
    ) {
      throw new Error(
        "Mutable realizations cannot carry device-sharing approval.",
      );
    }
    const decision = options.policy.resolve(options.ownershipToken);
    if (!decision.createNativeRealization) {
      throw new Error(
        "The ownership policy does not permit a native realization.",
      );
    }
    this.existingCacheKey = requireNonEmpty(
      options.existingCacheKey,
      "existingCacheKey",
    );
    this.ownershipToken = options.ownershipToken;
    this.domain = options.ownershipToken.domain;
    this.descriptor = options.descriptor;
    this.sourceRevision = requireRevision(
      options.sourceRevision,
      "sourceRevision",
    );
    this.fingerprint = JSON.stringify([
      this.existingCacheKey,
      this.ownershipToken.ownershipTokenId,
      this.domain.fingerprint,
      this.descriptor.fingerprint,
      this.sourceRevision,
    ]);
    Object.freeze(this);
  }
}

class StaleBackendDomainError extends Error {
  constructor(domain: BackendDomainCapture) {
    super(
      `Backend domain ${domain.identity} generation ${domain.generation} is stale.`,
    );
    this.name = "StaleBackendDomainError";
  }
}

interface RealizationAcquireOptions<
  T extends object,
> extends RealizationIdentityOptions {
  create: () => Promise<T>;
  destroy: (resource: T) => void;
}

interface RealizationEntrySnapshot {
  readonly state: RealizationEntryState;
  readonly leaseCount: number;
  readonly lastUseSerial: number;
  readonly lastVisibleEpoch: number;
  readonly destroyScheduled: boolean;
  readonly destroyed: boolean;
  readonly error: unknown | null;
}

interface RealizationShadowCacheDiagnostics {
  readonly entries: number;
  readonly creating: number;
  readonly ready: number;
  readonly retiring: number;
  readonly failed: number;
  readonly leases: number;
}

class ShadowRealizationEntry<
  T extends object,
> implements RealizationLeaseTarget<T> {
  readonly leaseIdentity: object = this;
  readonly realizationIdentity: string;
  readonly ownershipToken: ResourceOwnershipToken;
  readonly domain: BackendDomainCapture;
  readonly descriptor: RealizationDescriptor;
  readonly #destroyResource: (resource: T) => void;
  readonly #onZeroLeases: (entry: ShadowRealizationEntry<T>) => void;
  #resource: T | null = null;
  #state: RealizationEntryState = RealizationEntryState.CREATING;
  #leaseCount = 0;
  #lastUseSerial = 0;
  #lastVisibleEpoch = 0;
  #destroyScheduled = false;
  #destroyed = false;
  #error: unknown | null = null;
  #readyPromise: Promise<void> = Promise.resolve();

  constructor(
    identity: RealizationIdentity,
    destroyResource: (resource: T) => void,
    onZeroLeases: (entry: ShadowRealizationEntry<T>) => void,
  ) {
    this.realizationIdentity = identity.fingerprint;
    this.ownershipToken = identity.ownershipToken;
    this.domain = identity.domain;
    this.descriptor = identity.descriptor;
    this.#destroyResource = destroyResource;
    this.#onZeroLeases = onZeroLeases;
  }

  get resource(): T {
    if (this.#resource === null || this.#destroyed) {
      throw new Error("Realization resource is not available.");
    }
    return this.#resource;
  }

  get state(): RealizationEntryState {
    return this.#state;
  }

  get leaseCount(): number {
    return this.#leaseCount;
  }

  get hasResource(): boolean {
    return this.#resource !== null;
  }

  get lastUseSerial(): number {
    return this.#lastUseSerial;
  }

  get readyPromise(): Promise<void> {
    return this.#readyPromise;
  }

  setReadyPromise(promise: Promise<void>): void {
    this.#readyPromise = promise;
  }

  install(resource: T): void {
    if (this.#state !== RealizationEntryState.CREATING) {
      throw new Error("Only a creating realization can publish a resource.");
    }
    this.#resource = resource;
    this.#state = RealizationEntryState.READY;
  }

  fail(error: unknown): void {
    if (this.#state !== RealizationEntryState.CREATING) {
      return;
    }
    this.#error = error;
    this.#state = RealizationEntryState.FAILED;
  }

  beginRetirement(): void {
    if (
      this.#state === RealizationEntryState.READY ||
      this.#state === RealizationEntryState.CREATING
    ) {
      this.#state = RealizationEntryState.RETIRING;
    }
  }

  markDestroyScheduled(): boolean {
    if (this.#destroyScheduled || this.#destroyed) {
      return false;
    }
    this.#destroyScheduled = true;
    return true;
  }

  destroyOnce(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    if (this.#resource !== null) {
      const resource = this.#resource;
      this.#resource = null;
      this.#destroyResource(resource);
    }
  }

  destroyUnpublished(resource: T): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#destroyResource(resource);
  }

  retainLease(): void {
    if (this.#resource === null || this.#destroyed) {
      throw new Error("Cannot retain an unavailable realization.");
    }
    this.#leaseCount++;
  }

  releaseLease(): void {
    if (this.#leaseCount === 0) {
      throw new Error("Realization lease count underflow.");
    }
    this.#leaseCount--;
    if (this.#leaseCount === 0) {
      this.#onZeroLeases(this);
    }
  }

  markSubmitted(serial: number): void {
    if (!Number.isSafeInteger(serial) || serial < 1) {
      throw new Error("Submission serial must be a positive safe integer.");
    }
    this.#lastUseSerial = Math.max(this.#lastUseSerial, serial);
  }

  markVisible(epoch: number): void {
    this.#lastVisibleEpoch = Math.max(
      this.#lastVisibleEpoch,
      requireRevision(epoch, "visibility epoch"),
    );
  }

  snapshot(): RealizationEntrySnapshot {
    return Object.freeze({
      state: this.#state,
      leaseCount: this.#leaseCount,
      lastUseSerial: this.#lastUseSerial,
      lastVisibleEpoch: this.#lastVisibleEpoch,
      destroyScheduled: this.#destroyScheduled,
      destroyed: this.#destroyed,
      error: this.#error,
    });
  }
}

/**
 * Shadow cache over existing proven keys. It changes no production owner and
 * only models generation, deduplication, lease, and retirement behavior.
 */
class RealizationShadowCache<T extends object> {
  readonly #authority: SubmissionSerialAuthority;
  readonly #entries = new Map<string, ShadowRealizationEntry<T>>();
  readonly #activeDomains = new Map<string, BackendDomainCapture>();

  constructor(authority: SubmissionSerialAuthority) {
    this.#authority = authority;
  }

  activateDomain(domain: BackendDomainCapture): void {
    const current = this.#activeDomains.get(domain.lineageKey);
    if (current !== undefined) {
      if (current.fingerprint === domain.fingerprint) {
        return;
      }
      if (domain.generation <= current.generation) {
        throw new Error(
          "Backend domain generations must advance monotonically.",
        );
      }
    }
    this.#activeDomains.set(domain.lineageKey, domain);
    if (current !== undefined) {
      for (const entry of this.#entries.values()) {
        if (
          entry.domain.lineageKey === domain.lineageKey &&
          entry.domain.fingerprint !== domain.fingerprint
        ) {
          this.#retireEntry(entry);
        }
      }
    }
  }

  acquire(options: RealizationAcquireOptions<T>): Promise<RealizationLease<T>> {
    const identity = new RealizationIdentity(options);
    this.#assertDomainCurrent(identity.domain);
    const existing = this.#entries.get(identity.fingerprint);
    if (existing !== undefined) {
      return this.#acquireEntry(existing);
    }

    const entry = new ShadowRealizationEntry(
      identity,
      options.destroy,
      (releasedEntry) => {
        if (releasedEntry.state === RealizationEntryState.RETIRING) {
          this.#scheduleDestroy(releasedEntry);
        }
      },
    );
    this.#entries.set(identity.fingerprint, entry);
    const readyPromise = Promise.resolve()
      .then(options.create)
      .then((resource) => {
        if (
          entry.state !== RealizationEntryState.CREATING ||
          !this.#isDomainCurrent(entry.domain)
        ) {
          entry.destroyUnpublished(resource);
          this.#entries.delete(entry.realizationIdentity);
          throw new StaleBackendDomainError(entry.domain);
        }
        entry.install(resource);
      })
      .catch((error: unknown) => {
        if (entry.state === RealizationEntryState.CREATING) {
          entry.fail(error);
        } else if (entry.state === RealizationEntryState.RETIRING) {
          this.#entries.delete(entry.realizationIdentity);
        }
        throw error;
      });
    entry.setReadyPromise(readyPromise);
    return this.#acquireEntry(entry);
  }

  retire(lease: RealizationLease<T>): void {
    const entry = this.#entries.get(lease.realizationIdentity);
    if (entry === undefined || !lease.isBackedBy(entry.leaseIdentity)) {
      return;
    }
    this.#retireEntry(entry);
  }

  retireDomain(domain: BackendDomainCapture): void {
    const active = this.#activeDomains.get(domain.lineageKey);
    if (active?.fingerprint === domain.fingerprint) {
      this.#activeDomains.delete(domain.lineageKey);
    }
    for (const entry of this.#entries.values()) {
      if (entry.domain.fingerprint === domain.fingerprint) {
        this.#retireEntry(entry);
      }
    }
  }

  markVisible(lease: RealizationLease<T>, epoch: number): void {
    const entry = this.#entries.get(lease.realizationIdentity);
    if (entry === undefined || !lease.isBackedBy(entry.leaseIdentity)) {
      throw new Error("Lease does not belong to this realization cache.");
    }
    entry.markVisible(epoch);
  }

  inspect(lease: RealizationLease<T>): RealizationEntrySnapshot | null {
    const entry = this.#entries.get(lease.realizationIdentity);
    return entry !== undefined && lease.isBackedBy(entry.leaseIdentity)
      ? entry.snapshot()
      : null;
  }

  getDiagnostics(): RealizationShadowCacheDiagnostics {
    let creating = 0;
    let ready = 0;
    let retiring = 0;
    let failed = 0;
    let leases = 0;
    for (const entry of this.#entries.values()) {
      leases += entry.leaseCount;
      switch (entry.state) {
        case RealizationEntryState.CREATING:
          creating++;
          break;
        case RealizationEntryState.READY:
          ready++;
          break;
        case RealizationEntryState.RETIRING:
          retiring++;
          break;
        case RealizationEntryState.FAILED:
          failed++;
          break;
      }
    }
    return Object.freeze({
      entries: this.#entries.size,
      creating,
      ready,
      retiring,
      failed,
      leases,
    });
  }

  #acquireEntry(
    entry: ShadowRealizationEntry<T>,
  ): Promise<RealizationLease<T>> {
    if (entry.state === RealizationEntryState.FAILED) {
      return Promise.reject(entry.snapshot().error);
    }
    if (entry.state === RealizationEntryState.RETIRING) {
      return Promise.reject(new Error("Realization is retiring."));
    }
    return entry.readyPromise.then(() => {
      if (entry.state !== RealizationEntryState.READY) {
        throw new Error("Realization did not publish in the ready state.");
      }
      return new RealizationLease(entry);
    });
  }

  #retireEntry(entry: ShadowRealizationEntry<T>): void {
    if (entry.state === RealizationEntryState.FAILED) {
      this.#entries.delete(entry.realizationIdentity);
      return;
    }
    entry.beginRetirement();
    if (
      entry.leaseCount === 0 &&
      entry.hasResource &&
      entry.state === RealizationEntryState.RETIRING
    ) {
      this.#scheduleDestroy(entry);
    }
  }

  #scheduleDestroy(entry: ShadowRealizationEntry<T>): void {
    if (!entry.markDestroyScheduled()) {
      return;
    }
    this.#authority.retireAfter(entry.lastUseSerial, () => {
      entry.destroyOnce();
      if (this.#entries.get(entry.realizationIdentity) === entry) {
        this.#entries.delete(entry.realizationIdentity);
      }
    });
  }

  #assertDomainCurrent(domain: BackendDomainCapture): void {
    if (!this.#isDomainCurrent(domain)) {
      throw new StaleBackendDomainError(domain);
    }
  }

  #isDomainCurrent(domain: BackendDomainCapture): boolean {
    return (
      this.#activeDomains.get(domain.lineageKey)?.fingerprint ===
      domain.fingerprint
    );
  }
}

export {
  RealizationEntryState,
  RealizationIdentity,
  RealizationShadowCache,
  StaleBackendDomainError,
};
export type {
  RealizationAcquireOptions,
  RealizationEntrySnapshot,
  RealizationEntryState as RealizationEntryStateId,
  RealizationIdentityOptions,
  RealizationShadowCacheDiagnostics,
};
export default RealizationShadowCache;
