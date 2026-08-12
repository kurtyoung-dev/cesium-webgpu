import addDefaultMatchers from "./addDefaultMatchers.js";
import equalsMethodEqualityTester from "./equalsMethodEqualityTester.js";
import {
  installOfflineNetworkGuard,
  installOfflineNetworkRunAssertion,
  installOfflineNetworkSpecAttribution,
  setOfflineLane,
} from "./networkPolicy.js";

function customizeJasmine(
  env,
  includedCategory,
  excludedCategory,
  webglValidation,
  webglStub,
  release,
  debugCanvasWidth,
  debugCanvasHeight,
  offline,
) {
  // set this for uniform test resolution across devices
  window.devicePixelRatio = 1;

  window.specsUsingRelease = release;

  // C11-134 — the lane flag must be published BEFORE any spec module evaluates,
  // because `describeRequiresNetwork()` decides at declaration time whether its
  // suite is quarantined. karma-main.js runs ahead of SpecList.js, so this is
  // the last point at which that ordering still holds.
  setOfflineLane(offline === true);
  if (offline === true) {
    installOfflineNetworkSpecAttribution(env, window);
    installOfflineNetworkGuard({ origin: window.location.origin });
    installOfflineNetworkRunAssertion(env, {
      scope: window,
      report(message) {
        // Console capture intentionally stays disabled for the enormous engine
        // suite. Send this one stable line through Karma explicitly so a clean
        // run still exposes every reasoned skip in its terminal output.
        if (typeof window.__karma__?.info === "function") {
          window.__karma__.info({ log: message, type: "info" });
        } else {
          window.console.info(message);
        }
      },
    });
  }

  const originalDescribe = window.describe;

  window.describe = function (name, suite, category) {
    // exclude this spec if we're filtering by category and it's not the selected category
    // otherwise if we have an excluded category, exclude this test if the category of this spec matches
    if (
      includedCategory &&
      includedCategory !== "" &&
      includedCategory !== "none" &&
      category !== includedCategory
    ) {
      window.xdescribe(name, suite);
    } else if (
      excludedCategory &&
      excludedCategory !== "" &&
      category === excludedCategory
    ) {
      window.xdescribe(name, suite);
    } else {
      originalDescribe(name, suite);
    }
  };

  if (webglValidation) {
    window.webglValidation = true;
  }

  if (webglStub) {
    window.webglStub = true;
  }

  window.debugCanvasWidth = debugCanvasWidth;
  window.debugCanvasHeight = debugCanvasHeight;

  env.beforeEach(function () {
    addDefaultMatchers(!release).call(env);
    env.addCustomEqualityTester(equalsMethodEqualityTester);
  });
}
export default customizeJasmine;
