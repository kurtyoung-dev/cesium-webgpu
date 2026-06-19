import { useEffect, useRef, useState } from "react";
import { embedInSandcastleTemplate } from "./Helpers";
import "./Bucket.css";
import { ConsoleMessageType } from "./ConsoleMirror";
import {
  BridgeToBucket,
  IframeBridge,
  MessageToApp,
} from "./util/IframeBridge";
import { RendererMode } from "./SettingsContext";

const INNER_ORIGIN = __INNER_ORIGIN__;
// This constructs urls like `[__INNER_ORIGIN__]/[pathname]/templates/bucket.html`
// using location.pathname lets this adapt to deployed locations like CI
const bucketUrl = `${new URL(`${location.pathname.replace(/[^\/]+.html/, "")}templates/bucket.html`, __INNER_ORIGIN__)}`;

/**
 * A single bucket iframe that runs sandcastle code with a specific renderer.
 */
function BucketFrame({
  code,
  html,
  runNumber,
  renderer,
  showFps,
  highlightLine,
  appendConsole,
  resetConsole,
  label,
  onRunComplete,
}: {
  code: string;
  html: string;
  runNumber: number;
  renderer: "webgl" | "webgpu";
  showFps: boolean;
  highlightLine: (lineNumber: number) => void;
  appendConsole: (type: ConsoleMessageType, message: string) => void;
  resetConsole: (options?: { showMessage?: boolean | undefined }) => void;
  label?: string;
  onRunComplete?: () => void;
}) {
  const iframeBridge = useRef<BridgeToBucket>(null);
  const lastRunNumber = useRef<number>(Number.NEGATIVE_INFINITY);
  const [bucketReady, setBucketReady] = useState(false);

  useEffect(() => {
    if (
      bucketReady &&
      runNumber !== lastRunNumber.current &&
      iframeBridge.current
    ) {
      iframeBridge.current.sendMessage({
        type: "reload",
      });
    }
    lastRunNumber.current = runNumber;
  }, [bucketReady, code, html, runNumber]);

  useEffect(() => {
    const messageHandler = function (message: MessageToApp) {
      if (!iframeBridge.current) {
        return;
      }

      if (message.type === "bucketReady") {
        setBucketReady(true);
        const isFirefox = navigator.userAgent.indexOf("Firefox/") >= 0;

        resetConsole();
        iframeBridge.current.sendMessage({
          type: "runCode",
          code: embedInSandcastleTemplate(code, isFirefox, renderer, showFps),
          html,
          renderer,
          showFps,
        });
      } else if (message.type === "consoleClear") {
        resetConsole({ showMessage: true });
      } else if (message.type === "consoleLog") {
        appendConsole("log", label ? `[${label}] ${message.log}` : message.log);
      } else if (message.type === "consoleError") {
        let errorMsg = message.error;
        const lineNumber = message.lineNumber;
        if (lineNumber) {
          errorMsg += ` (on line ${lineNumber}`;
          if (message.url) {
            errorMsg += ` of ${message.url}`;
          }
          errorMsg += ")";
        }
        appendConsole("error", label ? `[${label}] ${errorMsg}` : errorMsg);
      } else if (message.type === "consoleWarn") {
        appendConsole(
          "warn",
          label ? `[${label}] ${message.warn}` : message.warn,
        );
      } else if (message.type === "runComplete") {
        onRunComplete?.();
      } else if (message.type === "highlight") {
        highlightLine(message.highlight);
      }
    };

    if (!iframeBridge.current) {
      return;
    }
    iframeBridge.current.addEventListener(messageHandler);
    return () => iframeBridge.current?.removeEventListener();
  }, [
    code,
    html,
    renderer,
    showFps,
    label,
    highlightLine,
    resetConsole,
    appendConsole,
    onRunComplete,
  ]);

  return (
    <iframe
      ref={(iframe) => {
        if (
          iframe?.contentWindow &&
          (!iframeBridge.current ||
            iframeBridge.current.targetWindow !== iframe.contentWindow)
        ) {
          iframeBridge.current = new IframeBridge(
            INNER_ORIGIN,
            iframe.contentWindow,
          );
        }
      }}
      src={bucketUrl}
      className="fullFrame"
      sandbox="allow-scripts allow-same-origin"
      allowFullScreen
    ></iframe>
  );
}

export function Bucket({
  code,
  html,
  runNumber,
  rendererMode,
  showFps,
  highlightLine,
  appendConsole,
  resetConsole,
  onRunComplete,
}: {
  code: string;
  html: string;
  runNumber: number;
  rendererMode: RendererMode;
  showFps: boolean;
  highlightLine: (lineNumber: number) => void;
  appendConsole: (type: ConsoleMessageType, message: string) => void;
  resetConsole: (options?: { showMessage?: boolean | undefined }) => void;
  onRunComplete?: () => void;
}) {
  if (rendererMode === "split") {
    return (
      <div className="bucket-container bucket-split">
        <div className="bucket-split-pane">
          <div className="bucket-split-label">WebGL</div>
          <BucketFrame
            key={`webgl-${showFps}`}
            code={code}
            html={html}
            runNumber={runNumber}
            renderer="webgl"
            showFps={showFps}
            highlightLine={highlightLine}
            appendConsole={appendConsole}
            resetConsole={resetConsole}
            label="WebGL"
            onRunComplete={onRunComplete}
          />
        </div>
        <div className="bucket-split-divider" />
        <div className="bucket-split-pane">
          <div className="bucket-split-label">WebGPU</div>
          <BucketFrame
            key={`webgpu-${showFps}`}
            code={code}
            html={html}
            runNumber={runNumber}
            renderer="webgpu"
            showFps={showFps}
            highlightLine={highlightLine}
            appendConsole={appendConsole}
            resetConsole={resetConsole}
            label="WebGPU"
            onRunComplete={onRunComplete}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="bucket-container">
      <BucketFrame
        key={`${rendererMode}-${showFps}`}
        code={code}
        html={html}
        runNumber={runNumber}
        renderer={rendererMode}
        showFps={showFps}
        highlightLine={highlightLine}
        appendConsole={appendConsole}
        resetConsole={resetConsole}
        onRunComplete={onRunComplete}
      />
    </div>
  );
}

export function BucketPlaceholder() {
  return (
    <div className="bucket-container">
      <div className="fullFrame">Loading...</div>
    </div>
  );
}
