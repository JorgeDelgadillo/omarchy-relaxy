const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const queueModule = { exports: {} };
const queueSource = fs.readFileSync(path.join(__dirname, "../ui/CommandQueue.js"), "utf8")
  .replace(/^\.pragma library\s*/, "");
new Function("module", "exports", queueSource)(queueModule, queueModule.exports);
const CommandQueue = queueModule.exports;

function makeQueue() {
  const dispatched = [];
  const settled = [];
  const queue = CommandQueue.create(
    (request) => dispatched.push(request),
    (request, response) => settled.push({ request, response }),
  );
  return { queue, dispatched, settled };
}

function finishNext(state, response) {
  const request = state.dispatched[state.dispatched.length - 1];
  assert.ok(request, "expected a request to be dispatched");
  assert.equal(state.queue.complete(request.id, response || { id: request.id, ok: true }), true);
  return request;
}

function testMixedActionsStayOrdered() {
  const state = makeQueue();
  state.queue.enqueue("toggle-playing", {});
  state.queue.enqueue("set-master-volume", { volume: 0.2 }, { volumeTarget: "master" });
  state.queue.enqueue("reset-volumes", {});
  state.queue.enqueue("toggle-sound", { soundId: "rain", playing: true });

  finishNext(state);
  finishNext(state);
  finishNext(state);
  finishNext(state);
  assert.deepEqual(state.dispatched.map((request) => request.action), [
    "toggle-playing", "set-master-volume", "reset-volumes", "toggle-sound",
  ]);
}

function testSameTargetVolumesCoalesceWithinPendingSegment() {
  const state = makeQueue();
  state.queue.enqueue("toggle-playing", {});
  state.queue.enqueue("set-sound-volume", { soundId: "rain", volume: 0.1 }, { volumeTarget: "sound:rain" });
  state.queue.enqueue("set-sound-volume", { soundId: "wind", volume: 0.3 }, { volumeTarget: "sound:wind" });
  state.queue.enqueue("set-sound-volume", { soundId: "rain", volume: 0.8 }, { volumeTarget: "sound:rain" });

  finishNext(state);
  finishNext(state);
  finishNext(state);
  assert.deepEqual(state.dispatched.map((request) => request.payload), [
    {}, { soundId: "rain", volume: 0.8 }, { soundId: "wind", volume: 0.3 },
  ]);
}

function testDiscreteActionsAreOrderingBarriers() {
  const state = makeQueue();
  state.queue.enqueue("toggle-playing", {});
  state.queue.enqueue("set-master-volume", { volume: 0.2 }, { volumeTarget: "master" });
  state.queue.enqueue("set-preset", { presetId: "focus" });
  state.queue.enqueue("set-master-volume", { volume: 0.7 }, { volumeTarget: "master" });

  finishNext(state);
  finishNext(state);
  finishNext(state);
  finishNext(state);
  assert.deepEqual(state.dispatched.map((request) => [request.action, request.payload.volume]), [
    ["toggle-playing", undefined], ["set-master-volume", 0.2],
    ["set-preset", undefined], ["set-master-volume", 0.7],
  ]);
}

function testFailureForOlderRequestDoesNotClearNewerOptimisticValue() {
  const optimistic = {};
  const settled = [];
  const dispatched = [];
  const queue = CommandQueue.create(
    (request) => dispatched.push(request),
    (request, response) => {
      settled.push({ request, response });
      if (request.volumeTarget && optimistic[request.volumeTarget]?.id === request.id && !response?.ok) {
        delete optimistic[request.volumeTarget];
      }
    },
  );

  const oldId = queue.enqueue("set-sound-volume", { soundId: "rain", volume: 0.2 }, { volumeTarget: "sound:rain" });
  optimistic["sound:rain"] = { id: oldId, value: 0.2 };
  const newId = queue.enqueue("set-sound-volume", { soundId: "rain", volume: 0.9 }, { volumeTarget: "sound:rain" });
  optimistic["sound:rain"] = { id: newId, value: 0.9 };

  assert.equal(queue.complete(oldId, { id: oldId, ok: false }), true);
  assert.deepEqual(optimistic["sound:rain"], { id: newId, value: 0.9 });
  assert.equal(dispatched[1].id, newId);
  queue.complete(newId, { id: newId, ok: true });
  assert.equal(settled.length, 2);
}

function testRequestIdsAreUniqueAndStaleResponsesAreIgnored() {
  const state = makeQueue();
  state.queue.enqueue("toggle-playing", {});
  const first = state.dispatched[0];
  state.queue.enqueue("toggle-sound", { soundId: "rain", playing: true });
  assert.equal(state.queue.complete(first.id, { id: "stale-id", ok: true }), true);
  const ids = state.dispatched.map((request) => request.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(state.settled[0].response, null);
  assert.equal(state.dispatched[1].action, "toggle-sound");
}

function testCommandFailuresAreActionable() {
  assert.match(CommandQueue.failureMessage({ id: "request-1", ok: false, error: "Preset name is already in use" }, 0, "request-1"), /already in use/);
  assert.match(CommandQueue.failureMessage(null, 0, "request-1"), /valid response/i);
  assert.match(CommandQueue.failureMessage(null, 1, "request-1"), /exited with code 1/i);
  assert.match(CommandQueue.failureMessage({ id: "request-1", ok: false }, 0, "request-1"), /Try again/i);
  assert.match(CommandQueue.failureMessage({ id: "stale", ok: true }, 0, "request-1"), /valid response/i);
  assert.equal(CommandQueue.failureMessage({ id: "request-1", ok: true }, 0, "request-1"), "");
}

function testEditorSubmissionKeepsDraftUntilMatchingSuccess() {
  const editor = CommandQueue.createEditorSubmission();
  const draft = "Rain at night";
  assert.equal(editor.begin("request-1", draft), true);
  assert.equal(editor.begin("request-2"), false, "duplicate submits are blocked while pending");
  assert.equal(editor.isPending(), true);
  assert.equal(editor.draft(), draft);
  assert.equal(editor.settle("stale-request", false), null);
  assert.equal(editor.settle("request-1", false), "retry");
  assert.equal(editor.draft(), draft, "a failed save must not clear the editor draft");
  assert.equal(editor.isPending(), false);
  assert.equal(editor.begin("request-2", editor.draft()), true, "a failed save can be retried");
  assert.equal(editor.settle("request-2", true), "saved");
  assert.equal(editor.isPending(), false);
  assert.equal(editor.draft(), "", "a successful save clears the completed draft");
}

testMixedActionsStayOrdered();
testSameTargetVolumesCoalesceWithinPendingSegment();
testDiscreteActionsAreOrderingBarriers();
testFailureForOlderRequestDoesNotClearNewerOptimisticValue();
testRequestIdsAreUniqueAndStaleResponsesAreIgnored();
testCommandFailuresAreActionable();
testEditorSubmissionKeepsDraftUntilMatchingSuccess();
console.log("Command queue behavior tests passed.");
