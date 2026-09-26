import {
  Ion,
  IonResource,
  RequestErrorEvent,
  Resource,
  RuntimeError,
} from "../../index.js";

describe("Core/IonResource", function () {
  const assetId = 123890213;
  const endpoint = {
    type: "3DTILES",
    url: `https://assets.cesium.com/${assetId}/tileset.json`,
    accessToken: "not_really_a_refresh_token",
    attributions: [],
  };

  it("constructs with expected values", function () {
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(endpoint, endpointResource);
    expect(resource).toBeInstanceOf(Resource);
    expect(resource._ionEndpoint).toEqual(endpoint);
    // IonResource extends Resource via ES6 `super(options)`, so verify the
    // parent-initialized state instead of spying on the legacy Resource.call.
    expect(resource.url).toEqual(endpoint.url);
    expect(resource.retryCallback).toBeDefined();
    expect(resource.retryAttempts).toBe(1);
  });

  // A self-hosted or proxied ion endpoint reports a url that is not absolute.
  // It names no server of its own, which is not an error: the token check
  // compares the server the endpoint is served by against the one the url about
  // to be requested will be fetched from, and a relative url on both sides is
  // fetched from the same place.
  it("constructs from an endpoint whose url is not absolute", function () {
    const relativeEndpoint = {
      type: "TERRAIN",
      url: "Data/CesiumTerrainTileJson/QuantizedMeshWithOctVertexNormals",
      accessToken: "not_really_a_refresh_token",
      attributions: [],
    };
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(relativeEndpoint, endpointResource);

    expect(resource.url).toEqual(relativeEndpoint.url);
    expect(resource._ionEndpointDomain).toEqual("");
  });

  // The server is read off the URL parser, which is the parser the request
  // itself goes through: it folds the case, drops a default port and leaves out
  // the userinfo, so one server spelled several ways is one server. The scheme
  // is part of the answer, so the same host under another scheme is not it.
  it("reads the endpoint's server the way the URL parser does", function () {
    const endpointResource = IonResource._createEndpointResource(assetId);
    const cases = [
      ["https://API.cesium.invalid/v1/assets/1/", "https://api.cesium.invalid"],
      [
        "https://api.cesium.invalid:8443/v1/",
        "https://api.cesium.invalid:8443",
      ],
      ["https://api.cesium.invalid:443/v1/", "https://api.cesium.invalid"],
      ["https://User:Pw@api.cesium.invalid/v1/", "https://api.cesium.invalid"],
      // The parser skips the slash run; a pattern over the text does not, and
      // reading "" here is what sent the token to an attacker-named host.
      ["https:///api.cesium.invalid/v1/", "https://api.cesium.invalid"],
    ];

    cases.forEach(function (pair) {
      const resource = new IonResource(
        {
          type: "TERRAIN",
          url: pair[0],
          accessToken: "not_really_a_refresh_token",
          attributions: [],
        },
        endpointResource,
      );
      expect(resource._ionEndpointDomain).toEqual(pair[1]);
    });
  });

  // The negative direction, with hosts that are LEXICALLY RELATED to the
  // endpoint's. A host that merely ends with, begins with or contains the
  // endpoint's name is a host an attacker can register, and a comparison that
  // is any weaker than equality sends the access token to it.
  it("does not send the ion token to a host related to the endpoint's only by spelling", function () {
    const secureEndpoint = {
      type: "3DTILES",
      url: "https://api.cesium.invalid/v1/assets/1/",
      accessToken: "not_really_a_refresh_token",
      attributions: [],
    };
    const relativeEndpoint = {
      type: "3DTILES",
      url: "Data/ion/assets/1/",
      accessToken: "not_really_a_refresh_token",
      attributions: [],
    };
    const backslash = String.fromCharCode(92);
    const cases = [
      [secureEndpoint, "https://evilapi.cesium.invalid/x"],
      [secureEndpoint, "https://api.cesium.invalid.evil.invalid/x"],
      [secureEndpoint, "https://api.cesium.invalid@evil.invalid/x"],
      [secureEndpoint, "https://api.cesium.invalid:8443/x"],
      // The shapes whose text carries no authority at all while the parser
      // reads one: a self-hosted endpoint's own domain is empty text too.
      [relativeEndpoint, "https:///evil.invalid/x"],
      [relativeEndpoint, "https:evil.invalid/x"],
      [relativeEndpoint, `https:${backslash}${backslash}evil.invalid/x`],
      [relativeEndpoint, "//evil.invalid/x"],
      [relativeEndpoint, `${backslash}${backslash}evil.invalid/x`],
    ];

    const endpointResource = IonResource._createEndpointResource(assetId);
    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    cases.forEach(function (pair) {
      _makeRequest.calls.reset();
      const resource = new IonResource(pair[0], endpointResource);
      resource.url = pair[1];

      resource._makeRequest({});
      expect(_makeRequest).toHaveBeenCalledTimes(1);
      expect(_makeRequest.calls.mostRecent().args[0].headers).toBeUndefined();
    });
  });

  // The token-domain check has two sides and they are read off two different
  // strings: the endpoint's own text, and the url about to be requested. A
  // tile request is a DERIVED resource, so that is where the two can be made
  // to disagree — and failing the check drops the Authorization header
  // silently, which is a 401 with nothing in it that says why.
  it("sends the ion token with a derived resource of a mixed-case endpoint", function () {
    const mixedCaseEndpoint = {
      type: "3DTILES",
      url: `https://API.cesium.invalid/v1/assets/${assetId}/`,
      accessToken: "not_really_a_refresh_token",
      attributions: [],
    };

    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    const endpointResource = IonResource._createEndpointResource(assetId);
    const derived = new IonResource(
      mixedCaseEndpoint,
      endpointResource,
    ).getDerivedResource({ url: "layer.json" });

    derived._makeRequest({});
    expect(_makeRequest).toHaveBeenCalledWith({
      headers: jasmine.objectContaining({
        Authorization: `Bearer ${mixedCaseEndpoint.accessToken}`,
      }),
    });
  });

  // The check asks the URL parser where a url goes, and it has to ask from a
  // page of each KIND. Under a scheme the URL Standard calls SPECIAL a `\` ends
  // the authority and a run of separators is skipped; under a scheme it leaves
  // opaque neither happens. So `//api.cesium.invalid\@evil.invalid/x` is the
  // endpoint's own server to an `https` page and `evil.invalid` to a page a
  // desktop host serves over its own registered scheme. A url whose server
  // depends on that has no settled server, and an unsettled server gets no
  // token.
  it("does not send the ion token to a url that different kinds of page address differently", function () {
    const secureEndpoint = {
      type: "3DTILES",
      url: "https://api.cesium.invalid/v1/assets/1/",
      accessToken: "not_really_a_refresh_token",
      attributions: [],
    };
    const backslash = String.fromCharCode(92);
    const urls = [
      `//api.cesium.invalid${backslash}@evil.invalid/x`,
      `//api.cesium.invalid${backslash}evil.invalid/x`,
      "///api.cesium.invalid/x",
      `${backslash}${backslash}api.cesium.invalid/x`,
      `/${backslash}api.cesium.invalid/x`,
    ];

    const endpointResource = IonResource._createEndpointResource(assetId);
    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    urls.forEach(function (url) {
      _makeRequest.calls.reset();
      const resource = new IonResource(secureEndpoint, endpointResource);
      resource.url = url;

      resource._makeRequest({});
      expect(_makeRequest).toHaveBeenCalledTimes(1);
      expect(_makeRequest.calls.mostRecent().args[0].headers).toBeUndefined();
    });
  });

  // ... and asking a page of the other kind has to cost nothing. An opaque
  // scheme takes its host verbatim where a special one folds the case, an IDN
  // label, a percent-encoded label and a decimal IPv4 literal — those are
  // spellings of ONE server, not a disagreement about which server, so an
  // endpoint that names its host without a scheme keeps its token however its
  // own urls spell that host.
  it("sends the ion token to an endpoint named without a scheme however its host is spelled", function () {
    const endpoint = {
      type: "3DTILES",
      url: "//api.cesium.invalid/v1/assets/1/",
      accessToken: "not_really_a_refresh_token",
      attributions: [],
    };
    const urls = [
      "//api.cesium.invalid/v1/x",
      "//API.CESIUM.INVALID/v1/x",
      "//api.cesium.inval%69d/v1/x",
    ];

    const endpointResource = IonResource._createEndpointResource(assetId);
    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    urls.forEach(function (url) {
      _makeRequest.calls.reset();
      const resource = new IonResource(endpoint, endpointResource);
      resource.url = url;

      resource._makeRequest({});
      expect(_makeRequest).toHaveBeenCalledWith({
        headers: jasmine.objectContaining({
          Authorization: `Bearer ${endpoint.accessToken}`,
        }),
      });
    });
  });

  // The scheme is half of "which server". Chromium on Windows reads a url
  // that begins with two backslashes as a UNC path whatever the page, so
  // `\\api.cesium.invalid/x` is `file://api.cesium.invalid/x` there: the
  // endpoint's host, under a scheme that is not the endpoint's. The same holds
  // for cleartext `http:` beside an `https` endpoint and for any other scheme
  // on that host. Every row is false whatever page the spec runs on.
  it("does not send the ion token to the endpoint's host under another scheme", function () {
    const secureEndpoint = {
      type: "3DTILES",
      url: "https://api.cesium.invalid/v1/assets/1/",
      accessToken: "not_really_a_refresh_token",
      attributions: [],
    };
    const urls = [
      "file://api.cesium.invalid/v1/x",
      "http://api.cesium.invalid/v1/x",
      "wss://api.cesium.invalid/v1/x",
      "custom-scheme://api.cesium.invalid/v1/x",
    ];

    const endpointResource = IonResource._createEndpointResource(assetId);
    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    urls.forEach(function (url) {
      _makeRequest.calls.reset();
      const resource = new IonResource(secureEndpoint, endpointResource);
      resource.url = url;

      resource._makeRequest({});
      expect(_makeRequest).toHaveBeenCalledTimes(1);
      expect(_makeRequest.calls.mostRecent().args[0].headers).toBeUndefined();
    });
  });

  it("clone works", function () {
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(endpoint, endpointResource);
    const cloned = resource.clone();
    expect(cloned).not.toBe(resource);
    expect(cloned._ionRoot).toBe(resource);
    cloned._ionRoot = undefined;
    expect(cloned.retryCallback).toBe(resource.retryCallback);
    expect(cloned.headers.Authorization).toBe(resource.headers.Authorization);
    expect(cloned).toEqual(resource);
  });

  it("create creates the expected resource", function () {
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(endpoint, endpointResource);
    expect(resource.getUrlComponent()).toEqual(endpoint.url);
    expect(resource._ionEndpoint).toBe(endpoint);
    expect(resource._ionEndpointResource).toEqual(endpointResource);
    expect(resource.retryCallback).toBeDefined();
    expect(resource.retryAttempts).toBe(1);
  });

  it("fromAssetId calls constructor for non-external endpoint with expected parameters", function () {
    const tilesAssetId = 123890213;
    const tilesEndpoint = {
      type: "3DTILES",
      url: `https://assets.cesium.com/${tilesAssetId}/tileset.json`,
      accessToken: "not_really_a_refresh_token",
      attributions: [],
    };

    const options = {};
    const resourceEndpoint = IonResource._createEndpointResource(
      tilesAssetId,
      options,
    );
    spyOn(IonResource, "_createEndpointResource").and.returnValue(
      resourceEndpoint,
    );
    spyOn(resourceEndpoint, "fetchJson").and.returnValue(
      Promise.resolve(tilesEndpoint),
    );

    return IonResource.fromAssetId(tilesAssetId, options).then(
      function (resource) {
        expect(IonResource._createEndpointResource).toHaveBeenCalledWith(
          tilesAssetId,
          options,
        );
        expect(resourceEndpoint.fetchJson).toHaveBeenCalled();
        expect(resource._ionEndpointResource).toEqual(resourceEndpoint);
        expect(resource._ionEndpoint).toEqual(tilesEndpoint);
      },
    );
  });

  function testNonImageryExternalResource(externalEndpoint) {
    it(`fromAssetId returns basic Resource for external type "${externalEndpoint.externalType}"`, async function () {
      const resourceEndpoint = IonResource._createEndpointResource(123890213);
      spyOn(IonResource, "_createEndpointResource").and.returnValue(
        resourceEndpoint,
      );
      spyOn(resourceEndpoint, "fetchJson").and.returnValue(
        Promise.resolve(externalEndpoint),
      );

      const resource = await IonResource.fromAssetId(123890213);
      expect(resource.url).toEqual(externalEndpoint.options.url);
      expect(resource.headers.Authorization).toBeUndefined();
      expect(resource.retryCallback).toBeUndefined();
    });
  }

  testNonImageryExternalResource({
    type: "3DTILES",
    externalType: "3DTILES",
    options: { url: "http://test.invalid/tileset.json" },
    attributions: [],
  });

  testNonImageryExternalResource({
    type: "TERRAIN",
    externalType: "STK_TERRAIN_SERVER",
    options: { url: "http://test.invalid/world" },
    attributions: [],
  });

  it("fromAssetId rejects for external imagery", async function () {
    const externalEndpoint = {
      type: "IMAGERY",
      externalType: "URL_TEMPLATE",
      url: "http://test.invalid/world",
      attributions: [],
    };

    const resourceEndpoint = IonResource._createEndpointResource(123890213);
    spyOn(IonResource, "_createEndpointResource").and.returnValue(
      resourceEndpoint,
    );
    spyOn(resourceEndpoint, "fetchJson").and.returnValue(
      Promise.resolve(externalEndpoint),
    );

    await expectAsync(IonResource.fromAssetId(123890213)).toBeRejectedWithError(
      RuntimeError,
    );
  });

  it("createEndpointResource creates expected values with default parameters", function () {
    const assetId = 2348234;
    const resource = IonResource._createEndpointResource(assetId);
    expect(resource.url).toBe(
      `${Ion.defaultServer.url}v1/assets/${assetId}/endpoint?access_token=${Ion.defaultAccessToken}`,
    );
  });

  it("createEndpointResource creates expected values with overridden options", function () {
    const serverUrl = "https://api.cesium.test/";
    const accessToken = "not_a_token";

    const assetId = 2348234;
    const resource = IonResource._createEndpointResource(assetId, {
      server: serverUrl,
      accessToken: accessToken,
    });
    expect(resource.url).toBe(
      `${serverUrl}v1/assets/${assetId}/endpoint?access_token=${accessToken}`,
    );
  });

  it("createEndpointResource creates expected values with overridden defaults", function () {
    const defaultServer = Ion.defaultServer;
    const defaultAccessToken = Ion.defaultAccessToken;

    Ion.defaultServer = new Resource({ url: "https://api.cesium.test/" });
    Ion.defaultAccessToken = "not_a_token";

    const assetId = 2348234;
    const resource = IonResource._createEndpointResource(assetId);
    expect(resource.url).toBe(
      `${Ion.defaultServer.url}v1/assets/${assetId}/endpoint?access_token=${Ion.defaultAccessToken}`,
    );

    Ion.defaultServer = defaultServer;
    Ion.defaultAccessToken = defaultAccessToken;
  });

  it("Calls base _makeRequest with expected options when resource no Authorization header is defined", function () {
    const originalOptions = {};
    const expectedOptions = {
      headers: jasmine.objectContaining({
        Authorization: `Bearer ${endpoint.accessToken}`,
      }),
    };

    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(endpoint, endpointResource);
    resource._makeRequest(originalOptions);
    expect(_makeRequest).toHaveBeenCalledWith(expectedOptions);
  });

  it("Calls base _makeRequest with expected options when resource Authorization header is already defined", function () {
    const originalOptions = {};
    const expectedOptions = {
      headers: jasmine.objectContaining({
        Authorization: `Bearer ${endpoint.accessToken}`,
      }),
    };

    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(endpoint, endpointResource);
    resource.headers.Authorization = "Not valid";
    resource._makeRequest(originalOptions);
    expect(_makeRequest).toHaveBeenCalledWith(expectedOptions);
  });

  it("Calls base _makeRequest including X-Cesium-* headers", function () {
    const originalOptions = {};
    const expectedOptions = {
      headers: jasmine.objectContaining({
        "X-Cesium-Client": "CesiumJS",
        "X-Cesium-Client-Version": jasmine.stringContaining("1."),
      }),
    };

    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(endpoint, endpointResource);
    resource._makeRequest(originalOptions);
    expect(_makeRequest).toHaveBeenCalledWith(expectedOptions);
  });

  it("Calls base _makeRequest with no changes for external assets", function () {
    const externalEndpoint = {
      type: "3DTILES",
      externalType: "3DTILES",
      options: { url: "http://test.invalid/tileset.json" },
      attributions: [],
    };
    const options = {};

    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(externalEndpoint, endpointResource);
    resource._makeRequest(options);
    expect(_makeRequest.calls.argsFor(0)[0]).toBe(options);
  });

  it("Calls base _makeRequest with no changes for ion assets with external urls", function () {
    const originalOptions = {};
    const expectedOptions = {};

    const _makeRequest = spyOn(Resource.prototype, "_makeRequest");
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(endpoint, endpointResource);
    resource.url = "http://test.invalid";
    resource._makeRequest(originalOptions);
    expect(_makeRequest).toHaveBeenCalledWith(expectedOptions);
  });

  it("Calls base fetchImage with preferBlob for ion assets", function () {
    const fetchImage = spyOn(Resource.prototype, "fetchImage");
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(endpoint, endpointResource);
    resource.fetchImage();
    expect(fetchImage).toHaveBeenCalledWith({
      preferBlob: true,
    });
  });

  it("Calls base fetchImage with no changes for external assets", function () {
    const externalEndpoint = {
      type: "3DTILES",
      externalType: "3DTILES",
      options: { url: "http://test.invalid/tileset.json" },
      attributions: [],
    };

    const fetchImage = spyOn(Resource.prototype, "fetchImage");
    const endpointResource = IonResource._createEndpointResource(assetId);
    const resource = new IonResource(externalEndpoint, endpointResource);
    resource.fetchImage({
      preferBlob: false,
    });
    expect(fetchImage).toHaveBeenCalledWith({
      preferBlob: false,
    });
  });

  describe("retryCallback", function () {
    let endpointResource;
    let originalResource;
    let retryCallback;

    beforeEach(function () {
      endpointResource = new Resource({
        url: "https://api.test.invalid",
        access_token: "not_the_token",
      });
      originalResource = new IonResource(endpoint, endpointResource);
      retryCallback = originalResource.retryCallback;
    });

    it("returns false when error is undefined", function () {
      return retryCallback(originalResource, undefined).then(function (result) {
        expect(result).toBe(false);
      });
    });

    it("returns false when error is non-401", function () {
      const error = new RequestErrorEvent(404);
      return retryCallback(originalResource, error).then(function (result) {
        expect(result).toBe(false);
      });
    });

    it("returns false when error is event with non-Image target", function () {
      const event = { target: {} };
      return retryCallback(originalResource, event).then(function (result) {
        expect(result).toBe(false);
      });
    });

    function testCallback(eventName, resourceCallback, eventCallback) {
      it(`works with ${eventName}`, async function () {
        const resource = resourceCallback();
        const newEndpoint = {
          type: "3DTILES",
          url: `https://assets.cesium.com/${assetId}`,
          accessToken: "not_not_really_a_refresh_token",
        };

        spyOn(endpointResource, "fetchJson").and.returnValue(
          Promise.resolve(newEndpoint),
        );

        const promise = retryCallback(resource, eventCallback());

        // A concurrent second retry should re-use the same pending promise
        const promise2 = retryCallback(resource, eventCallback());
        expect(promise._pendingPromise).toBe(promise2._pendingPromise);

        const result = await promise;
        expect(result).toBe(true);
        expect(resource._ionEndpoint).toBe(newEndpoint);

        // Updates root endpoint
        expect(originalResource._ionEndpoint).toBe(resource._ionEndpoint);
        expect(originalResource.headers.Authorization).toEqual(
          resource.headers.Authorization,
        );

        expect(endpointResource.fetchJson).toHaveBeenCalled();
        await expectAsync(promise2).not.toBePending();
      });

      it(`works with refresh callback and ${eventName}`, async function () {
        const resource = resourceCallback();
        const newEndpoint = {
          type: "3DTILES",
          url: `https://assets.cesium.com/${assetId}`,
          accessToken: "not_not_really_a_refresh_token",
        };

        const refreshCallbackSpy = jasmine.createSpy("refreshCallback");
        resource.refreshCallback = (ionRoot, endpoint) => {
          refreshCallbackSpy();
          expect(ionRoot).toBe(originalResource);
          expect(endpoint).toEqual(newEndpoint);
        };

        spyOn(endpointResource, "fetchJson").and.returnValue(
          Promise.resolve(newEndpoint),
        );

        const promise = retryCallback(resource, eventCallback());

        const result = await promise;
        expect(result).toBe(true);
        expect(resource._ionEndpoint).toBe(newEndpoint);

        expect(endpointResource.fetchJson).toHaveBeenCalled();
        expect(refreshCallbackSpy).toHaveBeenCalled();
      });
    }

    testCallback(
      "401 response",
      () => originalResource,
      () => new RequestErrorEvent(401),
    );

    testCallback(
      "Image target event",
      () => originalResource,
      () => ({
        target: new Image(),
      }),
    );

    testCallback(
      "derrived resource",
      () => originalResource.getDerivedResource("1"),
      () => new RequestErrorEvent(401),
    );
  });
});
