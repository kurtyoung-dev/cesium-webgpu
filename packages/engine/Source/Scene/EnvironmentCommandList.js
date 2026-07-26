/**
 * Canonicalize the two background environment commands at the front of an
 * existing active command range without allocating. Repeated execution of the
 * same frustum list (notably the two WebVR eyes) is idempotent: an already
 * canonical list returns immediately, while legacy dual-published identities
 * are compacted to one command each.
 *
 * @param {object[]} commands
 * @param {number} length
 * @param {object|undefined} skyBoxCommand
 * @param {object|undefined} starFieldCommand
 * @returns {number}
 * @private
 */
function prependUniqueEnvironmentCommands(
  commands,
  length,
  skyBoxCommand,
  starFieldCommand,
) {
  const hasSkyBoxCommand = typeof skyBoxCommand?.execute === "function";
  const hasStarFieldCommand =
    typeof starFieldCommand?.execute === "function" &&
    starFieldCommand !== skyBoxCommand;
  const backgroundCount =
    (hasSkyBoxCommand ? 1 : 0) + (hasStarFieldCommand ? 1 : 0);
  if (backgroundCount === 0) {
    return length;
  }

  let canonical = length >= backgroundCount;
  let expectedIndex = 0;
  if (hasSkyBoxCommand) {
    canonical = canonical && commands[expectedIndex++] === skyBoxCommand;
  }
  if (hasStarFieldCommand) {
    canonical = canonical && commands[expectedIndex] === starFieldCommand;
  }
  if (canonical) {
    for (let i = backgroundCount; i < length; i++) {
      const command = commands[i];
      if (command === skyBoxCommand || command === starFieldCommand) {
        canonical = false;
        break;
      }
    }
    if (canonical) {
      return length;
    }
  }

  // Remove every existing copy in one stable compaction pass. This handles
  // both a repeated stereo invocation and legacy feature renderers that
  // published the same command through the binned and returned routes.
  let compactedLength = 0;
  for (let i = 0; i < length; i++) {
    const command = commands[i];
    if (
      (hasSkyBoxCommand && command === skyBoxCommand) ||
      (hasStarFieldCommand && command === starFieldCommand)
    ) {
      continue;
    }
    commands[compactedLength++] = command;
  }

  for (let i = compactedLength - 1; i >= 0; i--) {
    commands[i + backgroundCount] = commands[i];
  }
  let backgroundIndex = 0;
  if (hasSkyBoxCommand) {
    commands[backgroundIndex++] = skyBoxCommand;
  }
  if (hasStarFieldCommand) {
    commands[backgroundIndex] = starFieldCommand;
  }
  return compactedLength + backgroundCount;
}

export { prependUniqueEnvironmentCommands };
export default prependUniqueEnvironmentCommands;
