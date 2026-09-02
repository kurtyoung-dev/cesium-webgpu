"use strict";

function escapeCharacters(token) {
  return token.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}

function constructRegex(pragma) {
  const prefix = "include";
  pragma = escapeCharacters(pragma);

  const s =
    "[\\t ]*\\/\\/>>\\s?" +
    prefix +
    "Start\\s?\\(\\s?([\"'])" +
    pragma +
    "\\1\\s?,\\s?pragmas\\." +
    pragma +
    "\\s?\\)\\s?;?" +
    // multiline code block
    "[\\s\\S]*?" +
    // end comment
    "[\\t ]*\\/\\/>>\\s?" +
    prefix +
    "End\\s?\\(\\s?([\"'])" +
    pragma +
    "\\2\\s?\\)\\s?;?\\s?[\\t]*\\n?";

  return new RegExp(s, "gm");
}

module.exports.constructRegex = constructRegex;
module.exports.escapeCharacters = escapeCharacters;
