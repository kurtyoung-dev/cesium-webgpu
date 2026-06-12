import Check from "./Check.js";
import defined from "./defined.js";

// Lazy DOMPurify — adds ~80 KB minified / ~22 KB gz and is only used by the
// credit display. Start the dynamic import at module-load time so esbuild
// pulls it into a separate chunk, and the download overlaps whatever the
// caller does before first credit render. A closure variable caches the
// module once it arrives so the sync `element` getter can hit it without
// awaiting. On the rare early-render path (first credit read resolves
// before DOMPurify finishes loading) we fall back to plain-text content
// — strictly safer than raw-innerHTML unsanitized input, and credits
// refresh on next display cycle once the lib lands.
let _DOMPurify = null;
const _DOMPurifyPromise = import("dompurify").then((mod) => {
  _DOMPurify = mod.default ?? mod;
  return _DOMPurify;
});

let nextCreditId = 0;
const creditToId = {};

/**
 * A credit contains data pertaining to how to display attributions/credits for certain content on the screen.
 * @param {string} html An string representing an html code snippet
 * @param {boolean} [showOnScreen=false] If true, the credit will be visible in the main credit container.  Otherwise, it will appear in a popover. All credits are displayed `inline`, if you have an image we recommend sizing it correctly to match the text or use css to `vertical-align` it.
 *
 * @alias Credit
 * @constructor
 *
 * @exception {DeveloperError} html is required.
 *
 * @example
 * // Create a credit with a tooltip, image and link
 * const credit = new Cesium.Credit('<a href="https://cesium.com/" target="_blank"><img src="/images/cesium_logo.png"  style="vertical-align: -7px" title="Cesium"/></a>');
 */
class Credit {
  constructor(html, showOnScreen) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.string("html", html);
    //>>includeEnd('debug');
    let id;
    const key = html;

    if (defined(creditToId[key])) {
      id = creditToId[key];
    } else {
      id = nextCreditId++;
      creditToId[key] = id;
    }

    showOnScreen = showOnScreen ?? false;

    // Credits are immutable so generate an id to use to optimize equal()
    this._id = id;
    this._html = html;
    this._showOnScreen = showOnScreen;
    this._element = undefined;
  }

  /**
   * Returns true if the credits are equal
   *
   * @param {Credit} [credit] The credit to compare to.
   * @returns {boolean} <code>true</code> if left and right are equal, <code>false</code> otherwise.
   */
  equals(credit) {
    return Credit.equals(this, credit);
  }

  /**
   * @private
   */
  isIon() {
    return this.html.includes("ion-credit.png");
  }

  /**
   * The credit content
   * @type {string}
   * @readonly
   */
  get html() {
    return this._html;
  }

  /**
   * @type {number}
   * @readonly
   *
   * @private
   */
  get id() {
    return this._id;
  }

  /**
   * Whether the credit should be displayed on screen or in a lightbox
   * @type {boolean}
   */
  get showOnScreen() {
    return this._showOnScreen;
  }

  set showOnScreen(value) {
    this._showOnScreen = value;
  }

  /**
   * Gets the credit element
   * @type {HTMLElement}
   * @readonly
   */
  get element() {
    if (!defined(this._element)) {
      const div = document.createElement("div");
      div.className = "cesium-credit-wrapper";
      div._creditId = this._id;
      div.style.display = "inline";

      if (_DOMPurify) {
        // Hot path: library loaded, sanitize and use innerHTML as before.
        div.innerHTML = _DOMPurify.sanitize(this._html);
        const links = div.querySelectorAll("a");
        for (let i = 0; i < links.length; i++) {
          links[i].setAttribute("target", "_blank");
        }
      } else {
        // Cold path: DOMPurify hasn't resolved yet. Render as plain text
        // (safe under any hostile input) and schedule a re-sanitize when
        // the library lands. The displayed element is the same DOM node,
        // so the credit display updates in place with no flicker.
        div.textContent = this._html;
        _DOMPurifyPromise.then((dp) => {
          div.innerHTML = dp.sanitize(this._html);
          const links = div.querySelectorAll("a");
          for (let i = 0; i < links.length; i++) {
            links[i].setAttribute("target", "_blank");
          }
        });
      }

      this._element = div;
    }
    return this._element;
  }
}

/**
 * Returns true if the credits are equal
 *
 * @param {Credit} [left] The first credit
 * @param {Credit} [right] The second credit
 * @returns {boolean} <code>true</code> if left and right are equal, <code>false</code> otherwise.
 */
Credit.equals = function (left, right) {
  return (
    left === right ||
    (defined(left) &&
      defined(right) &&
      left._id === right._id &&
      left._showOnScreen === right._showOnScreen)
  );
};

/**
 * @private
 * @param attribution
 * @return {Credit}
 */
Credit.getIonCredit = function (attribution) {
  const showOnScreen =
    defined(attribution.collapsible) && !attribution.collapsible;
  const credit = new Credit(attribution.html, showOnScreen);

  return credit;
};

/**
 * Duplicates a Credit instance.
 *
 * @param {Credit} [credit] The Credit to duplicate.
 * @returns {Credit} A new Credit instance that is a duplicate of the one provided. (Returns undefined if the credit is undefined)
 */
Credit.clone = function (credit) {
  if (defined(credit)) {
    return new Credit(credit.html, credit.showOnScreen);
  }
};
export default Credit;
