/**
 * Generation-safe asynchronous texture lifecycle for the WebGPU Moon.
 * This module deliberately owns no decoded-source cache and no GPU
 * sharing: it only decides whether one Moon/cache/device request is still
 * allowed to stage or publish its candidate. When hooks provide a decoded
 * source lease, the lifecycle retains that lease synchronously so retirement
 * can cancel pending work without waiting for its readiness Promise.
 *
 * Published textures remain renderer-cache owned. The lifecycle owns each
 * request's decoded-source lease until its queue copy settles, plus candidates
 * between `createCandidate` and transactional publication. This makes
 * stale/destroy races deterministic without retaining an unbounded replay
 * journal.
 *
 * @private
 */

const MoonTextureChannel = Object.freeze({
  ALBEDO: "albedo",
  NORMAL: "normal",
});

const NO_RECONCILIATION_WORK = Object.freeze({
  retireCurrent: false,
  started: false,
});
const RETIRE_RECONCILIATION_WORK = Object.freeze({
  retireCurrent: true,
  started: false,
});
const STARTED_RECONCILIATION_WORK = Object.freeze({
  retireCurrent: false,
  started: true,
});

/**
 * Wrap a cache-owned decoded source for WebGPU upload. Only a distinct
 * preparation result is request-owned; the shared source must be retired by
 * its lease and never closed directly by the renderer.
 *
 * @private
 */
function createWebGPUMoonUploadSource(sharedSource, uploadSource) {
  return {
    uploadSource,
    ownedUploadSource:
      uploadSource !== sharedSource &&
      typeof uploadSource?.close === "function",
  };
}

/** @private */
function releaseWebGPUMoonUploadSource(source) {
  if (
    source.ownedUploadSource &&
    typeof source.uploadSource?.close === "function"
  ) {
    source.uploadSource.close();
  }
  source.ownedUploadSource = false;
  source.uploadSource = undefined;
}

let nextCacheSerial = 1;

function createChannel(name) {
  return {
    name,
    requestSerial: 0,
    desiredUrl: undefined,
    desiredPairKey: undefined,
    demanded: false,
    request: undefined,
    staged: undefined,
    currentIdentity: undefined,
    failedIdentity: undefined,
    state: "idle",
    gpuRealizations: 0,
    successfulUploads: 0,
    publications: 0,
    staleCandidateDestroys: 0,
    failedCandidateDestroys: 0,
    cancellations: 0,
    lastCancellationReason: undefined,
    reconcileOptions: {
      url: undefined,
      pairKey: undefined,
      demanded: false,
      hooks: undefined,
    },
  };
}

/**
 * A stable, collision-free key for the effective Moon albedo/normal pair.
 * Strength/demand is intentionally absent: toggling relief off must not
 * supersede matching work that was validly started while it was on.
 *
 * @param {string|undefined} albedoUrl
 * @param {string|undefined} normalUrl
 * @returns {string}
 * @private
 */
function createWebGPUMoonTexturePairKey(albedoUrl, normalUrl) {
  return JSON.stringify([albedoUrl ?? null, normalUrl ?? null]);
}

/**
 * @param {object} owner
 * @param {object} cache
 * @param {object} context
 * @param {GPUDevice|object} device
 * @param {number} resourceGeneration
 * @returns {object}
 * @private
 */
function createWebGPUMoonTextureLifecycle(
  owner,
  cache,
  context,
  device,
  resourceGeneration,
) {
  const lifecycle = {
    owner,
    cache,
    context,
    device,
    resourceGeneration,
    cacheSerial: nextCacheSerial++,
    retired: false,
    channels: {
      albedo: createChannel(MoonTextureChannel.ALBEDO),
      normal: createChannel(MoonTextureChannel.NORMAL),
    },
  };
  cache._moonTextureLifecycle = lifecycle;
  return lifecycle;
}

function getChannel(lifecycle, channelName) {
  const channel = lifecycle.channels[channelName];
  if (!channel) {
    throw new Error(`Unknown WebGPU Moon texture channel: ${channelName}`);
  }
  return channel;
}

function isWebGPUMoonTextureLifecycleCurrent(lifecycle) {
  const context = lifecycle.context;
  return (
    lifecycle.retired !== true &&
    lifecycle.owner?._webgpuCache === lifecycle.cache &&
    lifecycle.cache?._moonTextureLifecycle === lifecycle &&
    context?.device === lifecycle.device &&
    (context?.resourceGeneration ?? 0) === lifecycle.resourceGeneration
  );
}

function identityMatchesDesired(channel, identity) {
  return (
    identity !== undefined &&
    identity.exactUrl === channel.desiredUrl &&
    identity.effectivePair === channel.desiredPairKey
  );
}

function isRequestCurrent(lifecycle, channel, request) {
  const identity = request.identity;
  return (
    isWebGPUMoonTextureLifecycleCurrent(lifecycle) &&
    channel.request === request &&
    channel.requestSerial === identity.requestSerial &&
    identity.owner === lifecycle.owner &&
    identity.context === lifecycle.context &&
    identity.device === lifecycle.device &&
    identity.resourceGeneration === lifecycle.resourceGeneration &&
    identity.cacheSerial === lifecycle.cacheSerial &&
    identityMatchesDesired(channel, identity)
  );
}

function reportError(hooks, error, phase, identity) {
  try {
    hooks.onError?.(error, phase, identity);
  } catch (_ignored) {
    // Diagnostics must never take ownership of the request's failure path.
  }
}

function deliverAsyncSettlement(request) {
  if (
    !request.asyncSettled ||
    !request.asyncTokenAssigned ||
    request.asyncSettlementDelivered
  ) {
    return;
  }
  request.asyncSettlementDelivered = true;
  const hooks = request.hooks;
  try {
    if (request.asyncSettlementSucceeded) {
      hooks.resolveAsync?.(request.asyncToken);
    } else {
      hooks.rejectAsync?.(request.asyncToken, request.asyncSettlementError);
    }
  } catch (monitorError) {
    reportError(hooks, monitorError, "async-monitor", request.identity);
  }
}

function settleAsync(request, succeeded, error) {
  if (request.asyncSettled) {
    return;
  }
  request.asyncSettled = true;
  request.asyncSettlementSucceeded = succeeded;
  request.asyncSettlementError = error;
  deliverAsyncSettlement(request);
}

function destroyCandidateOnce(wrapper, hooks, reason, identity) {
  if (wrapper === undefined || wrapper.destroyed || wrapper.published) {
    return false;
  }
  wrapper.destroyed = true;
  try {
    hooks.destroyCandidate(wrapper.value);
  } catch (error) {
    reportError(hooks, error, `destroy-${reason}`, identity);
  }
  return true;
}

function releaseRequestSource(request) {
  if (request.sourceReleased || request.source === undefined) {
    return;
  }
  request.sourceReleased = true;
  try {
    request.hooks.releaseSource?.(request.source, request.identity);
  } catch (error) {
    reportError(request.hooks, error, "source-release", request.identity);
  }
  request.source = undefined;
}

function releaseRequestSourceLease(request) {
  if (!request.usesSourceLease || request.sourceLeaseReleased) {
    return;
  }
  if (request.preparingSource) {
    // `prepareSource` may still be reading the cache-owned source while it
    // creates a request-owned derivative. Keep the lease reachable on this
    // stale request until preparation settles; the resolve/reject continuations
    // below re-enter this function after clearing `preparingSource`.
    request.sourceLeaseReleasePending = true;
    return;
  }
  request.sourceLeaseReleased = true;
  request.sourceLeaseReleasePending = false;
  const lease = request.sourceLease;
  request.sourceLease = undefined;
  if (lease === undefined) {
    return;
  }
  try {
    lease.release();
  } catch (error) {
    reportError(request.hooks, error, "source-lease-release", request.identity);
  }
}

function releaseFetchedSource(request) {
  if (request.preparingSource || request.fetchedSource === undefined) {
    return;
  }
  const fetchedSource = request.fetchedSource;
  request.fetchedSource = undefined;
  try {
    request.hooks.releaseFetchedSource?.(fetchedSource, request.identity);
  } catch (error) {
    reportError(
      request.hooks,
      error,
      "fetched-source-release",
      request.identity,
    );
  }
}

function supersedeRequest(channel, reason) {
  const request = channel.request;
  channel.request = undefined;
  if (request === undefined) {
    return;
  }
  if (
    destroyCandidateOnce(
      request.candidate,
      request.hooks,
      "superseded",
      request.identity,
    )
  ) {
    channel.staleCandidateDestroys++;
  }
  request.candidate = undefined;
  releaseFetchedSource(request);
  releaseRequestSource(request);
  releaseRequestSourceLease(request);
  channel.cancellations++;
  channel.lastCancellationReason = reason;
  // AsyncResourceMonitor has no cancellation terminal. Resolve expected
  // supersession/retirement so failure telemetry remains reserved for actual
  // fetch/upload errors; the channel's cancellation counter preserves the
  // lifecycle diagnostic.
  settleAsync(request, true);
}

function abandonStaleRequest(channel, request, reason) {
  if (channel.request === request) {
    supersedeRequest(channel, reason);
    return;
  }
  // A reentrant hook may already have installed a replacement request or
  // retired the channel. Cleanup remains idempotent and must never touch that
  // newer owner.
  if (
    destroyCandidateOnce(
      request.candidate,
      request.hooks,
      "stale-hook",
      request.identity,
    )
  ) {
    channel.staleCandidateDestroys++;
  }
  request.candidate = undefined;
  releaseFetchedSource(request);
  releaseRequestSource(request);
  releaseRequestSourceLease(request);
  settleAsync(request, true);
}

function destroyStaged(channel, reason) {
  const staged = channel.staged;
  channel.staged = undefined;
  if (staged === undefined) {
    return;
  }
  if (
    destroyCandidateOnce(
      staged.candidate,
      staged.hooks,
      reason,
      staged.identity,
    )
  ) {
    channel.staleCandidateDestroys++;
  }
}

function finishFailedRequest(lifecycle, channel, request, error, phase) {
  if (
    destroyCandidateOnce(
      request.candidate,
      request.hooks,
      "failed",
      request.identity,
    )
  ) {
    channel.failedCandidateDestroys++;
  }
  request.candidate = undefined;
  releaseFetchedSource(request);
  releaseRequestSource(request);
  releaseRequestSourceLease(request);
  settleAsync(request, false, error);
  if (isRequestCurrent(lifecycle, channel, request)) {
    channel.request = undefined;
    channel.failedIdentity = request.identity;
    channel.state = "failed";
    reportError(request.hooks, error, phase, request.identity);
  }
}

function startRequest(lifecycle, channel, hooks) {
  const identity = Object.freeze({
    owner: lifecycle.owner,
    effectivePair: channel.desiredPairKey,
    exactUrl: channel.desiredUrl,
    requestSerial: channel.requestSerial,
    backend: "webgpu",
    context: lifecycle.context,
    device: lifecycle.device,
    resourceGeneration: lifecycle.resourceGeneration,
    cacheSerial: lifecycle.cacheSerial,
    channel: channel.name,
  });
  const request = {
    identity,
    hooks,
    candidate: undefined,
    fetchedSource: undefined,
    preparingSource: false,
    source: undefined,
    sourceReleased: false,
    usesSourceLease: false,
    sourceLease: undefined,
    sourceLeaseReleased: false,
    sourceLeaseReleasePending: false,
    asyncToken: undefined,
    asyncTokenAssigned: false,
    asyncSettled: false,
    asyncSettlementSucceeded: undefined,
    asyncSettlementError: undefined,
    asyncSettlementDelivered: false,
  };
  channel.request = request;
  channel.state = "source-pending";

  let asyncToken;
  try {
    asyncToken = hooks.beginAsync?.(identity);
  } catch (error) {
    reportError(hooks, error, "async-monitor", identity);
  }
  request.asyncToken = asyncToken;
  request.asyncTokenAssigned = true;
  // `beginAsync` may synchronously notify a subscriber which supersedes or
  // retires this request before returning its token. Deliver that already-
  // chosen terminal to the returned token, then stop before acquiring source
  // ownership for an orphan.
  deliverAsyncSettlement(request);
  if (!isRequestCurrent(lifecycle, channel, request)) {
    abandonStaleRequest(
      channel,
      request,
      "WebGPU Moon request invalidated during async monitor begin",
    );
    return;
  }

  let sourcePromise;
  if (typeof hooks.acquireSource === "function") {
    try {
      // This call must remain synchronous. Keeping the lease on `request`
      // before observing its Promise is what lets supersession/teardown release
      // a pending decode instead of pinning it behind an unresolved await.
      const lease = hooks.acquireSource(identity.exactUrl, identity);
      if (lease === undefined || lease === null) {
        throw new TypeError(
          "WebGPU Moon acquireSource must return an immediate releasable lease.",
        );
      }
      request.usesSourceLease = true;
      request.sourceLease = lease;
      // `acquireSource` is deliberately synchronous and may itself trigger
      // cancellation observers. A lease returned after reentrant retirement
      // belongs to this stale request and must be released before readiness.
      if (!isRequestCurrent(lifecycle, channel, request)) {
        abandonStaleRequest(
          channel,
          request,
          "WebGPU Moon request invalidated during source acquisition",
        );
        return;
      }
      if (typeof lease.release !== "function" || !("ready" in Object(lease))) {
        throw new TypeError(
          "WebGPU Moon acquireSource must return an immediate releasable lease.",
        );
      }
      const readyPromise = lease.ready;
      if (!isRequestCurrent(lifecycle, channel, request)) {
        abandonStaleRequest(
          channel,
          request,
          "WebGPU Moon request invalidated while observing source readiness",
        );
        return;
      }
      sourcePromise = Promise.resolve(readyPromise).then(function () {
        return lease.source;
      });
      if (!isRequestCurrent(lifecycle, channel, request)) {
        abandonStaleRequest(
          channel,
          request,
          "WebGPU Moon request invalidated while chaining source readiness",
        );
        // A hostile thenable can reenter during Promise assimilation. Observe
        // its eventual rejection even though the request no longer owns it.
        sourcePromise.catch(function () {});
        return;
      }
    } catch (error) {
      finishFailedRequest(lifecycle, channel, request, error, "source-fetch");
      return;
    }
  } else {
    sourcePromise = Promise.resolve().then(function () {
      return hooks.fetchImage(identity.exactUrl, identity);
    });
  }

  sourcePromise
    .then(function (image) {
      if (!request.usesSourceLease) {
        request.fetchedSource = image;
      }
      if (!isRequestCurrent(lifecycle, channel, request)) {
        releaseFetchedSource(request);
        releaseRequestSourceLease(request);
        settleAsync(request, true);
        return undefined;
      }
      channel.state = "source-ready";
      let preparedSource;
      request.preparingSource = true;
      try {
        preparedSource = hooks.prepareSource?.(image, identity) ?? image;
      } catch (error) {
        request.preparingSource = false;
        finishFailedRequest(
          lifecycle,
          channel,
          request,
          error,
          "source-prepare",
        );
        return undefined;
      }
      return Promise.resolve(preparedSource).then(
        function (source) {
          request.preparingSource = false;
          // Successful preparation transfers a raw-fetch result to the
          // prepared-source release path. A leased source remains cache-owned;
          // its hook may own and close only a distinct prepared derivative.
          request.fetchedSource = undefined;
          request.source = source;
          if (!isRequestCurrent(lifecycle, channel, request)) {
            releaseRequestSource(request);
            releaseRequestSourceLease(request);
            settleAsync(request, true);
            return undefined;
          }

          let value;
          try {
            value = hooks.createCandidate(source, identity);
          } catch (error) {
            finishFailedRequest(
              lifecycle,
              channel,
              request,
              error,
              "candidate-create",
            );
            return undefined;
          }
          request.candidate = {
            value,
            destroyed: false,
            published: false,
          };
          channel.gpuRealizations++;

          if (!isRequestCurrent(lifecycle, channel, request)) {
            if (
              destroyCandidateOnce(
                request.candidate,
                hooks,
                "stale-before-upload",
                identity,
              )
            ) {
              channel.staleCandidateDestroys++;
            }
            request.candidate = undefined;
            releaseRequestSource(request);
            releaseRequestSourceLease(request);
            settleAsync(request, true);
            return undefined;
          }

          // Real hooks must issue their queue copy synchronously here. Any
          // asynchronous decode/orientation work belongs in prepareSource so a
          // teardown cannot later copy into a candidate it already destroyed.
          channel.state = "upload-pending";
          let uploadPromise;
          try {
            uploadPromise = hooks.uploadCandidate(source, value, identity);
          } catch (error) {
            finishFailedRequest(
              lifecycle,
              channel,
              request,
              error,
              "candidate-upload",
            );
            return undefined;
          }
          return Promise.resolve(uploadPromise).then(
            function (uploadResult) {
              channel.successfulUploads++;
              releaseRequestSource(request);
              releaseRequestSourceLease(request);
              if (request.candidate === undefined) {
                return;
              }
              if (!isRequestCurrent(lifecycle, channel, request)) {
                if (
                  destroyCandidateOnce(
                    request.candidate,
                    hooks,
                    "stale-after-upload",
                    identity,
                  )
                ) {
                  channel.staleCandidateDestroys++;
                }
                request.candidate = undefined;
                settleAsync(request, true);
                return;
              }

              let candidateValue = request.candidate.value;
              try {
                candidateValue =
                  hooks.finalizeCandidate?.(
                    candidateValue,
                    uploadResult,
                    identity,
                  ) ?? candidateValue;
                request.candidate.value = candidateValue;
              } catch (error) {
                finishFailedRequest(
                  lifecycle,
                  channel,
                  request,
                  error,
                  "candidate-finalize",
                );
                return;
              }

              if (!isRequestCurrent(lifecycle, channel, request)) {
                if (
                  destroyCandidateOnce(
                    request.candidate,
                    hooks,
                    "stale-after-finalize",
                    identity,
                  )
                ) {
                  channel.staleCandidateDestroys++;
                }
                request.candidate = undefined;
                settleAsync(request, true);
                return;
              }

              channel.staged = {
                identity,
                candidate: request.candidate,
                hooks,
              };
              request.candidate = undefined;
              channel.request = undefined;
              channel.failedIdentity = undefined;
              channel.state = "candidate-ready";
              settleAsync(request, true);
              try {
                hooks.notifyReady?.(identity);
              } catch (error) {
                reportError(hooks, error, "notify-ready", identity);
              }
            },
            function (error) {
              finishFailedRequest(
                lifecycle,
                channel,
                request,
                error,
                "candidate-upload",
              );
            },
          );
        },
        function (error) {
          request.preparingSource = false;
          finishFailedRequest(
            lifecycle,
            channel,
            request,
            error,
            "source-prepare",
          );
        },
      );
    })
    .catch(function (error) {
      finishFailedRequest(lifecycle, channel, request, error, "source-fetch");
    });
}

/**
 * Reconcile one channel's exact desired identity and, when demanded, start at
 * most one request for that identity. Returns whether a mismatched published
 * texture must be replaced by the channel placeholder now.
 *
 * @param {object} lifecycle
 * @param {string} channelName
 * @param {object} options
 * @returns {{retireCurrent: boolean, started: boolean}}
 * @private
 */
function reconcileWebGPUMoonTextureChannel(lifecycle, channelName, options) {
  if (!isWebGPUMoonTextureLifecycleCurrent(lifecycle)) {
    return NO_RECONCILIATION_WORK;
  }
  const channel = getChannel(lifecycle, channelName);
  const desiredChanged =
    channel.desiredUrl !== options.url ||
    channel.desiredPairKey !== options.pairKey;

  if (desiredChanged) {
    channel.requestSerial++;
    supersedeRequest(channel, `WebGPU Moon ${channel.name} request superseded`);
    destroyStaged(channel, "superseded-staged");
    channel.desiredUrl = options.url;
    channel.desiredPairKey = options.pairKey;
    channel.failedIdentity = undefined;
    channel.state = "idle";
  }
  channel.demanded = options.demanded !== false;

  const hasCurrent = channel.currentIdentity !== undefined;
  const currentMatches = identityMatchesDesired(
    channel,
    channel.currentIdentity,
  );
  if (options.url === undefined) {
    return hasCurrent ? RETIRE_RECONCILIATION_WORK : NO_RECONCILIATION_WORK;
  }

  // No new normal work at zero demand. Matching current, pending, or staged
  // work remains valid and may be retained; a mismatched publication cannot.
  if (!channel.demanded) {
    if (currentMatches) {
      // A -> pending B -> A can happen while normal relief is disabled. The
      // matching GPUTexture remains the current publication even though no
      // new normal work is demanded.
      channel.state = "current";
    }
    return hasCurrent && !currentMatches
      ? RETIRE_RECONCILIATION_WORK
      : NO_RECONCILIATION_WORK;
  }

  if (currentMatches) {
    // A -> pending B -> A retains the published A GPUTexture so there is no
    // placeholder flash. `desiredChanged` cancels B and temporarily resets the
    // request state to idle; restore the truthful published state before the
    // matching-current fast return.
    channel.state = "current";
    return NO_RECONCILIATION_WORK;
  }
  if (
    identityMatchesDesired(channel, channel.staged?.identity) ||
    identityMatchesDesired(channel, channel.request?.identity) ||
    identityMatchesDesired(channel, channel.failedIdentity)
  ) {
    return NO_RECONCILIATION_WORK;
  }

  startRequest(lifecycle, channel, options.hooks);
  return STARTED_RECONCILIATION_WORK;
}

/**
 * Publish one uploaded candidate during Moon.update. The caller's callbacks
 * perform the renderer-specific field swap. Invalidation always precedes
 * publication, and retirement of the previous GPU texture always follows it.
 *
 * @private
 */
function commitWebGPUMoonTextureCandidate(lifecycle, channelName, callbacks) {
  const channel = getChannel(lifecycle, channelName);
  const staged = channel.staged;
  if (staged === undefined) {
    return false;
  }
  if (
    !isWebGPUMoonTextureLifecycleCurrent(lifecycle) ||
    !identityMatchesDesired(channel, staged.identity)
  ) {
    destroyStaged(channel, "stale-at-commit");
    channel.state = "idle";
    return false;
  }
  if (!channel.demanded) {
    // A valid normal request may finish after its feature toggle goes off.
    // Keep the candidate staged and owned, but do not churn the bind group or
    // bundle until the same identity is demanded again.
    return false;
  }

  // Mip generation is frame-owned work, so it can only be queued here,
  // immediately before transactional publication from Moon.update.
  // Revalidate after the hook as well: a test double or future scheduler hook
  // may synchronously retire/supersede the tuple while preparing the texture.
  // Any queued job for the now-dead candidate is canceled by the renderer's
  // destroyCandidate hook through context.noteInlineTextureDestroy().
  try {
    callbacks.prepareCandidate?.(staged.candidate.value, staged.identity);
  } catch (error) {
    if (
      destroyCandidateOnce(
        staged.candidate,
        staged.hooks,
        "prepublication-failed",
        staged.identity,
      )
    ) {
      channel.failedCandidateDestroys++;
    }
    if (channel.staged === staged) {
      channel.staged = undefined;
      channel.failedIdentity = staged.identity;
      channel.state = "failed";
    }
    reportError(
      staged.hooks,
      error,
      "candidate-prepublication",
      staged.identity,
    );
    return false;
  }
  if (
    !isWebGPUMoonTextureLifecycleCurrent(lifecycle) ||
    !identityMatchesDesired(channel, staged.identity) ||
    channel.staged !== staged
  ) {
    if (channel.staged === staged) {
      destroyStaged(channel, "stale-after-prepublication");
      channel.state = "idle";
    }
    return false;
  }

  let previous;
  try {
    callbacks.invalidate(staged.identity);
    previous = callbacks.publish(staged.candidate.value, staged.identity);
  } catch (error) {
    if (
      destroyCandidateOnce(
        staged.candidate,
        staged.hooks,
        "publication-failed",
        staged.identity,
      )
    ) {
      channel.failedCandidateDestroys++;
    }
    channel.staged = undefined;
    channel.failedIdentity = staged.identity;
    channel.state = "failed";
    reportError(staged.hooks, error, "candidate-publication", staged.identity);
    return false;
  }

  staged.candidate.published = true;
  channel.staged = undefined;
  channel.currentIdentity = staged.identity;
  channel.failedIdentity = undefined;
  channel.state = "current";
  channel.publications++;

  try {
    callbacks.destroyPrevious(previous, staged.identity);
  } catch (error) {
    // The new realization is already healthy and current. Failure to destroy
    // the detached old handle must not roll publication back onto it.
    reportError(staged.hooks, error, "previous-retirement", staged.identity);
  }
  return true;
}

/**
 * Return a flat, resource-free snapshot of one WebGPU Moon texture lifecycle.
 * The snapshot intentionally contains only scalar state and immutable request
 * identity strings; candidate wrappers, decoded sources, contexts, devices,
 * and GPUTexture handles never escape through this surface.
 *
 * @param {object|undefined} lifecycle
 * @returns {object}
 * @private
 */
function getWebGPUMoonTextureLifecycleDiagnostics(lifecycle) {
  const albedo = lifecycle?.channels?.albedo;
  const normal = lifecycle?.channels?.normal;
  const albedoPendingIdentity =
    albedo?.request?.identity ?? albedo?.staged?.identity;
  const normalPendingIdentity =
    normal?.request?.identity ?? normal?.staged?.identity;

  return Object.freeze({
    cacheSerial: lifecycle?.cacheSerial ?? null,
    resourceGeneration: lifecycle?.resourceGeneration ?? null,
    lifecycleRetired: lifecycle?.retired === true,
    albedoRequestSerial: albedo?.requestSerial ?? null,
    albedoRequestState: albedo?.state ?? null,
    albedoDesiredUrl: albedo?.desiredUrl ?? null,
    albedoEffectivePair: albedo?.desiredPairKey ?? null,
    albedoCurrentUrl: albedo?.currentIdentity?.exactUrl ?? null,
    albedoCurrentPair: albedo?.currentIdentity?.effectivePair ?? null,
    albedoPendingUrl: albedoPendingIdentity?.exactUrl ?? null,
    albedoPendingPair: albedoPendingIdentity?.effectivePair ?? null,
    albedoCandidateReady: albedo?.staged !== undefined,
    albedoRequestCancellations: albedo?.cancellations ?? 0,
    albedoLastCancellationReason: albedo?.lastCancellationReason ?? null,
    albedoGpuRealizations: albedo?.gpuRealizations ?? 0,
    albedoSuccessfulUploads: albedo?.successfulUploads ?? 0,
    albedoPublications: albedo?.publications ?? 0,
    albedoStaleCandidateDestroys: albedo?.staleCandidateDestroys ?? 0,
    albedoFailedCandidateDestroys: albedo?.failedCandidateDestroys ?? 0,
    normalRequestSerial: normal?.requestSerial ?? null,
    normalRequestState: normal?.state ?? null,
    normalDesiredUrl: normal?.desiredUrl ?? null,
    normalEffectivePair: normal?.desiredPairKey ?? null,
    normalCurrentUrl: normal?.currentIdentity?.exactUrl ?? null,
    normalCurrentPair: normal?.currentIdentity?.effectivePair ?? null,
    normalPendingUrl: normalPendingIdentity?.exactUrl ?? null,
    normalPendingPair: normalPendingIdentity?.effectivePair ?? null,
    normalCandidateReady: normal?.staged !== undefined,
    normalRequestDemanded: normal?.demanded === true,
    normalRequestCancellations: normal?.cancellations ?? 0,
    normalLastCancellationReason: normal?.lastCancellationReason ?? null,
    normalGpuRealizations: normal?.gpuRealizations ?? 0,
    normalSuccessfulUploads: normal?.successfulUploads ?? 0,
    normalPublications: normal?.publications ?? 0,
    normalStaleCandidateDestroys: normal?.staleCandidateDestroys ?? 0,
    normalFailedCandidateDestroys: normal?.failedCandidateDestroys ?? 0,
  });
}

/**
 * Replace a published channel realization with its renderer-owned placeholder.
 * This is used for URL removal and for zero-demand pair changes. The callback
 * must prepare the placeholder before mutating live fields.
 *
 * @private
 */
function retireWebGPUMoonPublishedTexture(lifecycle, channelName, callbacks) {
  const channel = getChannel(lifecycle, channelName);
  if (channel.currentIdentity === undefined) {
    return false;
  }

  let placeholder;
  let previous;
  try {
    placeholder = callbacks.preparePlaceholder();
    callbacks.invalidate(channel.currentIdentity);
    previous = callbacks.publishPlaceholder(
      placeholder,
      channel.currentIdentity,
    );
  } catch (error) {
    try {
      callbacks.destroyPreparedPlaceholder?.(placeholder);
    } catch (cleanupError) {
      reportError(
        callbacks,
        cleanupError,
        "placeholder-rollback",
        channel.currentIdentity,
      );
    }
    reportError(
      callbacks,
      error,
      "published-retirement",
      channel.currentIdentity,
    );
    return false;
  }

  // Publication is complete. Old-resource cleanup is deliberately outside
  // the transaction: a destroy() error cannot truthfully turn this successful
  // placeholder swap back into a failed/old-current state.
  channel.currentIdentity = undefined;
  channel.state = channel.staged
    ? "candidate-ready"
    : channel.request
      ? channel.state
      : channel.failedIdentity
        ? "failed"
        : "idle";
  try {
    callbacks.destroyPrevious(previous);
  } catch (error) {
    reportError(callbacks, error, "previous-retirement", undefined);
  }
  return true;
}

/** Retire all pending/staged work. Published handles remain cache-owned. */
function retireWebGPUMoonTextureLifecycle(lifecycle, reason = "retired") {
  if (lifecycle === undefined || lifecycle.retired) {
    return;
  }
  lifecycle.retired = true;
  for (const channel of Object.values(lifecycle.channels)) {
    channel.requestSerial++;
    supersedeRequest(channel, `WebGPU Moon texture lifecycle ${reason}`);
    destroyStaged(channel, "lifecycle-retired");
    channel.currentIdentity = undefined;
    channel.failedIdentity = undefined;
    channel.state = "retired";
  }
  if (lifecycle.cache?._moonTextureLifecycle === lifecycle) {
    lifecycle.cache._moonTextureLifecycle = undefined;
  }
}

export {
  MoonTextureChannel,
  createWebGPUMoonUploadSource,
  createWebGPUMoonTextureLifecycle,
  createWebGPUMoonTexturePairKey,
  getWebGPUMoonTextureLifecycleDiagnostics,
  isWebGPUMoonTextureLifecycleCurrent,
  releaseWebGPUMoonUploadSource,
  reconcileWebGPUMoonTextureChannel,
  commitWebGPUMoonTextureCandidate,
  retireWebGPUMoonPublishedTexture,
  retireWebGPUMoonTextureLifecycle,
};

export default {
  MoonTextureChannel,
  createWebGPUMoonUploadSource,
  createWebGPUMoonTextureLifecycle,
  createWebGPUMoonTexturePairKey,
  getWebGPUMoonTextureLifecycleDiagnostics,
  isWebGPUMoonTextureLifecycleCurrent,
  releaseWebGPUMoonUploadSource,
  reconcileWebGPUMoonTextureChannel,
  commitWebGPUMoonTextureCandidate,
  retireWebGPUMoonPublishedTexture,
  retireWebGPUMoonTextureLifecycle,
};
