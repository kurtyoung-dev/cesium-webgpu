/**
 * jscodeshift codemod: Convert CesiumJS prototype-based classes to ES6 classes.
 *
 * Handles the canonical CesiumJS pattern:
 *   function Foo(options) { this._x = ...; }
 *   Object.defineProperties(Foo.prototype, { x: { get/set } });
 *   Foo.prototype.method = function(...) { ... };
 *   Foo.staticMethod = function(...) { ... };
 *   Foo.CONSTANT = Object.freeze(...);
 *   export default Foo;
 *
 * Usage:
 *   npx jscodeshift -t scripts/codemod-es6-class.cjs --extensions js <files...>
 *   npx jscodeshift -t scripts/codemod-es6-class.cjs packages/engine/Source/Core/*.js
 *
 * The transform preserves:
 *   - All JSDoc comments (attached to functions, properties, the class)
 *   - Static properties and methods (placed after the class declaration)
 *   - Complex patterns it can't safely convert (skips the file)
 *
 * After running, manually verify:
 *   1. `npx tsc --noEmit` passes
 *   2. `npm test` passes
 *   3. Spot-check a few files for correctness
 */

module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  // ── Step 0: Detect the constructor function ──────────────────────────
  // CesiumJS constructors are top-level FunctionDeclarations with
  // PascalCase names that are the default export.

  // Find `export default Foo;`
  const defaultExports = root.find(j.ExportDefaultDeclaration);
  if (defaultExports.length === 0) return; // No default export → skip

  const defaultExportNode = defaultExports.get().node;
  let className;
  if (defaultExportNode.declaration.type === "Identifier") {
    className = defaultExportNode.declaration.name;
  } else {
    return; // export default is not an identifier → skip
  }

  // Must start with uppercase (PascalCase constructor convention)
  if (!/^[A-Z]/.test(className)) return;

  // Find the constructor function
  const ctorDecls = root.find(j.FunctionDeclaration, {
    id: { name: className },
  });
  if (ctorDecls.length !== 1) return; // 0 or multiple → skip

  const ctorPath = ctorDecls.get();
  const ctorNode = ctorPath.node;

  // Verify it uses `this.` (it's a constructor, not a utility function)
  const source = fileInfo.source;
  const ctorSource = source.substring(ctorNode.start, ctorNode.end);
  if (!ctorSource.includes("this.") && !ctorSource.includes("this[")) {
    return; // Not a constructor pattern
  }

  // Already a class? Skip.
  if (source.includes(`class ${className}`)) return;

  // ── Step 1: Extract prototype methods ────────────────────────────────
  const methods = [];
  const statics = [];
  const nodesToRemove = [];

  // Pattern: Foo.prototype.methodName = function(...) { ... };
  root
    .find(j.ExpressionStatement, {
      expression: {
        type: "AssignmentExpression",
        left: {
          type: "MemberExpression",
          object: {
            type: "MemberExpression",
            object: { name: className },
            property: { name: "prototype" },
          },
        },
      },
    })
    .forEach((path) => {
      const expr = path.node.expression;
      const methodName = expr.left.property.name || expr.left.property.value;
      const value = expr.right;

      if (
        value.type === "FunctionExpression" ||
        value.type === "ArrowFunctionExpression"
      ) {
        const methodNode = j.methodDefinition(
          "method",
          j.identifier(methodName),
          j.functionExpression(
            null,
            value.params,
            value.body,
            value.generator,
            value.async,
          ),
          false, // not static
        );
        // Preserve leading comments (JSDoc)
        methodNode.comments = path.node.leadingComments || path.node.comments;
        methods.push(methodNode);
        nodesToRemove.push(path);
      }
      // Non-function assignments to prototype (rare) → skip
    });

  // ── Step 2: Extract Object.defineProperties getters/setters ─────────
  root
    .find(j.ExpressionStatement, {
      expression: {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          object: { name: "Object" },
          property: { name: "defineProperties" },
        },
      },
    })
    .forEach((path) => {
      const args = path.node.expression.arguments;
      if (args.length < 2) return;

      // Check it's on Foo.prototype
      const target = args[0];
      if (
        target.type !== "MemberExpression" ||
        target.object.name !== className ||
        target.property.name !== "prototype"
      ) {
        return;
      }

      const props = args[1];
      if (props.type !== "ObjectExpression") return;

      // Leading comment for the whole defineProperties block
      const blockComments = path.node.leadingComments || [];

      props.properties.forEach((prop, idx) => {
        if (prop.type !== "Property") return;
        const propName = prop.key.name || prop.key.value;
        if (!prop.value || prop.value.type !== "ObjectExpression") return;

        prop.value.properties.forEach((accessor) => {
          if (accessor.type !== "Property") return;
          const kind = accessor.key.name; // "get" or "set"
          if (kind !== "get" && kind !== "set") return;
          const fn = accessor.value;
          if (
            fn.type !== "FunctionExpression" &&
            fn.type !== "ArrowFunctionExpression"
          ) {
            return;
          }

          const methodNode = j.methodDefinition(
            kind, // "get" or "set"
            j.identifier(propName),
            j.functionExpression(null, fn.params, fn.body, false, false),
            false,
          );

          // Attach JSDoc: first accessor of first property gets the block comment
          if (idx === 0 && kind === "get" && blockComments.length > 0) {
            methodNode.comments = blockComments;
          }
          // Per-property comments
          const propComments = prop.leadingComments || [];
          const accessorComments = accessor.leadingComments || [];
          if (propComments.length > 0 && !methodNode.comments) {
            methodNode.comments = propComments;
          } else if (accessorComments.length > 0 && !methodNode.comments) {
            methodNode.comments = accessorComments;
          }

          methods.push(methodNode);
        });
      });

      nodesToRemove.push(path);
    });

  // ── Step 3: Extract static methods and properties ───────────────────
  // Pattern: Foo.staticMethod = function(...) { ... };
  // Pattern: Foo.CONSTANT = value;
  root
    .find(j.ExpressionStatement, {
      expression: {
        type: "AssignmentExpression",
        left: {
          type: "MemberExpression",
          object: { name: className },
        },
      },
    })
    .forEach((path) => {
      const expr = path.node.expression;
      const prop = expr.left.property;
      const propName = prop.name || prop.value;

      // Skip Foo.prototype (already handled above)
      if (propName === "prototype") return;

      // Keep static assignments outside the class — they're often
      // Foo.CONSTANT = Object.freeze(...) or Foo.pack = function(...)
      // which are easier to reason about as post-class statements.
      // We don't remove them — they stay where they are.
    });

  // ── Step 4: Build the class ─────────────────────────────────────────
  if (methods.length === 0 && nodesToRemove.length === 0) {
    return; // Nothing to convert
  }

  // Build constructor method. The class declaration gets the JSDoc
  // (so it appears above `class Foo {`); the constructor method itself
  // gets no duplicate comment.
  const ctorMethod = j.methodDefinition(
    "method",
    j.identifier("constructor"),
    j.functionExpression(
      null,
      ctorNode.params,
      ctorNode.body,
      ctorNode.generator,
      ctorNode.async,
    ),
    false,
  );

  const classBody = j.classBody([ctorMethod, ...methods]);
  const classDecl = j.classDeclaration(j.identifier(className), classBody);

  // Attach the constructor's JSDoc to the class declaration only —
  // prevents the duplicate-JSDoc issue where both `class Foo` and
  // `constructor()` carry identical comment blocks.
  if (ctorNode.leadingComments) {
    classDecl.comments = ctorNode.leadingComments;
  }

  // ── Step 5: Replace in the AST ──────────────────────────────────────
  // Replace the function declaration with the class declaration
  ctorPath.replace(classDecl);

  // Remove the extracted prototype assignments and defineProperties calls
  nodesToRemove.forEach((path) => {
    try {
      path.prune();
    } catch {
      // Some paths may already be removed by a parent prune
    }
  });

  // ── Step 6: Return modified source ──────────────────────────────────
  return root.toSource({
    quote: "double",
    trailingComma: true,
    tabWidth: 2,
  });
};
