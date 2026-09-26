import addDefaultMatchers from "./addDefaultMatchers.js";
import {
  demandedCapabilities,
  installCapabilityLaneRunReport,
  installCapabilityLaneSpecLedger,
  setCapabilityLane,
} from "./capabilityPolicy.js";
import equalsMethodEqualityTester from "./equalsMethodEqualityTester.js";
import {
  installOfflineNetworkGuard,
  installOfflineNetworkRunAssertion,
  installOfflineNetworkSpecAttribution,
  setOfflineLane,
} from "./networkPolicy.js";
import {
  installWebGPULaneRunAssertion,
  installWebGPULaneSpecLedger,
  setWebGPULane,
} from "./webgpuPolicy.js";

// Console capture stays disabled for the enormous engine suite, and
// `specReporter.suppressSkipped` hides pending specs, so each lane sends its one
// stable summary line through Karma explicitly. That is what makes a clean run
// still expose every reasoned skip in its terminal output.
function reportThroughKarma(message) {
  if (typeof window.__karma__?.info === "function") {
    window.__karma__.info({ log: message, type: "info" });
  } else {
    window.console.info(message);
  }
}

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
  webgpuDemanded,
  webgpuRequiredTier,
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
      report: reportThroughKarma,
    });
  }

  // The Scene-level WebGPU lane, published before any spec module evaluates
  // for the same reason the offline lane is: `describeRequiresWebGPU()` decides
  // at declaration time whether its suite runs.
  //
  // The ledger and the end-of-run assertion install UNCONDITIONALLY, not only
  // when the lane is demanded. The assertion throws only for a demanded run,
  // but it also emits the lane's summary line on any run that declared a lane
  // suite — and that line is the only thing that makes a skipped lane visible,
  // since `specReporter.suppressSkipped` hides pending and excluded specs from
  // the default reporter entirely.
  setWebGPULane({
    demanded: webgpuDemanded === true,
    requiredTier: webgpuRequiredTier,
  });
  installWebGPULaneSpecLedger(env, window);
  installWebGPULaneRunAssertion(env, {
    scope: window,
    report: reportThroughKarma,
  });

  // The spec-level host-capability lane. A guarded spec probes its capability
  // when it starts and, where the host lacks it, records a pending spec with
  // the probe's reason; the report below is the only place that reason
  // surfaces. `--require-capabilities` (read by token, like `--offline`)
  // demands every capability, and a demanded WebGPU Scene lane demands the
  // WebGPU API, so a host that should serve a guarded spec fails it instead.
  setCapabilityLane({
    demanded: demandedCapabilities(window.__karma__?.config?.args, {
      webgpuDemanded: webgpuDemanded === true,
    }),
  });
  installCapabilityLaneSpecLedger(env, window);
  installCapabilityLaneRunReport(env, {
    scope: window,
    report: reportThroughKarma,
  });

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
