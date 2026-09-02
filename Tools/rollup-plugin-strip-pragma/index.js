"use strict";

const MagicString = require("magic-string");
const { createFilter } = require("rollup-pluginutils");
const { constructRegex } = require("./regex.js");

function stripPragma(options = {}) {
  const filter = createFilter(options.include, options.exclude);
  const patterns = options.pragmas.map((pragma) => constructRegex(pragma));

  return {
    name: "replace",

    // code: The contents of the file
    // id: the file path
    transform(code, id) {
      // Filters out includes and excluded files
      if (!filter(id)) {
        return null;
      }

      const magicString = new MagicString(code);

      let match;
      let start;
      let end;

      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        while ((match = pattern.exec(code))) {
          start = match.index;
          end = start + match[0].length;
          magicString.overwrite(start, end, "");
        }
      }

      const result = { code: magicString.toString() };
      return result;
    },
  };
}

module.exports = stripPragma;
