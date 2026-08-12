import { Viewer } from "../index.js";

import getWebGLStub from "../../../Specs/getWebGLStub.js";
import { isOfflineLane } from "../../../Specs/networkPolicy.js";
import applyOfflineViewerNetworkDefaults from "./applyOfflineViewerNetworkDefaults.js";

function createViewer(container, options) {
  options = options ?? {};
  applyOfflineViewerNetworkDefaults(options, isOfflineLane(window));
  options.contextOptions = options.contextOptions ?? {};
  options.contextOptions.webgl = options.contextOptions.webgl ?? {};
  if (!!window.webglStub) {
    options.contextOptions.getWebGLStub = getWebGLStub;
  }

  return new Viewer(container, options);
}
export default createViewer;
