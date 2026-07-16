import type { BackendDomainCapture } from "./BackendDomain.js";
import type { RealizationDescriptor } from "./RealizationDescriptor.js";
import type { ResourceOwnershipToken } from "./ResourceOwnershipPolicy.js";

interface RealizationLeaseTarget<T extends object> {
  readonly leaseIdentity: object;
  readonly realizationIdentity: string;
  readonly resource: T;
  readonly ownershipToken: ResourceOwnershipToken;
  readonly domain: BackendDomainCapture;
  readonly descriptor: RealizationDescriptor;
  retainLease(): void;
  releaseLease(): void;
  markSubmitted(serial: number): void;
}

interface SubmissionLeaseUse {
  readonly identity: object;
  markSubmitted(serial: number): void;
  release(): void;
}

/** A consumer reference whose release operation is safe to call repeatedly. */
class RealizationLease<T extends object> {
  readonly realizationIdentity: string;
  readonly ownershipToken: ResourceOwnershipToken;
  readonly domain: BackendDomainCapture;
  readonly descriptor: RealizationDescriptor;
  readonly #target: RealizationLeaseTarget<T>;
  #released = false;

  constructor(target: RealizationLeaseTarget<T>) {
    this.#target = target;
    this.realizationIdentity = target.realizationIdentity;
    this.ownershipToken = target.ownershipToken;
    this.domain = target.domain;
    this.descriptor = target.descriptor;
    target.retainLease();
  }

  get resource(): T {
    if (this.#released) {
      throw new Error(
        "A released realization lease cannot expose its resource.",
      );
    }
    return this.#target.resource;
  }

  get isReleased(): boolean {
    return this.#released;
  }

  retain(): RealizationLease<T> {
    if (this.#released) {
      throw new Error("A released realization lease cannot be retained.");
    }
    return new RealizationLease(this.#target);
  }

  /** @internal Used by the cache to reject a lease from another cache. */
  isBackedBy(identity: object): boolean {
    return this.#target.leaseIdentity === identity;
  }

  release(): boolean {
    if (this.#released) {
      return false;
    }
    this.#released = true;
    this.#target.releaseLease();
    return true;
  }

  /** @internal Used only by the physical-queue submission authority. */
  retainForSubmission(): SubmissionLeaseUse {
    if (this.#released) {
      throw new Error("A released realization lease cannot be submitted.");
    }
    this.#target.retainLease();
    let released = false;
    return Object.freeze({
      identity: this.#target.leaseIdentity,
      markSubmitted: (serial: number): void => {
        this.#target.markSubmitted(serial);
      },
      release: (): void => {
        if (!released) {
          released = true;
          this.#target.releaseLease();
        }
      },
    });
  }
}

export { RealizationLease };
export type { RealizationLeaseTarget, SubmissionLeaseUse };
export default RealizationLease;
