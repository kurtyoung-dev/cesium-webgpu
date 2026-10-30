import JulianDate from "../Core/JulianDate.js";
import { WeatherProvider } from "./Weather/WeatherProvider.js";
import { SynopticWeatherSource } from "./Weather/SynopticWeatherSource.js";

export default class CloudWeatherState {
  constructor() {
    this._provider = undefined;
    this._owned = undefined;
    this._seed = undefined;
    this._removeChanged = undefined;
    this._frameState = undefined;
    this._time = undefined;
    this._timeMs = undefined;
  }

  get provider() {
    return this._provider;
  }

  update(config, frameState) {
    let provider = config.weatherProvider;
    if (!provider && config.cloudWeatherMap === true) {
      const seed = config.cloudWeatherSeed ?? 1;
      if (!this._owned || seed !== this._seed) {
        this._unbind();
        this._owned?.setSource(null);
        this._owned = new WeatherProvider(new SynopticWeatherSource(seed));
        this._owned.setQuantizeHours(1 / 6);
        this._owned.setTimeMode("scene");
        this._seed = seed;
      }
      provider = this._owned;
    } else if (this._owned) {
      this._unbind();
      this._owned.setSource(null);
      this._owned = undefined;
      this._seed = undefined;
    }
    this._bind(provider, frameState);
    const time = frameState.time;
    if (
      provider?.getTimeMode?.() !== "scene" ||
      !time ||
      !Number.isFinite(time.dayNumber) ||
      !Number.isFinite(time.secondsOfDay)
    ) {
      return;
    }
    if (!JulianDate.equals(this._time, time)) {
      this._time = JulianDate.clone(time, this._time);
      this._timeMs = JulianDate.toDate(time).getTime();
    }
    provider.tickSceneTime(this._timeMs);
  }

  _bind(provider, frameState) {
    if (this._provider === provider && this._frameState === frameState) {
      return;
    }
    this._unbind();
    this._provider = provider;
    this._frameState = frameState;
    if (!provider?.changed?.addEventListener || !frameState.afterRender) {
      return;
    }
    let pending = false;
    this._removeChanged = provider.changed.addEventListener(() => {
      if (pending) {
        return;
      }
      pending = true;
      // The scene drains these callbacks even when a requested draw was skipped.
      frameState.afterRender.push(() => {
        pending = false;
        return this._provider === provider && this._frameState === frameState;
      });
    });
  }

  _unbind() {
    this._removeChanged?.();
    this._removeChanged = undefined;
    this._provider = undefined;
    this._frameState = undefined;
  }

  destroy() {
    this._unbind();
    this._owned?.setSource(null);
    this._owned = undefined;
    this._seed = undefined;
    this._time = undefined;
    this._timeMs = undefined;
  }
}
