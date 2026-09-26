import Check from "./Check.js";
import Credit from "./Credit.js";
import Frozen from "./Frozen.js";
import defined from "./defined.js";
import Ion from "./Ion.js";
import Resource from "./Resource.js";
import RuntimeError from "./RuntimeError.js";

// Which server a url will be fetched from, read off the same parser the request
// itself goes through rather than off the url's text. A pattern over the text
// cannot stand in for it: for every special scheme the URL parser skips ANY run
// of `/` and `\` after the colon, so `https:///host/x`, `https:host/x`,
// `https:/\host/x` and `https:\\host/x` all reach `host` while carrying no `//`
// for a pattern to find, and a url with no scheme of its own reaches a server
// the same way (`\\host/x`, `///host/x`). The parser also folds together the
// spellings that RFC 3986 section 3.2.2 and the URL Standard call one host --
// case, percent-encoding, IDN, a default port, an IPv4 literal written in
// decimal -- and leaves out the userinfo, which names a credential, not a
// server.
//
// The url is resolved against three bases that differ from one another, so that
// the parser decides between three answers instead of a pattern guessing at
// them: the url names its own server (every base agrees on a host none of them
// supplied); it names none, and is fetched from wherever the document it came
// from is (each base answers its own host); or the bases disagree, which is
// what `https:host/x` does, because whether that is absolute depends on the
// scheme of the page it was loaded from. The third answer is `undefined`.
//
// The first two bases differ in scheme and host. The third differs in an axis
// neither of those two can vary: the URL Standard calls `http` and `https`
// SPECIAL, and under a special scheme the parser folds `\` into an authority
// separator where under a scheme it leaves opaque it does not. So
// `//host\@evil.invalid/x` is addressed to `host` from an `https` page and to
// `evil.invalid` from a page loaded over an application scheme, and with only
// special bases to ask, where the authority ENDS is a question no probe puts.
// A deployment that serves its own viewer over a registered application scheme
// reads it the second way, so the third base is what makes the two readings
// visible to each other. Probes that disagree mean the destination was never
// settled, and an unsettled destination carries nothing.
const destinationProbes = [
  {
    base: "http://ion-destination-probe-one.invalid/",
    protocol: "http:",
    host: "ion-destination-probe-one.invalid",
  },
  {
    base: "https://ion-destination-probe-two.invalid/",
    protocol: "https:",
    host: "ion-destination-probe-two.invalid",
  },
  {
    base: "ion-destination-probe://ion-destination-probe-three.invalid/",
    protocol: "ion-destination-probe:",
    host: "ion-destination-probe-three.invalid",
    opaque: true,
  },
];

// What the opaque probe calls a host, spelled the way the other two spell it.
// A scheme the URL Standard leaves opaque has its host taken verbatim: an IDN
// label is not folded to punycode, `3232235777` is not folded to the IPv4
// address it names, `inval%69d` is not decoded and the case is kept. A url with
// no scheme of its own inherits the probe's, so without this fold the opaque
// probe would spell the endpoint's OWN host differently from the other two and
// every such url would read as a disagreement -- fail-closed, but at the cost
// of a legitimate endpoint's token rather than an attacker's.
//
// The fold is over the host's SPELLING only. Where the authority ends is
// exactly what the three probes are there to disagree about, so it is read from
// each probe's own parse and never re-derived here. A host a special scheme
// will not accept is left as the opaque probe read it, and disagrees.
function foldOpaqueHost(parsed) {
  try {
    const hostname = new URL(`https://${parsed.hostname}/`).hostname;
    return parsed.port.length > 0 ? `${hostname}:${parsed.port}` : hostname;
  } catch {
    return parsed.host;
  }
}

// The answer for a url that names no server of its own. Two such urls are
// fetched from the same place as each other whatever that place turns out to
// be, so they do name one server -- which is the whole of the self-hosted and
// proxied endpoint case, where the endpoint url is relative too.
const noServerOfItsOwn = "";

function getDestination(url) {
  const readings = [];
  for (const probe of destinationProbes) {
    let parsed;
    try {
      parsed = new URL(url, probe.base);
    } catch {
      // A url the parser rejects outright is one no request can be addressed
      // to either; there is nothing here to compare.
      return undefined;
    }
    if (parsed.host.length === 0) {
      // A scheme of its own and no server named with it -- `data:`, `mailto:`,
      // `urn:`, `blob:`, `file:///path`. Not the document's server either.
      return undefined;
    }
    readings.push({ probe, parsed });
  }

  // The SCHEME is half of the answer, not only the host. Chromium on Windows
  // reads a url that begins with `\\` as a UNC path whatever the base, so
  // `\\api.cesium.invalid/x` is `file://api.cesium.invalid/x` under all three
  // probes there -- settled, and on the endpoint's host -- while Node reads it
  // as protocol-relative. Compared on the host alone, the token went to a
  // `file:` share in one engine and not in the other. With the scheme in the
  // answer, a destination that is not the endpoint's scheme (`file:`, `http:`
  // for an `https` endpoint, `ws:`) is not the endpoint, in either engine.
  //
  // Whether the url carries a scheme of its own is read off the three answers
  // together, never off one: the probes' schemes differ from one another, so a
  // url that inherits the page's scheme answers with each probe's, and only a
  // url that names its own answers with one scheme three times. (Read under the
  // `https` probe alone, `https://host/x` would look inherited.)
  const first = readings[0].parsed.protocol;
  const ownScheme = readings.every(({ parsed }) => parsed.protocol === first);
  const inheritsScheme = readings.every(
    ({ probe, parsed }) => parsed.protocol === probe.protocol,
  );
  if (!ownScheme && !inheritsScheme) {
    // Some pages read a scheme of the url's own and others their own: which
    // scheme the request uses depends on the page, so it is not settled.
    return undefined;
  }

  let named;
  if (ownScheme) {
    // Read identically by all three probes and already spelled alike.
    named = readings.map(
      ({ parsed }) => `${parsed.protocol}//${parsed.host.toLowerCase()}`,
    );
  } else if (
    readings.every(({ probe, parsed }) => parsed.host === probe.host)
  ) {
    return noServerOfItsOwn;
  } else {
    // The page's scheme, whatever it is, and a server of the url's own. It
    // equals only an endpoint that inherits the page's scheme the same way.
    // Only this branch was read by opaque host rules under the opaque probe.
    named = readings.map(
      ({ probe, parsed }) =>
        `//${(probe.opaque ? foldOpaqueHost(parsed) : parsed.host).toLowerCase()}`,
    );
  }

  return named.every((answer) => answer === named[0]) ? named[0] : undefined;
}

// Whether a url will be fetched from the server the endpoint is served by. The
// ion access token is attached only when this answers true, so an answer that
// could not be established has to be false: a token on a request to the wrong
// host is worse than a 401 on a request to the right one, and the 401 is the
// only one of the two the deployment can see.
function isSameDestination(url, endpointDestination) {
  const destination = getDestination(url);
  if (!defined(destination) || !defined(endpointDestination)) {
    return false;
  }
  if (destination === endpointDestination) {
    return true;
  }
  // Two answers can still name one place on the page this runs in. A url that
  // takes the page's scheme (`//host`) or names no server at all (`""`) is
  // settled only up to the page, and in a browser the page is known: an
  // endpoint named `//api.host/v1/` is fetched as `https://api.host/v1/` from
  // an `https` page, and its derived urls reach this check already written
  // that way, because `getDerivedResource` resolves against the document. So
  // both answers are read on the document before they are compared. Only the
  // two page-relative answers change; a url whose reading depended on the KIND
  // of page is already undefined above, whatever the page is.
  const page = getDocumentPage();
  return (
    defined(page) &&
    onPage(destination, page) === onPage(endpointDestination, page)
  );
}

function getDocumentPage() {
  if (typeof document === "undefined") {
    return undefined;
  }
  try {
    return new URL(document.baseURI ?? document.location.href);
  } catch {
    return undefined;
  }
}

function onPage(destination, page) {
  if (destination === noServerOfItsOwn) {
    return `${page.protocol}//${page.host.toLowerCase()}`;
  }
  return destination.startsWith("//")
    ? `${page.protocol}${destination}`
    : destination;
}

/**
 * A function that will be invoked when the access token is refreshed.
 * @callback IonResourceRefreshCallback
 * @param {IonResource} ionResource The root IonResource being refreshed.
 * @param {object} endpoint The result of the Cesium ion asset endpoint service. This may be modified in place by the callback.
 * @private
 */

/**
 * A {@link Resource} instance that encapsulates Cesium ion asset access.
 * This object is normally not instantiated directly, use {@link IonResource.fromAssetId}.
 *
 * @alias IonResource
 * @constructor
 * @augments Resource
 *
 * @param {object} endpoint The result of the Cesium ion asset endpoint service.
 * @param {Resource} endpointResource The original resource used to retrieve the endpoint.
 *
 * @see Ion
 * @see IonImageryProvider
 * @see createWorldTerrain
 * @see https://cesium.com
 */
class IonResource extends Resource {
  constructor(endpoint, endpointResource) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("endpoint", endpoint);
    Check.defined("endpointResource", endpointResource);
    //>>includeEnd('debug');

    let options;
    const externalType = endpoint.externalType;
    const isExternal = defined(externalType);

    if (!isExternal) {
      options = {
        url: endpoint.url,
        retryAttempts: 1,
        retryCallback: retryCallback,
      };
    } else if (
      externalType === "3DTILES" ||
      externalType === "STK_TERRAIN_SERVER"
    ) {
      // 3D Tiles and STK Terrain Server external assets can still be represented as an IonResource
      options = { url: endpoint.options.url };
    } else {
      //External imagery assets have additional configuration that can't be represented as a Resource
      throw new RuntimeError(
        "Ion.createResource does not support external imagery assets; use IonImageryProvider instead.",
      );
    }

    super(options);

    // The asset endpoint data returned from ion.
    this._ionEndpoint = endpoint;
    this._ionEndpointDomain = isExternal
      ? undefined
      : getDestination(endpoint.url);

    // The endpoint resource to fetch when a new token is needed
    this._ionEndpointResource = endpointResource;

    // The primary IonResource from which an instance is derived
    this._ionRoot = undefined;

    // Shared promise for endpooint requests amd credits (only ever set on the root request)
    this._pendingPromise = undefined;
    this._credits = undefined;
    this._isExternal = isExternal;

    /**
     * A function that, if defined, will be invoked when the access token is refreshed.
     * @private
     * @type {IonResourceRefreshCallback|undefined}
     */
    this.refreshCallback = undefined;
  }

  /** @inheritdoc */
  clone(result) {
    // We always want to use the root's information because it's the most up-to-date
    const ionRoot = this._ionRoot ?? this;

    if (!defined(result)) {
      result = new IonResource(
        ionRoot._ionEndpoint,
        ionRoot._ionEndpointResource,
      );
    }

    result = Resource.prototype.clone.call(this, result);
    result._ionRoot = ionRoot;
    result._isExternal = this._isExternal;

    return result;
  }

  fetchImage(options) {
    if (!this._isExternal) {
      const userOptions = options;
      options = {
        preferBlob: true,
      };
      if (defined(userOptions)) {
        options.flipY = userOptions.flipY;
        options.preferImageBitmap = userOptions.preferImageBitmap;
      }
    }

    return Resource.prototype.fetchImage.call(this, options);
  }

  _makeRequest(options) {
    // Don't send ion access token to non-ion servers.
    if (
      this._isExternal ||
      !isSameDestination(this.url, this._ionEndpointDomain)
    ) {
      return Resource.prototype._makeRequest.call(this, options);
    }

    options.headers = addClientHeaders(options.headers);
    options.headers.Authorization = `Bearer ${this._ionEndpoint.accessToken}`;

    return Resource.prototype._makeRequest.call(this, options);
  }

  /**
   * Gets the credits required for attribution of the asset.
   *
   * @type {Credit[]}
   * @readonly
   */
  get credits() {
    // Only we're not the root, return its credits;
    if (defined(this._ionRoot)) {
      return this._ionRoot.credits;
    }

    // We are the root
    if (defined(this._credits)) {
      return this._credits;
    }

    this._credits = IonResource.getCreditsFromEndpoint(
      this._ionEndpoint,
      this._ionEndpointResource,
    );

    return this._credits;
  }
}

// prototype assignment removed — IonResource extends Resource via ES6 class

/**
 * Asynchronously creates an instance.
 *
 * @param {number} assetId The Cesium ion asset id.
 * @param {object} [options] An object with the following properties:
 * @param {string} [options.accessToken=Ion.defaultAccessToken] The access token to use.
 * @param {string|Resource} [options.server=Ion.defaultServer] The resource to the Cesium ion API server.
 * @returns {Promise<IonResource>} A Promise to an instance representing the Cesium ion Asset.
 *
 * @example
 * // Load a Cesium3DTileset with asset ID of 124624234
 * try {
 *   const resource = await Cesium.IonResource.fromAssetId(124624234);
 *   const tileset = await Cesium.Cesium3DTileset.fromUrl(resource);
 *   scene.primitives.add(tileset);
 * } catch (error) {
 *   console.error(`Error creating tileset: ${error}`);
 * }
 *
 * @example
 * //Load a CZML file with asset ID of 10890
 * Cesium.IonResource.fromAssetId(10890)
 *   .then(function (resource) {
 *     viewer.dataSources.add(Cesium.CzmlDataSource.load(resource));
 *   });
 */
IonResource.fromAssetId = function (assetId, options) {
  const endpointResource = IonResource._createEndpointResource(
    assetId,
    options,
  );

  return endpointResource.fetchJson().then(function (endpoint) {
    return new IonResource(endpoint, endpointResource);
  });
};

/** @private */
IonResource.getCreditsFromEndpoint = function (endpoint, endpointResource) {
  const credits = endpoint.attributions.map(Credit.getIonCredit);
  const defaultTokenCredit = Ion.getDefaultTokenCredit(
    endpointResource.queryParameters.access_token,
  );
  if (defined(defaultTokenCredit)) {
    credits.push(Credit.clone(defaultTokenCredit));
  }
  return credits;
};

/**
 * @private
 **/
IonResource._createEndpointResource = function (assetId, options) {
  //>>includeStart('debug', pragmas.debug);
  Check.defined("assetId", assetId);
  //>>includeEnd('debug');

  options = options ?? Frozen.EMPTY_OBJECT;
  let server = options.server ?? Ion.defaultServer;
  const accessToken = options.accessToken ?? Ion.defaultAccessToken;
  server = Resource.createIfNeeded(server);

  const resourceOptions = {
    url: `v1/assets/${assetId}/endpoint`,
  };

  if (defined(accessToken)) {
    resourceOptions.queryParameters = { access_token: accessToken };
  }

  if (defined(options.queryParameters)) {
    resourceOptions.queryParameters = {
      ...resourceOptions.queryParameters,
      ...options.queryParameters,
    };
  }

  resourceOptions.headers = addClientHeaders(resourceOptions.headers);

  return server.getDerivedResource(resourceOptions);
};

/**
 * Adds CesiumJS client headers to the provided headers object.
 * @private
 * @param {object} [headers={}] The headers to modify.
 * @returns {object} The modified headers.
 */
function addClientHeaders(headers = {}) {
  headers["X-Cesium-Client"] = "CesiumJS";

  /* global CESIUM_VERSION */
  if (typeof CESIUM_VERSION !== "undefined") {
    headers["X-Cesium-Client-Version"] = CESIUM_VERSION;
  }

  return headers;
}

/**
 * @private
 **/
IonResource._addClientHeaders = addClientHeaders;

function retryCallback(that, error) {
  const ionRoot = that._ionRoot ?? that;
  const endpointResource = ionRoot._ionEndpointResource;

  // Image is not available in worker threads, so this avoids
  // a ReferenceError
  const imageDefined = typeof Image !== "undefined";

  // We only want to retry in the case of invalid credentials (401) or image
  // requests(since Image failures can not provide a status code)
  if (
    !defined(error) ||
    (error.statusCode !== 401 &&
      !(imageDefined && error.target instanceof Image))
  ) {
    return Promise.resolve(false);
  }

  // We use a shared pending promise for all derived assets, since they share
  // a common access_token.  If we're already requesting a new token for this
  // asset, we wait on the same promise.
  if (!defined(ionRoot._pendingPromise)) {
    ionRoot._pendingPromise = endpointResource
      .fetchJson()
      .then(function (newEndpoint) {
        const refreshCallback = that.refreshCallback ?? ionRoot.refreshCallback;
        if (defined(refreshCallback)) {
          refreshCallback(ionRoot, newEndpoint);
        }

        // Set the token for root resource so new derived resources automatically pick it up
        ionRoot._ionEndpoint = newEndpoint;
        return ionRoot._ionEndpoint;
      })
      .finally(function (newEndpoint) {
        // Pass or fail, we're done with this promise, the next failure should use a new one.
        ionRoot._pendingPromise = undefined;
        return newEndpoint;
      });
  }

  return ionRoot._pendingPromise.then(function (newEndpoint) {
    // Set the new token and endpoint for this resource
    that._ionEndpoint = newEndpoint;
    return true;
  });
}

export default IonResource;
