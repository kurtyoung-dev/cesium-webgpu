import knockout from "../ThirdParty/knockout.js";
import createCommand from "../createCommand.js";

/**
 * The view model for {@link NavigationHelpButton}.
 * @alias NavigationHelpButtonViewModel
 * @constructor
 */
class NavigationHelpButtonViewModel {
  constructor() {
    /**
     * Gets or sets whether the instructions are currently shown.  This property is observable.
     * @type {boolean}
     * @default false
     */
    this.showInstructions = false;

    const that = this;
    this._command = createCommand(function () {
      that.showInstructions = !that.showInstructions;
    });
    this._showClick = createCommand(function () {
      that._touch = false;
    });
    this._showTouch = createCommand(function () {
      that._touch = true;
    });

    this._touch = false;

    /**
     * Gets or sets the tooltip.  This property is observable.
     *
     * @type {string}
     */
    this.tooltip = "Navigation Instructions";

    knockout.track(this, ["tooltip", "showInstructions", "_touch"]);
  }

  /**
   * Gets the Command that is executed when the button is clicked.
   *
   * @type {Command}
   */
  get command() {
    return this._command;
  }

  /**
   * Gets the Command that is executed when the mouse instructions should be shown.
   *
   * @type {Command}
   */
  get showClick() {
    return this._showClick;
  }

  /**
   * Gets the Command that is executed when the touch instructions should be shown.
   *
   * @type {Command}
   */
  get showTouch() {
    return this._showTouch;
  }
}

export default NavigationHelpButtonViewModel;
