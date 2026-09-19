// A second worker whose module evaluation fails, so a spec exercising the web
// assembly init path requests its own script rather than sharing one URL with
// the task-path spec and leaving a single request to account for two workers.
throw new Error("This worker throws while loading its web assembly module.");
