/**
 * jscodeshift codemod: Replace `.indexOf(x) !== -1` / `.indexOf(x) >= 0`
 * / `.indexOf(x) > -1` / `.indexOf(x) < 0` patterns with `.includes(x)`.
 *
 * Also handles the negated forms:
 *   `.indexOf(x) === -1` → `!arr.includes(x)`
 *
 * Usage:
 *   npx jscodeshift -t scripts/codemod-indexof-to-includes.cjs --extensions js <dir>
 */

module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  let changed = false;

  // Find all BinaryExpressions where one side is a `.indexOf()` call
  root.find(j.BinaryExpression).forEach((path) => {
    const { left, right, operator } = path.node;

    // Identify which side is the indexOf call
    let indexOfCall, literal, indexOfSide;
    if (
      left.type === "CallExpression" &&
      left.callee.type === "MemberExpression" &&
      left.callee.property.name === "indexOf"
    ) {
      indexOfCall = left;
      literal = right;
      indexOfSide = "left";
    } else if (
      right.type === "CallExpression" &&
      right.callee.type === "MemberExpression" &&
      right.callee.property.name === "indexOf"
    ) {
      indexOfCall = right;
      literal = left;
      indexOfSide = "right";
    } else {
      return;
    }

    // Must compare against -1 or 0
    if (literal.type !== "NumericLiteral" && literal.type !== "Literal") return;
    const num =
      literal.type === "NumericLiteral" ? literal.value : literal.value;
    if (typeof num !== "number") return;

    // indexOf must have exactly 1 argument (the search element)
    if (indexOfCall.arguments.length !== 1) return;

    const obj = indexOfCall.callee.object;
    const searchArg = indexOfCall.arguments[0];

    // Build the .includes() call
    const includesCall = j.callExpression(
      j.memberExpression(obj, j.identifier("includes")),
      [searchArg],
    );

    // Determine the replacement based on operator and compared value.
    // Normalize for left/right side of the comparison.
    let effectiveOp = operator;
    if (indexOfSide === "right") {
      // Flip the operator: `-1 < indexOf(x)` → `indexOf(x) > -1`
      const flipMap = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
      effectiveOp = flipMap[operator] || operator;
    }

    if (num === -1) {
      if (effectiveOp === "!==" || effectiveOp === "!=") {
        // indexOf(x) !== -1 → includes(x)
        path.replace(includesCall);
        changed = true;
      } else if (effectiveOp === "===" || effectiveOp === "==") {
        // indexOf(x) === -1 → !includes(x)
        path.replace(j.unaryExpression("!", includesCall));
        changed = true;
      } else if (effectiveOp === ">") {
        // indexOf(x) > -1 → includes(x)
        path.replace(includesCall);
        changed = true;
      } else if (effectiveOp === "<") {
        // indexOf(x) < -1 is always false — skip, probably not what they meant
      }
    } else if (num === 0) {
      if (effectiveOp === ">=") {
        // indexOf(x) >= 0 → includes(x)
        path.replace(includesCall);
        changed = true;
      } else if (effectiveOp === "<") {
        // indexOf(x) < 0 → !includes(x)
        path.replace(j.unaryExpression("!", includesCall));
        changed = true;
      }
    }
  });

  if (!changed) return;

  return root.toSource({
    quote: "double",
    trailingComma: true,
    tabWidth: 2,
  });
};
