import {
  createWorldImageryAsync,
  BingMapsStyle,
  IonImageryProvider,
  IonResource,
  Resource,
} from "../../index.js";

import createFakeBingMapsMetadataResponse from "../createFakeBingMapsMetadataResponse.js";

describe("Core/createWorldImageryAsync", function () {
  it("resolves to IonImageryProvider instance with default parameters", async function () {
    IonImageryProvider._endpointCache = {};
    const endpointResource = IonResource._createEndpointResource(2);
    spyOn(IonResource, "_createEndpointResource").and.returnValue(
      endpointResource,
    );
    spyOn(endpointResource, "fetchJson").and.resolveTo({
      type: "IMAGERY",
      externalType: "BING",
      options: {
        url: "http://example.invalid",
        key: "",
      },
      attributions: [],
    });

    const originalLoadWithXhr = Resource._Implementations.loadWithXhr;
    spyOn(Resource._Implementations, "loadWithXhr").and.callFake(
      function (
        url,
        responseType,
        method,
        data,
        headers,
        deferred,
        overrideMimeType,
      ) {
        if (url.includes("REST/v1/Imagery/Metadata")) {
          deferred.resolve(
            JSON.stringify(
              createFakeBingMapsMetadataResponse(BingMapsStyle.AERIAL),
            ),
          );
          return;
        }

        return originalLoadWithXhr(
          url,
          responseType,
          method,
          data,
          headers,
          deferred,
          overrideMimeType,
        );
      },
    );

    const provider = await createWorldImageryAsync();
    expect(provider).toBeInstanceOf(IonImageryProvider);
  });
});
