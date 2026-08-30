import test from "node:test";
import assert from "node:assert/strict";
import { TokenTraceManager, machineView, resolveTokenTracePair } from "../TokenTraceManager.js";

const sparks = [
  { id: "dgx01", name: "head", role: "head", isLocal: true, ssh: { host: "dgx01" } },
  { id: "dgx02", name: "worker", role: "worker", workerHeadId: "dgx01", ssh: { host: "dgx02" } },
];

test("resolveTokenTracePair follows sparkDash roles and workerHeadId", () => {
  const result = resolveTokenTracePair(sparks);
  assert.equal(result.pair.head.id, "dgx01");
  assert.equal(result.pair.worker.id, "dgx02");
  assert.equal(result.reason, null);
});

test("resolveTokenTracePair refuses ambiguous mappings", () => {
  const result = resolveTokenTracePair([...sparks, { ...sparks[1], id: "dgx03" }]);
  assert.equal(result.pair, null);
  assert.match(result.reason, /expected one worker/);
});

test("resolveTokenTracePair infers a legacy standalone head from workerHeadId", () => {
  const legacy = sparks.map((spark) => spark.id === "dgx01" ? { ...spark, role: "standalone" } : spark);
  assert.equal(resolveTokenTracePair(legacy).pair.head.id, "dgx01");
});

test("live TokenTrace refuses a Head that is not the local sparkDash host", () => {
  const manager = new TokenTraceManager({
    getSparks: () => sparks.map((spark) => ({ ...spark, isLocal: false })),
    getSnapshots: () => [],
  });
  const status = manager.status();
  assert.equal(status.available, false);
  assert.match(status.reason, /must be configured as Local/);
  manager.close();
});

test("public mapping omits SSH host details", () => {
  const manager = new TokenTraceManager({ getSparks: () => sparks, getSnapshots: () => [] });
  assert.deepEqual(manager.status().mapping, {
    head: { id: "dgx01", name: "head" },
    worker: { id: "dgx02", name: "worker" },
  });
  manager.close();
});

test("machineView hides unsupported memory-controller data and converts disk bytes/s to MiB/s", () => {
  const view = machineView({
    id: "dgx01", name: "dgx01", online: true,
    metrics: {
      gpu: { usage: 95, temperature: 48, memoryControllerUtil: 0, power: { draw: 92 } },
      ram: { swap: { used: 1024, total: 8192, percentage: 13, inPages: 110, inPagesPerSec: 2, majorFaults: 90, majorFaultsPerSec: 1 } },
      network: { rdma: [] },
      storage: [{ readSpeed: 1024 * 1024, writeSpeed: 239254 }],
    },
  });
  assert.equal(view.gpu.memoryController, null);
  assert.equal(view.storageReadMBps, 1);
  assert.ok(Math.abs(view.storageWriteMBps - 0.22817) < 0.0001);
  assert.equal(view.paging.swapInPagesPerSec, 2);
  assert.equal(view.paging.majorFaults, 90);
});

test("detokenize mode emits incremental real token text", async () => {
  const sent = [];
  const bodies = [];
  const manager = new TokenTraceManager({
    getSparks: () => sparks,
    getSnapshots: () => [],
    tokenOutputMode: "detokenize",
    detokenizeModel: "test-model",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return { ok: true, json: async () => ({ prompt: body.tokens.map((id) => ({ 10: "hello", 11: " world" }[id])).join("") }) };
    },
  });
  manager.clients.add({ readyState: 1, bufferedAmount: 0, send: (value) => sent.push(JSON.parse(value)) });
  const base = { type: "expert_step", t: 1, host: "dgx01", rank: 0, req: "r", layers: 1, topk: 1, rows: 1, rowsTotal: 1, routing: Buffer.from([1]).toString("base64"), sampled: 1 };
  manager._ingest({ ...base, step: 1, tokenIds: [10] });
  manager._ingest({ ...base, t: 2, step: 2, tokenIds: [11] });
  await manager.decodeQueue;
  assert.deepEqual(bodies.map((body) => body.tokens), [[10], [10, 11]]);
  assert.deepEqual(sent.filter((value) => value.type === "tokentrace_step").map((value) => value.event.tokenText), ["hello", " world"]);
  manager.close();
});

test("demo stream sends status and validated live steps", async () => {
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (value) => sent.push(JSON.parse(value)) };
  const manager = new TokenTraceManager({
    getSparks: () => sparks,
    getSnapshots: () => sparks.map((s) => ({ ...s, online: true, metrics: { gpu: null, network: { rdma: [] }, storage: [] } })),
    demo: true,
    demoIntervalMs: 10,
  });
  manager.subscribe(ws);
  await new Promise((resolve) => setTimeout(resolve, 35));
  manager.unsubscribe(ws);
  assert(sent.some((m) => m.type === "tokentrace_status" && m.source === "demo"));
  const steps = sent.filter((m) => m.type === "tokentrace_step");
  assert(steps.length >= 2);
  assert.equal(steps[0].event.layers, 43);
  assert.equal(Buffer.from(steps[0].event.routing, "base64").length, steps[0].event.rows * 43 * 6);
  assert.deepEqual(steps[0].machines.map((m) => m.id), ["dgx01", "dgx02"]);
  manager.close();
});
