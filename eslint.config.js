import globals from "globals";
import html from "eslint-plugin-html";
import configCesium from "@cesium/eslint-config";
import reactHooks from "eslint-plugin-react-hooks";
import { reactRefresh } from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import seatbelt from "eslint-seatbelt";
import { SeatbeltFile } from "eslint-seatbelt/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seatbeltToRelativePath = SeatbeltFile.prototype.toRelativePath;

// The ratchet file is shared by Windows and Linux, so normalize lookup keys
// even when a worker reuses dependencies whose postinstall step ran elsewhere.
SeatbeltFile.prototype.toRelativePath = function (filename) {
  return seatbeltToRelativePath.call(this, filename).replaceAll("\\", "/");
};

export default [
  tseslint.configs.base,
  {
    ignores: [
      // Gitignored evidence store - probe artifacts, not repository code.
      "Tools/visual-regression/output/",
      // Untracked prototype with its own preregistered lint cycle; joins the
      // repository gate when it is tracked.
      "Tools/patch-prototype/",
      "**/Build/",
      "Documentation/**/*",
      "Source/*",
      "**/ThirdParty/",
      // Vendored/generated content under Tools/ stays ignored; the rest of
      // Tools/ is linted by the dedicated blocks near the bottom of this file.
      // - naga-wasm-tools: wasm-bindgen output (also declared vendored in
      //   lint-staged.config.js).
      // - jsdoc template static/: bundled third-party browser scripts
      //   (prism.js, the html5 shiv) shipped with the doc theme.
      "Tools/shader-pipeline/naga-wasm-tools/",
      "Tools/jsdoc/cesium_template/static/",
      // wasm-bindgen build outputs + local scratch — git-ignored, but
      // present in local working trees. CI never sees these; ignoring
      // them keeps local `npm run eslint` equivalent to the CI run.
      // .claude/ is harness scratch (agent worktrees, workflow scripts).
      ".claude/",
      "packages/wasm/pkg/",
      "packages/wasm-naga/pkg/",
      "packages/wasm-naga/pkg-tooling/",
      "tmp/",
      "index.html",
      "index.release.html",
      "Apps/HelloWorld.html",
      "Apps/WebGPUTest/**/*",
      "Apps/Sandcastle/jsHintOptions.js",
      "Apps/Sandcastle/gallery/gallery-index.js",
      "Apps/Sandcastle2/",
      "packages/sandcastle/public/",
      "packages/sandcastle/templates/Sandcastle.d.ts",
      "packages/sandcastle/templates/Sandcastle.js",
      "packages/sandcastle/gallery/pagefind/",
      "packages/engine/Source/Scene/GltfPipeline/**/*",
      "packages/engine/Source/Shaders/**/*",
      "Specs/jasmine/*",
      "**/*/SpecList.js",
    ],
  },
  {
    ...configCesium.configs.recommended,
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      sourceType: "module",
    },
  },
  {
    files: ["**/*.cjs"],
    ...configCesium.configs.node,
  },
  {
    files: [
      ".github/**/*.js",
      "scripts/**/*.js",
      "scripts/**/*.mjs",
      "packages/sandcastle/scripts/**/*.js",
      "packages/wasm-naga/*.mjs",
      "gulpfile.js",
      "gulpfile.apps.js",
      "gulpfile.makezip.js",
      "server.js",
    ],
    ...configCesium.configs.node,
    languageOptions: {
      ...configCesium.configs.node.languageOptions,
      sourceType: "module",
    },
  },
  {
    files: ["packages/**/*.js", "Apps/**/*.js", "Specs/**/*.js", "**/*.html"],
    ignores: ["packages/sandcastle/scripts/**/*.js"],
    ...configCesium.configs.browser,
    plugins: { html, "eslint-seatbelt": seatbelt },
    processor: seatbelt.processors.seatbelt,
    settings: {
      seatbelt: {
        seatbeltFile: join(__dirname, "eslint.seatbelt.tsv"),
      },
    },
    rules: {
      ...configCesium.configs.browser.rules,
      "eslint-seatbelt/configure": "error",
      "no-unused-vars": [
        "error",
        { vars: "all", args: "none", caughtErrors: "none" },
      ],
      // There were too many errors to address when this was first turned on.
      // Using eslint-seatbelt to gradually address them
      "no-useless-assignment": "error",
      "no-restricted-syntax": [
        "warn",
        {
          // The pattern of Array.push.apply() can lead to stack
          // overflow errors when the source array is large.
          // See https://github.com/CesiumGS/cesium/issues/12053
          selector:
            "CallExpression[callee.object.property.name=push][callee.property.name=apply]",
          message:
            "Avoid Array.push.apply(). Use addAllToArray() for arrays of unknown size, or the spread syntax for arrays that are known to be small",
        },
      ],
      // When ES6 class implementations refer to scratch variable instances of
      // the same class, ESLint raises a use-before-define error. At runtime
      // this is just fine, so configure ESLint to allow it in upper scopes.
      "no-use-before-define": [
        "error",
        { variables: false, functions: false, classes: false },
      ],
      // Prefer @ts-expect-error (with description) over @ts-ignore. Allow both
      // @ts-check and @ts-nocheck during transition to type checking.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          minimumDescriptionLength: 3,
          "ts-ignore": true,
          "ts-expect-error": "allow-with-description",
          "ts-check": false,
          "ts-nocheck": false,
        },
      ],
      // Disallow e.g. `new Cartesian3.fromDegrees(...)`; invalid with ES6 classes.
      "new-cap": ["error", { capIsNew: true }],
    },
  },
  ...[...tseslint.configs.recommended].map((config) => ({
    ...config,
    files: ["packages/*/Source/**/*.ts"],
  })),
  {
    files: ["packages/*/Source/**/*.ts"],
    plugins: { "eslint-seatbelt": seatbelt },
    processor: seatbelt.processors.seatbelt,
    settings: {
      seatbelt: {
        seatbeltFile: join(__dirname, "eslint.seatbelt.tsv"),
      },
    },
    rules: {
      // The recommended backlog is pinned per file and rule so a new
      // violation fails while existing issues can be retired incrementally.
      "eslint-seatbelt/configure": "error",
    },
  },
  ...[...tseslint.configs.recommended].map((config) => ({
    // This is needed to restrict to a specific path unless using the tseslint.config function
    // https://typescript-eslint.io/packages/typescript-eslint#config
    ...config,
    files: ["packages/sandcastle/**/*.{ts,tsx}"],
  })),
  {
    // This config came from the vite project generation
    files: ["packages/sandcastle/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh.plugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["packages/sandcastle/gallery/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-alert": "off",
    },
  },
  {
    files: ["packages/sandcastle/gallery/hello-world/main.js"],
    rules: {
      // ignore this rule here to avoid the excessive eslint-disable comment in our bare minimum example
      "no-unused-vars": "off",
    },
  },
  {
    files: ["Specs/**/*", "packages/**/Specs/**/*"],
    languageOptions: {
      globals: {
        ...globals.jasmine,
      },
    },
    rules: {
      "no-self-assign": "off",
    },
  },
  {
    files: ["Specs/e2e/**/*"],
    languageOptions: {
      globals: {
        ...globals.node,
        Cesium: true,
      },
    },
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    files: [".github/**/*"],
    rules: {
      "n/no-missing-import": "off",
    },
  },
  // -------------------------------------------------------------------------
  // Tools/** — the Playwright probe + spec fleet.
  //
  // These are Node-hosted ESM scripts that ALSO carry browser code: nearly
  // every probe hands a function to `page.evaluate()`, so `window`,
  // `document`, `performance`, `getComputedStyle`, ... appear as free
  // identifiers inside an otherwise Node module. ESLint has no way to scope
  // those callbacks to the page, so the block declares BOTH global sets and
  // keeps `no-undef` on — it still catches real typos against every name that
  // neither environment defines.
  //
  // Policy: correctness rules on, stylistic rules delegated to Prettier.
  // `cesium/recommended` already folds in eslint-config-prettier, so the
  // formatting rules are off; the `rules` block below only relaxes the
  // *house-style* rules that encode CesiumJS engine-source conventions and
  // carry no correctness signal for throwaway diagnostic scripts.
  // -------------------------------------------------------------------------
  {
    files: ["Tools/**/*.js", "Tools/**/*.mjs"],
    ignores: [
      "Tools/jsdoc/**/*.js",
      "Tools/rollup-plugin-strip-pragma/**/*.js",
    ],
    ...configCesium.configs.recommended,
    languageOptions: {
      sourceType: "module",
      ecmaVersion: 2023,
      globals: {
        ...globals.node,
        ...globals.browser,
        // Injected into the page by the fork's viewer/debug harnesses and
        // read from inside page.evaluate() callbacks.
        Cesium: "readonly",
        CesiumDebug: "readonly",
      },
    },
    rules: {
      ...configCesium.configs.recommended.rules,
      // --- correctness, explicitly pinned -------------------------------
      // Probes routinely destructure a wide result object and use a subset,
      // and catch blocks legitimately ignore the error. Keep the rule ON for
      // real dead bindings but allow the conventional `_` escape hatch.
      "no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "none",
          caughtErrors: "none",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // `new Function(...)` / `eval` are how in-page snippets are injected by
      // the harness, so the fleet already annotates each intentional use with
      // a local disable. Keep both rules ON so those annotations stay
      // meaningful and a NEW unannotated use is caught.
      "no-new-func": "error",
      "no-eval": "error",
      // `ignoreReadBeforeAssign` — the harness declares `let remove;` /
      // `let timeoutId;` above a settle() closure that reads them, then
      // assigns after wiring the listener. Without this option the rule's own
      // suggestion (`const`) would introduce a TDZ throw.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // Same rationale as the engine block above: module-scope constants are
      // routinely declared below the helpers that close over them, which is
      // fine at runtime because the helper is not called until later.
      "no-use-before-define": [
        "error",
        { variables: false, functions: false, classes: false },
      ],
      // --- half-relaxed rules: correctness half kept, idiom half off ----
      // Keep `===` enforcement for value comparisons, but allow the
      // deliberate `x == null` / `x != null` nullish test — every one of the
      // 57 loose comparisons in the fleet is that idiom, and rewriting them
      // to `x === null || x === undefined` would be a semantic change.
      eqeqeq: ["error", "always", { null: "ignore" }],
      // `try { ... } catch {}` is the fleet's best-effort cleanup/teardown
      // idiom (page already closed, device already lost). Empty blocks of
      // any OTHER kind are still errors.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Keep `newIsCap` (with property checking) — that is the half that
      // catches the real bug `new Cesium.Cartesian3.fromDegrees(...)`. Drop
      // `capIsNew`: probes alias helpers to single uppercase letters
      // (`const T = () => JulianDate.fromIso8601(...)`) inside page.evaluate
      // bodies where brevity matters, and `T()` is not a constructor call.
      "new-cap": ["error", { capIsNew: false }],
      // --- house-style rules relaxed for the probe idiom ----------------
      // Brace style: 3577 violations across the fleet, all `if (x) return;`
      // guard chains. Zero correctness signal, and reflowing every probe
      // would bury real review signal in mechanical noise. Prettier already
      // fixes the indentation of whichever form the author chose.
      curly: "off",
      // Probes build fixed-width report tables by concatenating padded
      // numeric columns (385 violations); template literals make those
      // strictly less readable.
      "prefer-template": "off",
    },
  },
  {
    // jsdoc template plugins + the rollup pragma plugin are CommonJS scripts
    // loaded by their host tools, not ESM.
    files: ["Tools/jsdoc/**/*.js", "Tools/rollup-plugin-strip-pragma/**/*.js"],
    ...configCesium.configs.node,
    rules: {
      ...configCesium.configs.node.rules,
      // These files predate the fork and mirror jsdoc/rollup plugin
      // conventions; modernizing them is out of scope for lint coverage.
      "no-var": "off",
      "prefer-const": "off",
      "prefer-template": "off",
      curly: "off",
      "no-else-return": "off",
      // jsdoc tag handlers receive the full (doclet, tag) signature whether
      // or not a given handler needs both.
      "no-unused-vars": [
        "error",
        { vars: "all", args: "none", caughtErrors: "none" },
      ],
      // jsdoc/rollup host modules are resolved by the host tool at runtime,
      // not from this package's dependency tree.
      "n/no-missing-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
];
