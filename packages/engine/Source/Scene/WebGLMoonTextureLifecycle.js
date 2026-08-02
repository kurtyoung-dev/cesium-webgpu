/**
 * C12-35 — frame-owned WebGL Moon texture lifecycle.
 *
 * The shared cache owns decoded pixel sources. This lifecycle owns an
 * immediate cache lease while a source is pending or staged, but asynchronous
 * callbacks may only stage that source. A WebGL Texture is created
 * synchronously by {@link commitWebGLMoonTextureChannel}, which Moon calls
 * from its update. The lease is released immediately after that synchronous
 * realization, and the decoded source is never closed directly here.
 *
 * @private
 */

const WebGLMoonTextureChannel = Object.freeze({
  ALBEDO: "albedo",
  NORMAL: "normal",
});

let nextLifecycleSerial = 1;

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
const NO_COMMIT = Object.freeze({ committed: false });

/**
 * Prepare a WebGL-owned vertically flipped upload source. WebGL ignores
 * UNPACK_FLIP_Y_WEBGL for ImageBitmap, so a shared cache bitmap must be
 * cloned with the flip baked in. The cache-owned source is never closed here.
 *
 * @param {object} sharedSource
 * @returns {Promise<object>|object}
 * @private
 */
function prepareWebGLMoonUploadSource(sharedSource) {
  if (typeof createImageBitmap !== "function") {
    return {
      sharedSource,
      uploadSource: sharedSource,
      flipY: true,
      ownedUploadSource: false,
    };
  }
  return createImageBitmap(sharedSource, {
    imageOrientation: "flipY",
    colorSpaceConversion: "default",
    premultiplyAlpha: "default",
  }).then(function (uploadSource) {
    return {
      sharedSource,
      uploadSource,
      flipY: false,
      ownedUploadSource:
        uploadSource !== sharedSource &&
        typeof uploadSource?.close === "function",
    };
  });
}

/** @private */
function releaseWebGLMoonUploadSource(source) {
  if (
    source?.ownedUploadSource &&
    typeof source.uploadSource?.close === "function"
  ) {
    source.uploadSource.close();
  }
  if (source !== undefined && source !== null) {
    source.ownedUploadSource = false;
    source.uploadSource = undefined;
    source.sharedSource = undefined;
  }
}

function createChannel(name) {
  return {
    name,
    requestSerial: 0,
    desiredUrl: undefined,
    desiredPairKey: undefined,
    demanded: false,
    request: undefined,
    staged: undefined,
    current: undefined,
    failedIdentity: undefined,
    state: "idle",
    gpuRealizations: 0,
    publications: 0,
    realizationFailures: 0,
    staleTextureDestroys: 0,
    cancellations: 0,
    lastCancellationReason: undefined,
  };
}

/**
 * A stable, collision-free key for the effective Moon albedo/normal pair.
 * Demand and strength are deliberately absent so a matching normal-map GPU
 * realization can survive an off/on feature transition.
 *
 * @param {string|undefined} albedoUrl
 * @param {string|undefined} normalUrl
 * @returns {string}
 * @private
 */
function createWebGLMoonTexturePairKey(albedoUrl, normalUrl) {
  return JSON.stringify([albedoUrl ?? null, normalUrl ?? null]);
}

/**
 * @param {object} owner
 * @param {object} context
 * @returns {object}
 * @private
 */
function createWebGLMoonTextureLifecycle(owner, context) {
  const lifecycle = {
    owner,
    context,
    lifecycleSerial: nextLifecycleSerial++,
    retired: false,
    channels: {
      albedo: createChannel(WebGLMoonTextureChannel.ALBEDO),
      normal: createChannel(WebGLMoonTextureChannel.NORMAL),
    },
  };
  owner._webglMoonTextureLifecycle = lifecycle;
  return lifecycle;
}

function getChannel(lifecycle, channelName) {
  const channel = lifecycle.channels[channelName];
  if (channel === undefined) {
    throw new Error(`Unknown WebGL Moon texture channel: ${channelName}`);
  }
  return channel;
}

function isWebGLMoonTextureLifecycleCurrent(lifecycle) {
  const context = lifecycle?.context;
  return (
    lifecycle !== undefined &&
    lifecycle.retired !== true &&
    lifecycle.owner?._webglMoonTextureLifecycle === lifecycle &&
    (typeof context?.isDestroyed !== "function" || !context.isDestroyed())
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
    isWebGLMoonTextureLifecycleCurrent(lifecycle) &&
    channel.request === request &&
    channel.requestSerial === identity.requestSerial &&
    identity.owner === lifecycle.owner &&
    identity.context === lifecycle.context &&
    identity.lifecycleSerial === lifecycle.lifecycleSerial &&
    identityMatchesDesired(channel, identity)
  );
}

function reportError(hooks, error, phase, identity) {
  try {
    hooks.onError?.(error, phase, identity);
  } catch (_ignored) {
    // Diagnostics must never take over resource cleanup.
  }
}

function releaseLease(stagedOrRequest) {
  if (
    stagedOrRequest === undefined ||
    stagedOrRequest.leaseReleased ||
    stagedOrRequest.lease === undefined
  ) {
    return;
  }
  if (stagedOrRequest.preparingSource || stagedOrRequest.realizingSource) {
    stagedOrRequest.leaseReleasePending = true;
    return;
  }
  stagedOrRequest.leaseReleased = true;
  stagedOrRequest.leaseReleasePending = false;
  const lease = stagedOrRequest.lease;
  stagedOrRequest.lease = undefined;
  try {
    lease.release();
  } catch (error) {
    reportError(
      stagedOrRequest.hooks,
      error,
      "source-lease-release",
      stagedOrRequest.identity,
    );
  }
}

function releasePreparedSource(stagedOrRequest) {
  if (
    stagedOrRequest === undefined ||
    stagedOrRequest.sourceReleased ||
    stagedOrRequest.source === undefined
  ) {
    return;
  }
  if (stagedOrRequest.realizingSource) {
    stagedOrRequest.sourceReleasePending = true;
    return;
  }
  stagedOrRequest.sourceReleased = true;
  stagedOrRequest.sourceReleasePending = false;
  const source = stagedOrRequest.source;
  stagedOrRequest.source = undefined;
  try {
    stagedOrRequest.hooks.releaseSource?.(source, stagedOrRequest.identity);
  } catch (error) {
    reportError(
      stagedOrRequest.hooks,
      error,
      "prepared-source-release",
      stagedOrRequest.identity,
    );
  }
}

function supersedeRequest(channel, reason) {
  const request = channel.request;
  channel.request = undefined;
  if (request === undefined) {
    return;
  }
  releasePreparedSource(request);
  releaseLease(request);
  channel.cancellations++;
  channel.lastCancellationReason = reason;
}

function releaseStaged(channel, reason) {
  const staged = channel.staged;
  channel.staged = undefined;
  if (staged === undefined) {
    return;
  }
  releasePreparedSource(staged);
  releaseLease(staged);
  channel.cancellations++;
  channel.lastCancellationReason = reason;
}

function finishFailedRequest(lifecycle, channel, request, error, phase) {
  releasePreparedSource(request);
  releaseLease(request);
  if (!isRequestCurrent(lifecycle, channel, request)) {
    return;
  }
  channel.request = undefined;
  channel.failedIdentity = request.identity;
  channel.state = "failed";
  reportError(request.hooks, error, phase, request.identity);
}

function startRequest(lifecycle, channel, hooks) {
  const identity = Object.freeze({
    owner: lifecycle.owner,
    context: lifecycle.context,
    lifecycleSerial: lifecycle.lifecycleSerial,
    requestSerial: channel.requestSerial,
    exactUrl: channel.desiredUrl,
    effectivePair: channel.desiredPairKey,
    backend: "webgl",
    channel: channel.name,
  });
  const request = {
    identity,
    hooks,
    lease: undefined,
    leaseReleased: false,
    leaseReleasePending: false,
    preparingSource: false,
    realizingSource: false,
    source: undefined,
    sourceReleased: false,
    sourceReleasePending: false,
  };
  channel.request = request;
  channel.state = "source-pending";

  let lease;
  try {
    lease = hooks.acquireSource(identity.exactUrl, identity);
    request.lease = lease;
    if (
      lease === undefined ||
      lease === null ||
      typeof lease.release !== "function" ||
      !("ready" in Object(lease))
    ) {
      throw new TypeError(
        "WebGL Moon acquireSource must return an immediate releasable lease.",
      );
    }
    // Source acquisition is synchronous and may re-enter user code. A lease
    // returned after owner/context/URL retirement belongs to this stale
    // request and must be released before readiness.
    if (!isRequestCurrent(lifecycle, channel, request)) {
      releaseLease(request);
      return;
    }
  } catch (error) {
    finishFailedRequest(lifecycle, channel, request, error, "source-acquire");
    return;
  }

  let readyPromise;
  try {
    readyPromise = Promise.resolve(lease.ready);
  } catch (error) {
    finishFailedRequest(lifecycle, channel, request, error, "source-ready");
    return;
  }
  readyPromise.then(
    function () {
      if (!isRequestCurrent(lifecycle, channel, request)) {
        releaseLease(request);
        return;
      }
      const sharedSource = lease.source;
      if (sharedSource === undefined || sharedSource === null) {
        finishFailedRequest(
          lifecycle,
          channel,
          request,
          new TypeError("WebGL Moon decoded-source lease resolved empty."),
          "source-ready",
        );
        return;
      }
      request.preparingSource = true;
      let preparedSource;
      try {
        preparedSource =
          hooks.prepareSource?.(sharedSource, identity) ?? sharedSource;
      } catch (error) {
        request.preparingSource = false;
        finishFailedRequest(
          lifecycle,
          channel,
          request,
          error,
          "source-prepare",
        );
        return;
      }
      return Promise.resolve(preparedSource).then(
        function (source) {
          request.preparingSource = false;
          request.source = source;
          if (!isRequestCurrent(lifecycle, channel, request)) {
            releasePreparedSource(request);
            releaseLease(request);
            return;
          }
          if (source === undefined || source === null) {
            finishFailedRequest(
              lifecycle,
              channel,
              request,
              new TypeError("WebGL Moon prepared source resolved empty."),
              "source-prepare",
            );
            return;
          }

          channel.request = undefined;
          channel.staged = {
            identity,
            hooks,
            lease: request.lease,
            leaseReleased: request.leaseReleased,
            leaseReleasePending: request.leaseReleasePending,
            preparingSource: false,
            realizingSource: false,
            source: request.source,
            sourceReleased: request.sourceReleased,
            sourceReleasePending: request.sourceReleasePending,
          };
          request.lease = undefined;
          request.leaseReleased = true;
          request.leaseReleasePending = false;
          request.source = undefined;
          request.sourceReleased = true;
          request.sourceReleasePending = false;
          channel.failedIdentity = undefined;
          channel.state = "source-ready";
          try {
            hooks.notifyReady?.(identity);
          } catch (error) {
            reportError(hooks, error, "notify-ready", identity);
          }
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
    },
    function (error) {
      finishFailedRequest(lifecycle, channel, request, error, "source-ready");
    },
  );
}

/**
 * Reconcile one channel's exact desired URL/pair identity. Promise callbacks
 * can only move a decoded source into `staged`; they never create a Texture.
 *
 * @param {object} lifecycle
 * @param {string} channelName
 * @param {object} options
 * @returns {{retireCurrent: boolean, started: boolean}}
 * @private
 */
function reconcileWebGLMoonTextureChannel(lifecycle, channelName, options) {
  if (
    !isWebGLMoonTextureLifecycleCurrent(lifecycle) ||
    options.context !== lifecycle.context
  ) {
    return NO_RECONCILIATION_WORK;
  }
  const channel = getChannel(lifecycle, channelName);
  const desiredChanged =
    channel.desiredUrl !== options.url ||
    channel.desiredPairKey !== options.pairKey;

  if (desiredChanged) {
    channel.requestSerial++;
    supersedeRequest(channel, `WebGL Moon ${channel.name} request superseded`);
    releaseStaged(
      channel,
      `WebGL Moon ${channel.name} staged source superseded`,
    );
    channel.desiredUrl = options.url;
    channel.desiredPairKey = options.pairKey;
    channel.failedIdentity = undefined;
    channel.state = "idle";
  }
  channel.demanded = options.demanded !== false;

  const hasCurrent = channel.current !== undefined;
  const currentMatches = identityMatchesDesired(
    channel,
    channel.current?.identity,
  );
  if (options.url === undefined) {
    return hasCurrent ? RETIRE_RECONCILIATION_WORK : NO_RECONCILIATION_WORK;
  }
  if (!channel.demanded) {
    if (currentMatches) {
      // A -> pending B -> A can happen while normal relief is disabled. The
      // matching Texture remains the current publication even though no new
      // normal work is demanded.
      channel.state = "current";
    }
    return hasCurrent && !currentMatches
      ? RETIRE_RECONCILIATION_WORK
      : NO_RECONCILIATION_WORK;
  }
  if (currentMatches) {
    // A -> pending B -> A keeps the published A Texture resident to avoid a
    // placeholder flash. `desiredChanged` above cancels B and resets the
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
 * Synchronously realize and publish a staged source. This function is called
 * only from Moon.update. It releases the decoded-source lease immediately
 * after the Texture constructor returns (or throws).
 *
 * @param {object} lifecycle
 * @param {string} channelName
 * @param {object} context
 * @param {function} createTexture
 * @param {function} destroyTexture
 * @returns {{committed: boolean, value?: object, previous?: object, identity?: object}}
 * @private
 */
function commitWebGLMoonTextureChannel(
  lifecycle,
  channelName,
  context,
  createTexture,
  destroyTexture,
) {
  const channel = getChannel(lifecycle, channelName);
  const staged = channel.staged;
  if (staged === undefined) {
    return NO_COMMIT;
  }
  if (
    !isWebGLMoonTextureLifecycleCurrent(lifecycle) ||
    context !== lifecycle.context ||
    !identityMatchesDesired(channel, staged.identity)
  ) {
    releaseStaged(channel, "WebGL Moon source stale at frame commit");
    channel.state = "idle";
    return NO_COMMIT;
  }
  let value;
  staged.realizingSource = true;
  try {
    value = createTexture(staged.source, staged.identity);
    channel.gpuRealizations++;
  } catch (error) {
    channel.realizationFailures++;
    staged.realizingSource = false;
    releasePreparedSource(staged);
    releaseLease(staged);
    if (channel.staged === staged) {
      channel.staged = undefined;
      channel.failedIdentity = staged.identity;
      channel.state = "failed";
    }
    reportError(staged.hooks, error, "texture-realization", staged.identity);
    return NO_COMMIT;
  }
  staged.realizingSource = false;
  // The WebGL Texture constructor has synchronously copied the pixels. The
  // renderer must not retain or directly close the cache-owned source.
  releasePreparedSource(staged);
  releaseLease(staged);

  if (
    !isWebGLMoonTextureLifecycleCurrent(lifecycle) ||
    context !== lifecycle.context ||
    channel.staged !== staged ||
    !identityMatchesDesired(channel, staged.identity)
  ) {
    try {
      destroyTexture(value, staged.identity);
      channel.staleTextureDestroys++;
    } catch (error) {
      reportError(
        staged.hooks,
        error,
        "stale-texture-destroy",
        staged.identity,
      );
    }
    if (channel.staged === staged) {
      channel.staged = undefined;
      channel.state = "idle";
    }
    return NO_COMMIT;
  }

  const previous = channel.current?.value;
  channel.current = {
    identity: staged.identity,
    value,
  };
  channel.staged = undefined;
  channel.failedIdentity = undefined;
  channel.state = "current";
  channel.publications++;
  return {
    committed: true,
    value,
    previous,
    identity: staged.identity,
  };
}

/**
 * Return a stable, GPU-object-free diagnostic snapshot for the WebGL Moon
 * lifecycle. This intentionally reports identities and counters only; neither
 * decoded sources nor Texture handles escape through the debug surface.
 *
 * @param {object|undefined} lifecycle
 * @returns {object|null}
 * @private
 */
function getWebGLMoonTextureLifecycleDiagnostics(lifecycle) {
  if (lifecycle === undefined) {
    return null;
  }

  function snapshotChannel(channel) {
    return Object.freeze({
      requestSerial: channel.requestSerial,
      state: channel.state,
      demanded: channel.demanded === true,
      desiredUrl: channel.desiredUrl ?? null,
      effectivePair: channel.desiredPairKey ?? null,
      currentUrl: channel.current?.identity?.exactUrl ?? null,
      currentPair: channel.current?.identity?.effectivePair ?? null,
      pendingUrl:
        channel.request?.identity?.exactUrl ??
        channel.staged?.identity?.exactUrl ??
        null,
      pendingPair:
        channel.request?.identity?.effectivePair ??
        channel.staged?.identity?.effectivePair ??
        null,
      sourceReady: channel.staged !== undefined,
      realTexture: channel.current !== undefined,
      gpuRealizations: channel.gpuRealizations,
      publications: channel.publications,
      realizationFailures: channel.realizationFailures,
      staleTextureDestroys: channel.staleTextureDestroys,
      cancellations: channel.cancellations,
      lastCancellationReason: channel.lastCancellationReason ?? null,
    });
  }

  return Object.freeze({
    lifecycleSerial: lifecycle.lifecycleSerial,
    retired: lifecycle.retired === true,
    resourceGeneration: lifecycle.context?.resourceGeneration ?? 0,
    albedo: snapshotChannel(lifecycle.channels.albedo),
    normal: snapshotChannel(lifecycle.channels.normal),
  });
}

/**
 * Forget one published realization. GPU ownership remains with the caller;
 * the returned value lets Moon apply Material-owned versus Moon-owned cleanup.
 *
 * @private
 */
function retireWebGLMoonPublishedTexture(lifecycle, channelName) {
  const channel = getChannel(lifecycle, channelName);
  if (channel.current === undefined) {
    return { retired: false };
  }
  const previous = channel.current.value;
  const identity = channel.current.identity;
  channel.current = undefined;
  channel.state = channel.staged
    ? "source-ready"
    : channel.request
      ? channel.state
      : channel.failedIdentity
        ? "failed"
        : "idle";
  return { retired: true, previous, identity };
}

function getWebGLMoonPublishedTexture(lifecycle, channelName) {
  return getChannel(lifecycle, channelName).current?.value;
}

/**
 * Release every pending/staged decoded-source lease. Published GPU values are
 * returned, not destroyed, because albedo is Material-owned while normal is
 * Moon-owned.
 *
 * @param {object|undefined} lifecycle
 * @param {string} [reason]
 * @returns {{albedo?: object, normal?: object}}
 * @private
 */
function retireWebGLMoonTextureLifecycle(lifecycle, reason = "retired") {
  if (lifecycle === undefined || lifecycle.retired) {
    return {};
  }
  lifecycle.retired = true;
  const published = {};
  for (const channel of Object.values(lifecycle.channels)) {
    channel.requestSerial++;
    supersedeRequest(channel, `WebGL Moon texture lifecycle ${reason}`);
    releaseStaged(channel, `WebGL Moon staged source lifecycle ${reason}`);
    published[channel.name] = channel.current?.value;
    channel.current = undefined;
    channel.failedIdentity = undefined;
    channel.state = "retired";
  }
  if (lifecycle.owner?._webglMoonTextureLifecycle === lifecycle) {
    lifecycle.owner._webglMoonTextureLifecycle = undefined;
  }
  return published;
}

export {
  WebGLMoonTextureChannel,
  commitWebGLMoonTextureChannel,
  createWebGLMoonTextureLifecycle,
  createWebGLMoonTexturePairKey,
  getWebGLMoonTextureLifecycleDiagnostics,
  getWebGLMoonPublishedTexture,
  isWebGLMoonTextureLifecycleCurrent,
  prepareWebGLMoonUploadSource,
  reconcileWebGLMoonTextureChannel,
  retireWebGLMoonPublishedTexture,
  retireWebGLMoonTextureLifecycle,
  releaseWebGLMoonUploadSource,
};

export default {
  WebGLMoonTextureChannel,
  commitWebGLMoonTextureChannel,
  createWebGLMoonTextureLifecycle,
  createWebGLMoonTexturePairKey,
  getWebGLMoonTextureLifecycleDiagnostics,
  getWebGLMoonPublishedTexture,
  isWebGLMoonTextureLifecycleCurrent,
  prepareWebGLMoonUploadSource,
  reconcileWebGLMoonTextureChannel,
  retireWebGLMoonPublishedTexture,
  retireWebGLMoonTextureLifecycle,
  releaseWebGLMoonUploadSource,
};
