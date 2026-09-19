// A worker whose module evaluation fails, so the browser fires `error` at the
// Worker and no message is ever delivered. The file is served like every other
// test worker; a missing URL cannot stand in for it, because a request the
// browser has in flight as a worker script is one karma's server never answers.
throw new Error("This worker throws while loading.");
