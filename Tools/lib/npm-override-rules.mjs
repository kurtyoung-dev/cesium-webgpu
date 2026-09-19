// npm-override-rules.mjs — what npm allows in `overrides` when the override meets a direct dependency.
//
// @purpose Decides, from manifest objects alone, which root `overrides` entries npm rejects as conflicting with a direct dependency or as an unresolvable `$` reference.
// @status ACTIVE

//
// WHY THIS EXISTS. `overrides` is loaded before anything is fetched, so a
// malformed entry fails `npm install` itself: every job of every workflow dies
// at its first step and the repository gets no CI signal at all, on a tree that
// is otherwise green. The rule that trips it is short but easy to miss, because
// the manifest reads as if it works.
//
// THE RULE NPM ENFORCES, from `@npmcli/arborist`. `Node.assertRootOverrides`
// (`node.js:1347-1359` in npm 10.9.8, the npm node 22 bundles and the one CI
// installs) walks the project root's own dependency edges and throws
// `EOVERRIDE` for any edge whose overridden spec differs from the declared one.
// That comparison runs AFTER `Edge.spec` (`edge.js:180-207`) has substituted a
// `$name` reference, so a reference is not a blanket exemption: it is legal
// only when it RESOLVES to the declared spec, which a reference naming the same
// package does by construction and a reference naming another package generally
// does not. Measured: a root declaring `{ms: "2.1.3", debug: "^4.4.3"}` with
// `overrides: {debug: "$ms"}` fails with
// `Override for debug@^4.4.3 conflicts with direct dependency`. The same getter
// skips an override whose value is exactly `"*"`, and `OverrideSet` rewrites an
// empty value to `"*"`, so both of those install untouched. A reference the
// root cannot resolve throws `Unable to resolve reference` instead; `Edge.spec`
// searches for it in {@link SECTION_PRECEDENCE} order.
//
// WHAT AN ENTRY IS WORTH. `OverrideSet` sets an entry's value to its `"."` key
// when it has one and to the KEY'S OWN version selector when it does not
// (`override-set.js:30`: `this.value = overrides['.'] || this.keySpec`), so
// `"pkg@4.2.0": { … }` pins `pkg` at `4.2.0` while looking like it only scopes
// that package's children. A key carrying no selector yields `"*"`, which is
// why a bare nested entry is inert. Measured: a workspace declaring
// `debug: "^4.0.0"` under a root `overrides: {"debug@4.3.4": {ms: "2.1.3"}}`
// resolves debug 4.3.4, where the same tree without that entry resolves 4.4.3.
//
// WHICH DECLARATION THE EDGE CARRIES. A name declared in several sections still
// produces ONE root edge: `Node[_loadDeps]` (`node.js:869-910`) loads peer,
// then prod, optional and finally dev, and `#loadDepType` prioritizes a new
// edge over an existing one, so the LAST section loaded owns the edge's
// `rawSpec`. Reversed, that is {@link SECTION_PRECEDENCE}. Measured:
// `{dependencies: {ms: "2.1.3"}, devDependencies: {ms: "^2.1.3"}, overrides:
// {ms: "2.1.3"}}` fails with `Override for ms@^2.1.3 …`, and the same manifest
// with those two sections swapped installs.
//
// WHAT NPM DOES NOT ENFORCE. `assertRootOverrides` runs on the project root
// only. A root override that retargets a WORKSPACE's direct dependency to a
// different spec installs silently, which is legitimate and is how a workspace
// gets pinned from above. This module reports that case too, under its own rule
// id and with `npmEnforced: false`, because in this repository an override that
// drifts from the spec beside it is nearly always an editing accident rather
// than a decision; a caller that wants the pin keeps the finding and records
// why, and a caller that wants npm's own rule filters on `npmEnforced`. It
// reports it only for a spec somebody WROTE as a spec - a string value or a
// `"."` key. When the version lives in the key itself the pin is stated where
// it is read and there is no second place for it to disagree with, which is the
// shape this repository's `"@huggingface/transformers@4.2.0"` entry uses.
//
// NO SEMVER. npm applies a selectored key only where the selector intersects
// the edge's spec (`OverrideSet.getEdgeRule`). Deciding intersection needs a
// semver implementation this repository does not depend on from tooling, so
// this module decides only the part it can: a selector byte-identical to the
// declared spec intersects it by definition, so that finding is
// `npmEnforced: true`; any other selector is reported with
// `npmEnforced: false` and a message that says which way it can go. Measured
// both ways - `{"ms@^2.1.3": "2.1.3"}` over a declared `^2.1.3` exits 1, while
// `{"ms@^1.0.0": "1.0.0"}` over the same declaration exits 0.
//
// PURE. Manifest objects in, findings out: no filesystem, no process, no
// network, so a caller can feed it synthetic manifests as easily as the real
// ones.

/** Rule ids a finding can carry. */
export const OVERRIDE_RULE = Object.freeze({
  /** npm throws EOVERRIDE: the root depends on this package directly. */
  ROOT_DIRECT_CONFLICT: "root-direct-conflict",
  /** npm throws: `$name` names nothing in the root's dependency sections. */
  DANGLING_REFERENCE: "dangling-reference",
  /** npm allows it; the spec differs from the workspace's own declaration. */
  WORKSPACE_DIRECT_DRIFT: "workspace-direct-drift",
  /** A selectored key over a direct dependency; npm rejects it where the selector intersects. */
  SELECTOR_CONDITIONAL: "selector-conditional-direct-override",
});

/**
 * The order npm's own machinery walks a manifest's dependency sections.
 *
 * `Edge.spec` searches a `$name` reference in this order, and `Node[_loadDeps]`
 * loads the sections in exactly the reverse - peer, prod, optional, dev -
 * keeping the last edge it builds. So one list serves both: it is where a
 * reference resolves from, and it is the precedence of the single edge npm
 * keeps per name, which is the declaration an override is compared against.
 *
 * @type {readonly string[]}
 */
export const SECTION_PRECEDENCE = Object.freeze([
  "devDependencies",
  "optionalDependencies",
  "dependencies",
  "peerDependencies",
]);

/**
 * Split an override key into the package name and its optional version selector.
 *
 * Scoped names keep their leading `@`, so the selector is the part after the
 * last `@` that is not at index 0.
 *
 * @param {string} key An `overrides` key.
 * @returns {{name: string, selector: string|null}} Name and selector.
 */
export function parseOverrideKey(key) {
  const at = key.lastIndexOf("@");
  if (at <= 0) {
    return { name: key, selector: null };
  }
  return { name: key.slice(0, at), selector: key.slice(at + 1) };
}

/**
 * The one declaration of `name` whose spec the manifest's own edge carries.
 *
 * npm keeps a single edge per name and the last section it loads wins, so the
 * search runs in {@link SECTION_PRECEDENCE} and stops at the first hit.
 * Comparing against any section that happens to match instead accepts shapes
 * npm rejects: `{dependencies: {ms: "2.1.3"}, devDependencies: {ms: "^2.1.3"},
 * overrides: {ms: "2.1.3"}}` fails with
 * `Override for ms@^2.1.3 conflicts with direct dependency`.
 *
 * @param {object} manifest A parsed package.json.
 * @param {string} name Package name.
 * @returns {{section: string, spec: string}|null} The declaration the edge carries, or null.
 */
function effectiveDeclaration(manifest, name) {
  for (const section of SECTION_PRECEDENCE) {
    const spec = manifest?.[section]?.[name];
    if (typeof spec === "string") {
      return { section, spec };
    }
  }
  return null;
}

/**
 * The spec an override entry sets for the package named by its own key.
 *
 * A string value is that spec, and an object value states it through a `"."`
 * key. When neither is present npm does NOT leave the package alone: it falls
 * back to the version selector carried by the key, which is `"*"` for a key
 * that has none. An empty value is rewritten to `"*"` by the same constructor.
 *
 * The second half of the return says whether somebody wrote the spec or npm
 * derived it from the key, which is the difference between a value that can
 * drift from a declaration beside it and a pin stated where it is read.
 *
 * @param {unknown} value The value of an `overrides` entry.
 * @param {string|null} selector The version selector carried by the entry's key, if any.
 * @returns {{spec: string, written: boolean}} The spec npm gives the package, and whether it was written rather than derived.
 */
function effectiveValueOf(value, selector) {
  let stated = null;
  if (typeof value === "string") {
    stated = value;
  } else if (
    value &&
    typeof value === "object" &&
    typeof value["."] === "string"
  ) {
    stated = value["."];
  }
  if (stated !== null) {
    return { spec: stated === "" ? "*" : stated, written: true };
  }
  return { spec: selector ?? "*", written: false };
}

/**
 * Walk an overrides tree, yielding the spec every entry gives its own package
 * along with the path that owns it.
 *
 * @param {object} overrides An `overrides` object.
 * @param {string[]} path Keys already walked.
 * @returns {{path: string[], key: string, name: string, selector: string|null, spec: string, written: boolean, topLevel: boolean}[]} Entries.
 */
function collectSpecs(overrides, path = []) {
  const entries = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key === ".") {
      continue;
    }
    const here = [...path, key];
    const { name, selector } = parseOverrideKey(key);
    const { spec, written } = effectiveValueOf(value, selector);
    entries.push({
      path: here,
      key,
      name,
      selector,
      spec,
      written,
      topLevel: path.length === 0,
    });
    if (value && typeof value === "object") {
      entries.push(...collectSpecs(value, here));
    }
  }
  return entries;
}

/**
 * Report every `overrides` entry that npm would reject, plus the workspace
 * drift npm tolerates.
 *
 * @param {object} input Manifests to check.
 * @param {object} input.root The parsed root package.json, whose `overrides` are the only ones npm reads.
 * @param {{path: string, manifest: object}[]} [input.workspaces] Workspace manifests, each with the path it was read from.
 * @returns {{rule: string, name: string, path: string[], spec: string, npmEnforced: boolean, declaredIn: {manifest: string, section: string, spec: string}[], message: string}[]} Findings, empty when the manifests comply.
 */
export function findOverrideViolations({ root, workspaces = [] }) {
  const findings = [];
  const overrides = root?.overrides;
  if (!overrides || typeof overrides !== "object") {
    return findings;
  }

  for (const entry of collectSpecs(overrides)) {
    const { name, selector } = entry;
    const where = entry.path.join(" > ");

    if (entry.spec === "*") {
      // `Edge.spec` hands back the declared spec untouched when the override
      // value is exactly "*", so this entry rewrites nothing and cannot
      // conflict with anything, however the package is declared.
      continue;
    }

    // What npm ends up comparing against the declaration: the entry's own spec,
    // or whatever a `$name` reference resolves to.
    let effectiveSpec = entry.spec;
    if (entry.spec.startsWith("$")) {
      const referenced = entry.spec.slice(1);
      const target = effectiveDeclaration(root, referenced);
      if (target === null) {
        findings.push({
          rule: OVERRIDE_RULE.DANGLING_REFERENCE,
          name,
          path: entry.path,
          spec: entry.spec,
          npmEnforced: true,
          declaredIn: [],
          message: `overrides["${where}"] is "${entry.spec}" but "${referenced}" is not a direct dependency of the root, so npm fails the install with "Unable to resolve reference ${entry.spec}"`,
        });
        continue;
      }
      // npm substitutes the reference and then runs the same comparison on the
      // result, so a resolvable reference falls through to it rather than
      // exempting the entry.
      effectiveSpec = target.spec;
    }

    if (!entry.topLevel) {
      // Below the top level the override retargets a transitive edge, which
      // never meets the root's own edges, so no conflict rule applies.
      continue;
    }

    const rootDeclaration = effectiveDeclaration(root, name);
    if (rootDeclaration !== null) {
      if (rootDeclaration.spec === effectiveSpec) {
        // The override agrees with the root's own declaration, which is the
        // shape a deliberate pin takes; a workspace declaring something else is
        // then the thing being pinned, not a disagreement to report.
        continue;
      }
      const resolvesTo =
        effectiveSpec === entry.spec
          ? ""
          : ` (which resolves to "${effectiveSpec}")`;
      const declaredIn = [
        {
          manifest: "package.json",
          section: rootDeclaration.section,
          spec: rootDeclaration.spec,
        },
      ];
      if (selector !== null) {
        // A selector byte-identical to the declared spec intersects it by
        // definition, so that much is decidable here; any other selector needs
        // semver and is reported without claiming npm rejects the manifest.
        const certain = selector === rootDeclaration.spec;
        findings.push({
          rule: OVERRIDE_RULE.SELECTOR_CONDITIONAL,
          name,
          path: entry.path,
          spec: entry.spec,
          npmEnforced: certain,
          declaredIn,
          message: certain
            ? `overrides["${where}"] gives "${name}" the spec "${effectiveSpec}" while the root declares "${rootDeclaration.spec}" in ${rootDeclaration.section}; the selector "${selector}" is that same range, so npm applies the entry and fails the install with EOVERRIDE`
            : `overrides["${where}"] gives "${name}" the spec "${effectiveSpec}" while the root declares "${rootDeclaration.spec}" in ${rootDeclaration.section}; npm applies the entry whenever the selector "${selector}" intersects that range and then fails the install with EOVERRIDE, and deciding which of the two this is needs semver`,
        });
        continue;
      }
      findings.push({
        rule: OVERRIDE_RULE.ROOT_DIRECT_CONFLICT,
        name,
        path: entry.path,
        spec: entry.spec,
        npmEnforced: true,
        declaredIn,
        message: `overrides["${where}"] is "${entry.spec}"${resolvesTo} but the root declares "${name}": "${rootDeclaration.spec}" in ${rootDeclaration.section}; npm fails the install with EOVERRIDE. Use "${name}", naming this same package, or the identical spec.`,
      });
      continue;
    }

    if (!entry.written) {
      // The spec came from the key's own selector rather than from a value
      // written beside a declaration, so there is no second statement of it to
      // have drifted: the pin is stated where it is read.
      continue;
    }

    for (const workspace of workspaces) {
      const declaration = effectiveDeclaration(workspace.manifest, name);
      if (declaration === null || declaration.spec === effectiveSpec) {
        continue;
      }
      findings.push({
        rule: OVERRIDE_RULE.WORKSPACE_DIRECT_DRIFT,
        name,
        path: entry.path,
        spec: entry.spec,
        npmEnforced: false,
        declaredIn: [
          {
            manifest: workspace.path,
            section: declaration.section,
            spec: declaration.spec,
          },
        ],
        message: `overrides["${where}"] is "${entry.spec}" but ${workspace.path} declares "${name}": "${declaration.spec}" in ${declaration.section}; npm installs this silently, so the override and the declaration beside it must agree or the pin must be stated as such`,
      });
    }
  }

  return findings;
}
