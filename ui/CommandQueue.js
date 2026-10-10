.pragma library

var requestSequence = 0;

function create(dispatch, settle) {
  var pending = [];
  var active = null;

  function dispatchNext() {
    if (active || pending.length === 0) return;
    active = pending.shift();
    dispatch(active);
  }

  function enqueue(action, payload, options) {
    requestSequence += 1;
    var request = {
      id: Date.now().toString(36) + "-" + requestSequence.toString(36),
      action: action,
      payload: payload || {},
      volumeTarget: options && options.volumeTarget ? options.volumeTarget : "",
    };

    if (request.volumeTarget) {
      for (var index = pending.length - 1; index >= 0; index -= 1) {
        var queued = pending[index];
        if (!queued.volumeTarget) break;
        if (queued.volumeTarget === request.volumeTarget) {
          pending[index] = request;
          return request.id;
        }
      }
    }

    pending.push(request);
    dispatchNext();
    return request.id;
  }

  function complete(requestId, response) {
    if (!active || active.id !== requestId) return false;
    var acceptedResponse = response && response.id === requestId ? response : null;
    var completed = active;
    active = null;
    settle(completed, acceptedResponse);
    dispatchNext();
    return true;
  }

  return {
    enqueue: enqueue,
    complete: complete,
  };
}

function failureMessage(response, exitCode, requestId) {
  if (exitCode !== 0) {
    return "Relaxy could not complete this action because the command process exited with code " + exitCode + ". Try again.";
  }
  if (!response || response.id !== requestId || typeof response.ok !== "boolean") {
    return "Relaxy did not receive a valid response for this action. Try again.";
  }
  if (response.ok) return "";

  var detail = response.error;
  if (detail && typeof detail === "object") detail = detail.message;
  detail = typeof detail === "string" ? detail.trim() : "";
  return detail || "Relaxy could not complete this action. Try again.";
}

function createEditorSubmission() {
  var pendingRequestId = "";
  var draft = "";
  return {
    begin: function(requestId, text) {
      if (pendingRequestId || !requestId) return false;
      pendingRequestId = requestId;
      draft = String(text || "");
      return true;
    },
    settle: function(requestId, succeeded) {
      if (!pendingRequestId || pendingRequestId !== requestId) return null;
      pendingRequestId = "";
      if (succeeded) draft = "";
      return succeeded ? "saved" : "retry";
    },
    setDraft: function(text) {
      if (!pendingRequestId) draft = String(text || "");
    },
    draft: function() { return draft; },
    isPending: function() { return pendingRequestId !== ""; },
  };
}

if (typeof module !== "undefined") module.exports = {
  create: create,
  createEditorSubmission: createEditorSubmission,
  failureMessage: failureMessage,
};
