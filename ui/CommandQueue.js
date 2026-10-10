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

if (typeof module !== "undefined") module.exports = { create: create };
