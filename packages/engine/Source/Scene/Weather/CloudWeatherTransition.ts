import JulianDate from "../../Core/JulianDate.js";
import type {
  PackedWeatherPublication,
  PackedWeatherSnapshot,
} from "./WeatherProvider.js";

export interface CloudWeatherTransition {
  readonly previous: PackedWeatherSnapshot | null;
  readonly weight: number;
  readonly active: boolean;
}
const complete: CloudWeatherTransition = Object.freeze({
  previous: null,
  weight: 1,
  active: false,
});
const epochs = new WeakMap<PackedWeatherSnapshot, JulianDate>();

export function resolveCloudWeatherTransition(
  publication: PackedWeatherPublication | null,
  time: { dayNumber: number; secondsOfDay: number } | undefined,
  enabled: boolean,
  durationSeconds = 30,
): CloudWeatherTransition {
  const current = publication?.current,
    previous = publication?.previous;
  if (
    !enabled ||
    !current ||
    !previous ||
    !time ||
    !Number.isFinite(time.dayNumber) ||
    !Number.isFinite(time.secondsOfDay) ||
    !Number.isFinite(current.timeMs) ||
    !Number.isFinite(previous.timeMs) ||
    current.width !== previous.width ||
    current.height !== previous.height
  ) {
    return complete;
  }
  const interval = (current.timeMs! - previous.timeMs!) / 1000;
  if (!(interval > 0)) {
    return complete;
  }
  let epoch = epochs.get(current);
  if (!epoch) {
    epoch = JulianDate.fromDate(new Date(current.timeMs!));
    epochs.set(current, epoch);
  }
  const elapsed =
    (time.dayNumber - epoch.dayNumber) * 86400 +
    time.secondsOfDay -
    epoch.secondsOfDay;
  const duration = Math.min(
    interval,
    Number.isFinite(durationSeconds)
      ? Math.max(1, Math.min(300, durationSeconds))
      : 30,
  );
  if (elapsed < 0 || elapsed >= duration) {
    return complete;
  }
  const fraction = elapsed / duration;
  return {
    previous,
    weight: fraction * fraction * (3 - 2 * fraction),
    active: true,
  };
}
