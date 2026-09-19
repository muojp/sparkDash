/**
 * The LLM-monitoring gate. A `worker` has no API of its own under tensor parallelism, but a
 * single-node recipe can be run as one server per node — and then the worker serves too.
 */
import test from "node:test";
import assert from "node:assert";
import { SparkMonitor } from "../SparkMonitor.js";

const gate = (spark) => SparkMonitor.prototype._llmMonitoringEnabled.call({ spark }, spark);

test("an explicit llmMonitoring flag outranks the role", () => {
  assert.equal(gate({ id: "a", role: "worker", workerNode: true, llmMonitoring: true }), true);
  assert.equal(gate({ id: "b", role: "head", llmMonitoring: false }), false);
});

test("without a flag the role still decides", () => {
  assert.equal(gate({ id: "c", role: "worker", workerNode: true }), false);
  assert.equal(gate({ id: "d", role: "head" }), true);
  assert.equal(gate({ id: "e", role: "standalone" }), true);
});

test("workerNode implies the worker role when none is given", () => {
  assert.equal(gate({ id: "f", workerNode: true }), false);
});
