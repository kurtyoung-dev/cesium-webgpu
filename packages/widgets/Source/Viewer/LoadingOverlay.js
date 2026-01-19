import { DeveloperError } from "@cesium/engine";

/**
 * A loading overlay component that displays progress during WebGPU initialization.
 * Shows a semi-transparent overlay with a progress indicator and status text.
 *
 * @alias LoadingOverlay
 * @constructor
 *
 * @param {Element} container The DOM element that will contain the loading overlay.
 *
 * @private
 */
function LoadingOverlay(container) {
  //>>includeStart('debug', pragmas.debug);
  if (!container) {
    throw new DeveloperError("container is required.");
  }
  //>>includeEnd('debug');

  // Create overlay container
  const overlay = document.createElement("div");
  overlay.className = "cesium-loading-overlay";
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    font-family: sans-serif;
  `;

  // Create content container
  const content = document.createElement("div");
  content.className = "cesium-loading-content";
  content.style.cssText = `
    background-color: rgba(48, 51, 54, 0.95);
    border-radius: 8px;
    padding: 30px 40px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    text-align: center;
    min-width: 300px;
  `;

  // Create title
  const title = document.createElement("div");
  title.className = "cesium-loading-title";
  title.textContent = "Initializing WebGPU";
  title.style.cssText = `
    color: #ffffff;
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 20px;
  `;

  // Create status text
  const statusText = document.createElement("div");
  statusText.className = "cesium-loading-status";
  statusText.textContent = "Starting...";
  statusText.style.cssText = `
    color: #aaaaaa;
    font-size: 14px;
    margin-bottom: 15px;
    min-height: 20px;
  `;

  // Create progress bar container
  const progressContainer = document.createElement("div");
  progressContainer.className = "cesium-loading-progress-container";
  progressContainer.style.cssText = `
    width: 100%;
    height: 8px;
    background-color: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 15px;
  `;

  // Create progress bar
  const progressBar = document.createElement("div");
  progressBar.className = "cesium-loading-progress-bar";
  progressBar.style.cssText = `
    width: 0%;
    height: 100%;
    background: linear-gradient(90deg, #4A90E2, #67B7FF);
    border-radius: 4px;
    transition: width 0.3s ease;
  `;

  // Create percentage text
  const percentageText = document.createElement("div");
  percentageText.className = "cesium-loading-percentage";
  percentageText.textContent = "0%";
  percentageText.style.cssText = `
    color: #4A90E2;
    font-size: 14px;
    font-weight: 600;
  `;

  // Create error container (hidden by default)
  const errorContainer = document.createElement("div");
  errorContainer.className = "cesium-loading-error";
  errorContainer.style.cssText = `
    display: none;
    color: #ff6b6b;
    font-size: 13px;
    margin-top: 15px;
    padding: 10px;
    background-color: rgba(255, 107, 107, 0.1);
    border-radius: 4px;
    border: 1px solid rgba(255, 107, 107, 0.3);
  `;

  // Assemble the overlay
  progressContainer.appendChild(progressBar);
  content.appendChild(title);
  content.appendChild(statusText);
  content.appendChild(progressContainer);
  content.appendChild(percentageText);
  content.appendChild(errorContainer);
  overlay.appendChild(content);
  container.appendChild(overlay);

  // Store references
  this._container = container;
  this._overlay = overlay;
  this._statusText = statusText;
  this._progressBar = progressBar;
  this._percentageText = percentageText;
  this._errorContainer = errorContainer;
  this._visible = true;
}

/**
 * Updates the progress of the loading overlay.
 *
 * @param {number} progress The progress value (0-100).
 * @param {string} [status] Optional status text to display.
 */
LoadingOverlay.prototype.updateProgress = function (progress, status) {
  // Clamp progress between 0 and 100
  progress = Math.max(0, Math.min(100, progress));

  // Update progress bar
  this._progressBar.style.width = `${progress}%`;

  // Update percentage text
  this._percentageText.textContent = `${Math.round(progress)}%`;

  // Update status text if provided
  if (status) {
    this._statusText.textContent = status;
  }
};

/**
 * Displays an error message in the loading overlay.
 *
 * @param {string} errorMessage The error message to display.
 */
LoadingOverlay.prototype.showError = function (errorMessage) {
  this._errorContainer.textContent = errorMessage;
  this._errorContainer.style.display = "block";

  // Update title to indicate error
  this._overlay.querySelector(".cesium-loading-title").textContent =
    "Initialization Failed";
  this._overlay.querySelector(".cesium-loading-title").style.color = "#ff6b6b";

  // Change progress bar to red
  this._progressBar.style.background = "#ff6b6b";
};

/**
 * Removes the loading overlay from the DOM with a fade-out animation.
 *
 * @param {Function} [callback] Optional callback to execute after removal.
 */
LoadingOverlay.prototype.remove = function (callback) {
  if (!this._visible) {
    return;
  }

  this._visible = false;

  // Fade out animation
  this._overlay.style.transition = "opacity 0.3s ease";
  this._overlay.style.opacity = "0";

  // Remove from DOM after animation
  setTimeout(() => {
    if (this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    if (callback) {
      callback();
    }
  }, 300);
};

/**
 * Returns true if the loading overlay is currently visible.
 *
 * @returns {boolean} true if visible, false otherwise.
 */
LoadingOverlay.prototype.isVisible = function () {
  return this._visible;
};

/**
 * Destroys the loading overlay and removes it from the DOM.
 */
LoadingOverlay.prototype.destroy = function () {
  this.remove();
};

export default LoadingOverlay;
