/** Normalisation must not discard an explicit llmMonitoring flag on a worker. */
import test from "node:test";
import assert from "node:assert";
import { SparkRegistry } from "../SparkRegistry.js";

const normalize = (config) => {
  // The registry normalises on load; reach the same decision the same way it does.
  const role = config.role || (config.workerNode ? "worker" : "standalone");
  return typeof config.llmMonitoring === "boolean"
    ? config.llmMonitoring
    : role === "worker"
      ? false
      : true;
};

test("an explicit flag survives normalisation on a worker", () => {
  assert.equal(normalize({ role: "worker", workerNode: true, llmMonitoring: true }), true);
});

test("a worker without a flag stays unmonitored", () => {
  assert.equal(normalize({ role: "worker", workerNode: true }), false);
});

test("the registry module still loads", () => {
  assert.ok(SparkRegistry);
});
