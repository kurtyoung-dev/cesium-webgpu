// console-gate.mjs — the one rule that decides whether a browser console error
// belongs to this fork or to somebody else's server. Pure Node: no browser, no
// network, no GPU.
// @purpose Host-keyed predicate deciding whether a browser console error belongs to this fork (fatal) or to a third-party tile service (ignorable).
// @status ACTIVE
//
// WHY THIS IS A MODULE. It is a predicate that silences errors, which is the
// most dangerous shape of code in a verification harness: every mistake in it
// is invisible by construction. Stated here, it is testable against the exact
// message strings a real run produced, rather than by reading the regex in the
// producer and believing it.
//
// WHAT IT IS FOR. Several fork demos layer public tile services — the
// multi-layer imagery demo alone names five. Those hosts answer with whatever
// they answer with: a 404, a rate limit, a CORS refusal. None of it is a
// statement about this renderer, and no capture run can fix it. What the run IS
// responsible for is everything served from its own base URL, and that stays
// fatal — including a 404, which is how a missing tileset, model or bundle
// announces itself.
//
// WHY THE HOST AND NOT THE MESSAGE. Chromium reports a failed fetch as
// "Failed to load resource: the server responded with a status of 404 (Not
// Found)" with the URL only in the message's LOCATION, and a CORS refusal as
// "Access to XMLHttpRequest at 'https://…' … blocked by CORS policy" with the
// URL only in the TEXT. A rule keyed on wording gets one of the two wrong; a
// rule keyed on the host gets both right, and cannot be widened by accident
// into "ignore 404s".

/** Console-error shapes that describe a network fetch rather than a fault. */
export const NETWORK_ERROR_PATTERNS = Object.freeze([
  /Failed to load resource/i,
  /blocked by CORS policy/i,
  /net::ERR_/,
]);

const URL_IN_TEXT = /https?:\/\/[^\s'")]+/g;

/**
 * The URL a network-error message is ABOUT.
 *
 * Message order is what disambiguates, and it is stable in Chromium: the
 * requested resource comes first, and any other URL in the sentence is context
 * — a CORS refusal reads "Access to XMLHttpRequest at '<resource>' from origin
 * '<page>'", and taking the page URL as the subject would make every CORS error
 * look like this fork's own. When the text names nothing, the message's
 * location is the subject, which is the shape a plain "Failed to load resource"
 * takes.
 *
 * @param {string} text The console message text.
 * @param {string} [locationUrl] The message's location URL.
 * @returns {string|null} The URL the failure is about, or null.
 */
export function networkFailureSubject(text, locationUrl) {
  const inText = typeof text === "string" ? text.match(URL_IN_TEXT) : null;
  if (inText !== null && inText.length > 0) {
    return inText[0];
  }
  if (typeof locationUrl === "string" && locationUrl.length > 0) {
    return locationUrl;
  }
  return null;
}

/**
 * Is this console error a network failure at a host the run does not serve?
 *
 * @param {string} text The console message text.
 * @param {string} [locationUrl] The message's location URL, when Chromium gives one.
 * @param {string} base The run's own origin; anything under it stays fatal.
 * @returns {boolean} True only when the failing resource is on a foreign host.
 */
export function isForeignNetworkFailure(text, locationUrl, base) {
  if (
    typeof text !== "string" ||
    !NETWORK_ERROR_PATTERNS.some((re) => re.test(text))
  ) {
    return false;
  }
  const subject = networkFailureSubject(text, locationUrl);
  if (subject === null) {
    // A network error that names nothing cannot be shown to be somebody else's.
    return false;
  }
  return !subject.startsWith(base);
}
