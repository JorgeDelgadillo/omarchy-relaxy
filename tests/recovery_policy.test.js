const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const policyModule = { exports: {} };
const policySource = fs.readFileSync(path.join(__dirname, "../ui/RecoveryPolicy.js"), "utf8")
  .replace(/^\.pragma library\s*/, "");
new Function("module", "exports", policySource)(policyModule, policyModule.exports);
const RecoveryPolicy = policyModule.exports;

function testProgressiveRetriesAreCappedAndFinite() {
  const policy = RecoveryPolicy.create();
  assert.equal(policy.retryLimit, 5);
  assert.deepEqual(Array.from({ length: 5 }, () => policy.failure()).map((decision) => [decision.shouldRetry, decision.delayMs, decision.attempt]), [
    [true, 1000, 1],
    [true, 2000, 2],
    [true, 4000, 3],
    [true, 8000, 4],
    [true, 15000, 5],
  ]);
  assert.deepEqual(policy.failure(), {
    state: "unavailable",
    shouldRetry: false,
    delayMs: 0,
    attempt: 5,
    retryLimit: 5,
  });
}

function testStableRuntimeResetsRetryBudget() {
  const policy = RecoveryPolicy.create();
  policy.failure();
  policy.failure();
  policy.markStable();
  assert.equal(policy.failure().attempt, 1);
}

function testManualRetryRestartsTheBudgetImmediately() {
  const policy = RecoveryPolicy.create();
  for (let i = 0; i < 6; i += 1) policy.failure();
  assert.deepEqual(policy.manualRetry(), {
    state: "starting",
    shouldRetry: true,
    delayMs: 0,
    attempt: 0,
    retryLimit: 5,
  });
  assert.equal(policy.failure().attempt, 1);
}

function testIntentionalUnloadCancelsRecovery() {
  const policy = RecoveryPolicy.create();
  policy.failure();
  policy.cancel();
  assert.deepEqual(policy.failure(), {
    state: "stopped",
    shouldRetry: false,
    delayMs: 0,
    attempt: 1,
    retryLimit: 5,
  });
}

testProgressiveRetriesAreCappedAndFinite();
testStableRuntimeResetsRetryBudget();
testManualRetryRestartsTheBudgetImmediately();
testIntentionalUnloadCancelsRecovery();
console.log("Recovery policy behavior tests passed.");
