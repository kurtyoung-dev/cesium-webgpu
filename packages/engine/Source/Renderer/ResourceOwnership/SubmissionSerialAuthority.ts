/// <reference types="@webgpu/types" />

import {
  RealizationLease,
  type SubmissionLeaseUse,
} from "./RealizationLease.js";

const authoritiesByQueue = new WeakMap<
  GPUQueue,
  Map<number, SubmissionSerialAuthority>
>();

function requireSerial(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

interface RetirementRecord {
  readonly serial: number;
  readonly destroy: () => void;
  ran: boolean;
}

interface SerialWaiter {
  readonly serial: number;
  readonly resolve: () => void;
}

interface SubmissionSerialDiagnostics {
  readonly deviceGeneration: number;
  readonly lastSubmittedSerial: number;
  readonly completedSerial: number;
  readonly pendingRetirements: number;
  readonly pendingWaiters: number;
  readonly drainInFlight: boolean;
  readonly drainCount: number;
  readonly retirementErrorCount: number;
  readonly lastDrainError: unknown | null;
}

/**
 * Provisional resource retention for one encoder. It must be submitted or
 * explicitly abandoned; both paths release every provisional reference.
 */
class ProvisionalEncoderLease {
  readonly #authorityIdentity: object;
  readonly #uses = new Map<object, SubmissionLeaseUse>();
  #open = true;

  constructor(authorityIdentity: object) {
    this.#authorityIdentity = authorityIdentity;
  }

  use<T extends object>(lease: RealizationLease<T>): this {
    if (!this.#open) {
      throw new Error("A closed encoder lease cannot retain resources.");
    }
    const submissionUse = lease.retainForSubmission();
    if (this.#uses.has(submissionUse.identity)) {
      submissionUse.release();
    } else {
      this.#uses.set(submissionUse.identity, submissionUse);
    }
    return this;
  }

  abandon(): boolean {
    if (!this.#open) {
      return false;
    }
    this.#open = false;
    for (const submissionUse of this.#uses.values()) {
      submissionUse.release();
    }
    this.#uses.clear();
    return true;
  }

  /** @internal Called only by the authority that created this tracker. */
  commit(authorityIdentity: object, serial: number): void {
    if (authorityIdentity !== this.#authorityIdentity) {
      throw new Error(
        "Encoder lease was submitted through a different queue authority.",
      );
    }
    if (!this.#open) {
      throw new Error("Encoder lease was already submitted or abandoned.");
    }
    this.#open = false;
    try {
      for (const submissionUse of this.#uses.values()) {
        submissionUse.markSubmitted(serial);
      }
    } finally {
      for (const submissionUse of this.#uses.values()) {
        submissionUse.release();
      }
      this.#uses.clear();
    }
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get retainedResourceCount(): number {
    return this.#uses.size;
  }

  /** @internal Allows submit to fail before touching the wrong physical queue. */
  belongsTo(authorityIdentity: object): boolean {
    return this.#authorityIdentity === authorityIdentity;
  }
}

/**
 * One monotonic serial and retirement service per physical queue generation.
 *
 * This is an explicit adoption API. It deliberately does not replace or
 * monkeypatch the browser-owned `GPUQueue.submit` method.
 */
class SubmissionSerialAuthority {
  readonly deviceGeneration: number;
  readonly #queue: GPUQueue;
  readonly #identity = {};
  readonly #retirements: RetirementRecord[] = [];
  readonly #waiters: SerialWaiter[] = [];
  readonly #retirementErrors: unknown[] = [];
  #lastSubmittedSerial = 0;
  #completedSerial = 0;
  #drainPromise: Promise<void> | null = null;
  #drainCount = 0;
  #lastDrainError: unknown | null = null;

  private constructor(queue: GPUQueue, deviceGeneration: number) {
    this.#queue = queue;
    this.deviceGeneration = requireSerial(deviceGeneration, "deviceGeneration");
    if (this.deviceGeneration === 0) {
      throw new Error("deviceGeneration must be greater than zero.");
    }
  }

  static forQueue(
    queue: GPUQueue,
    deviceGeneration: number,
  ): SubmissionSerialAuthority {
    requireSerial(deviceGeneration, "deviceGeneration");
    let generations = authoritiesByQueue.get(queue);
    if (generations === undefined) {
      generations = new Map<number, SubmissionSerialAuthority>();
      authoritiesByQueue.set(queue, generations);
    }
    const existing = generations.get(deviceGeneration);
    if (existing !== undefined) {
      return existing;
    }
    const authority = new SubmissionSerialAuthority(queue, deviceGeneration);
    generations.set(deviceGeneration, authority);
    return authority;
  }

  beginEncoder(): ProvisionalEncoderLease {
    return new ProvisionalEncoderLease(this.#identity);
  }

  /**
   * Submit through the physical queue and stamp every provisional use with one
   * serial only after the browser accepts the submission synchronously.
   */
  submit(
    encoderLease: ProvisionalEncoderLease,
    commandBuffers: readonly GPUCommandBuffer[],
  ): number {
    if (!encoderLease.isOpen) {
      throw new Error("Encoder lease was already submitted or abandoned.");
    }
    if (!encoderLease.belongsTo(this.#identity)) {
      throw new Error(
        "Encoder lease cannot be submitted through a different queue authority.",
      );
    }
    if (this.#lastSubmittedSerial === Number.MAX_SAFE_INTEGER) {
      throw new Error("Submission serial space is exhausted.");
    }
    try {
      this.#queue.submit(commandBuffers);
    } catch (error) {
      encoderLease.abandon();
      throw error;
    }
    const serial = this.#lastSubmittedSerial + 1;
    this.#lastSubmittedSerial = serial;
    encoderLease.commit(this.#identity, serial);
    return serial;
  }

  retireAfter(serial: number, destroy: () => void): void {
    requireSerial(serial, "retirement serial");
    if (serial > this.#lastSubmittedSerial) {
      throw new Error(
        "Cannot retire after a serial that has not been submitted.",
      );
    }
    const record: RetirementRecord = { serial, destroy, ran: false };
    if (serial <= this.#completedSerial) {
      this.#runRetirement(record);
      return;
    }
    this.#retirements.push(record);
    this.#ensureDrain();
  }

  waitForSerial(serial: number): Promise<void> {
    requireSerial(serial, "wait serial");
    if (serial > this.#lastSubmittedSerial) {
      return Promise.reject(
        new Error("Cannot wait for a serial that has not been submitted."),
      );
    }
    if (serial <= this.#completedSerial) {
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve) => {
      this.#waiters.push({ serial, resolve });
    });
    this.#ensureDrain();
    return promise;
  }

  async drain(): Promise<void> {
    await this.waitForSerial(this.#lastSubmittedSerial);
  }

  get lastSubmittedSerial(): number {
    return this.#lastSubmittedSerial;
  }

  get completedSerial(): number {
    return this.#completedSerial;
  }

  getDiagnostics(): SubmissionSerialDiagnostics {
    return Object.freeze({
      deviceGeneration: this.deviceGeneration,
      lastSubmittedSerial: this.#lastSubmittedSerial,
      completedSerial: this.#completedSerial,
      pendingRetirements: this.#retirements.length,
      pendingWaiters: this.#waiters.length,
      drainInFlight: this.#drainPromise !== null,
      drainCount: this.#drainCount,
      retirementErrorCount: this.#retirementErrors.length,
      lastDrainError: this.#lastDrainError,
    });
  }

  #ensureDrain(): void {
    if (this.#drainPromise !== null) {
      return;
    }
    const hasPendingWork =
      this.#retirements.some(
        (retirement) => retirement.serial > this.#completedSerial,
      ) ||
      this.#waiters.some((waiter) => waiter.serial > this.#completedSerial);
    if (!hasPendingWork) {
      return;
    }

    const drainThrough = this.#lastSubmittedSerial;
    this.#drainCount++;
    this.#drainPromise = this.#queue
      .onSubmittedWorkDone()
      .then(() => {
        this.#completeThrough(drainThrough);
      })
      .catch((error: unknown) => {
        // Device loss invalidates the old generation, making its resources safe
        // to destroy. Preserve the error in diagnostics while unblocking teardown.
        this.#lastDrainError = error;
        this.#completeThrough(drainThrough);
      })
      .finally(() => {
        this.#drainPromise = null;
        this.#ensureDrain();
      });
  }

  #completeThrough(serial: number): void {
    this.#completedSerial = Math.max(this.#completedSerial, serial);
    for (let index = this.#waiters.length - 1; index >= 0; index--) {
      const waiter = this.#waiters[index];
      if (waiter.serial <= this.#completedSerial) {
        this.#waiters.splice(index, 1);
        waiter.resolve();
      }
    }
    for (let index = this.#retirements.length - 1; index >= 0; index--) {
      const retirement = this.#retirements[index];
      if (retirement.serial <= this.#completedSerial) {
        this.#retirements.splice(index, 1);
        this.#runRetirement(retirement);
      }
    }
  }

  #runRetirement(record: RetirementRecord): void {
    if (record.ran) {
      return;
    }
    record.ran = true;
    try {
      record.destroy();
    } catch (error: unknown) {
      this.#retirementErrors.push(error);
    }
  }
}

export { ProvisionalEncoderLease, SubmissionSerialAuthority };
export type { SubmissionSerialDiagnostics };
export default SubmissionSerialAuthority;
