import TaskProcessor from "../../Core/TaskProcessor.js";

let processor: TaskProcessor | undefined;
let unavailable = false;

export async function scheduleWeatherTask<T>(
  parameters: object,
): Promise<T | undefined> {
  if (
    unavailable ||
    typeof window === "undefined" ||
    typeof Worker === "undefined"
  ) {
    return undefined;
  }
  try {
    processor ??= new TaskProcessor("createCloudWeather", 1);
    const task = processor.scheduleTask(parameters);
    if (task) {
      return (await task) as T;
    }
  } catch (error) {
    // A failed worker must not disable weather in restricted browsing contexts.
    unavailable = true;
    processor?.destroy();
    processor = undefined;
    //>>includeStart('debug', pragmas.debug);
    console.warn(
      "Cloud weather worker unavailable; using cooperative preparation.",
      error,
    );
    //>>includeEnd('debug');
  }
  return undefined;
}
