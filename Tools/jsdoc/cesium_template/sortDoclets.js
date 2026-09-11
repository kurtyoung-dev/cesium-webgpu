"use strict";

/*
 * The logical comparison behavior in this file is derived from TaffyDB 2.6.2.
 * Software License Agreement (BSD License), http://taffydb.com
 * Copyright (c). All rights reserved.
 *
 * Redistribution and use of this software in source and binary forms, with or
 * without modification, are permitted provided that redistributions of source
 * code retain the above copyright notice, this list of conditions, and the
 * following disclaimer.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

function splitLogical(value) {
  const input = String(value);
  const parts = [];
  let isNumeric;
  let part = "";

  for (const character of input) {
    const code = character.charCodeAt(0);
    const characterIsNumeric = (code >= 48 && code <= 57) || code === 46;

    if (isNumeric !== undefined && characterIsNumeric !== isNumeric) {
      parts.push(isNumeric ? parseFloat(part) : part.toLowerCase());
      part = "";
    }

    isNumeric = characterIsNumeric;
    part += character;
  }

  if (isNumeric !== undefined) {
    parts.push(isNumeric ? parseFloat(part) : part.toLowerCase());
  }

  return parts;
}

function compareLogical(left, right) {
  const leftParts = splitLogical(left);
  const rightParts = splitLogical(right);
  const length = Math.min(leftParts.length, rightParts.length);

  for (let i = 0; i < length; i++) {
    if (leftParts[i] < rightParts[i]) {
      return -1;
    }
    if (leftParts[i] > rightParts[i]) {
      return 1;
    }
  }

  return leftParts.length - rightParts.length;
}

function sortDoclets(doclets) {
  const ordered = doclets.map(function (doclet, index) {
    return { doclet: doclet, index: index };
  });

  ordered.sort(function (left, right) {
    return (
      compareLogical(left.doclet.longname, right.doclet.longname) ||
      left.index - right.index
    );
  });

  ordered.forEach(function (item, index) {
    doclets[index] = item.doclet;
  });

  return doclets;
}

sortDoclets.compareLogical = compareLogical;
module.exports = sortDoclets;
