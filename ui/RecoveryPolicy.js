.pragma library

var MAX_RETRIES = 5;
var INITIAL_DELAY_MS = 1000;
var MAX_DELAY_MS = 15000;
var STABLE_UPTIME_MS = 30000;

function create() {
  var attempt = 0;
  var cancelled = false;

  function failure() {
    if (cancelled) {
      return { state: "stopped", shouldRetry: false, delayMs: 0, attempt: attempt, retryLimit: MAX_RETRIES };
    }

    attempt += 1;
    if (attempt > MAX_RETRIES) {
      attempt = MAX_RETRIES;
      return { state: "unavailable", shouldRetry: false, delayMs: 0, attempt: attempt, retryLimit: MAX_RETRIES };
    }

    var delayMs = Math.min(INITIAL_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
    return { state: "restarting", shouldRetry: true, delayMs: delayMs, attempt: attempt, retryLimit: MAX_RETRIES };
  }

  function markStable() {
    attempt = 0;
  }

  function manualRetry() {
    attempt = 0;
    cancelled = false;
    return { state: "starting", shouldRetry: true, delayMs: 0, attempt: 0, retryLimit: MAX_RETRIES };
  }

  function cancel() {
    cancelled = true;
  }

  return {
    retryLimit: MAX_RETRIES,
    failure: failure,
    markStable: markStable,
    manualRetry: manualRetry,
    cancel: cancel,
  };
}

if (typeof module !== "undefined") module.exports = {
  create: create,
  MAX_RETRIES: MAX_RETRIES,
  INITIAL_DELAY_MS: INITIAL_DELAY_MS,
  MAX_DELAY_MS: MAX_DELAY_MS,
  STABLE_UPTIME_MS: STABLE_UPTIME_MS,
};
