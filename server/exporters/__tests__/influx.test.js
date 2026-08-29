import test from "node:test";
import assert from "node:assert/strict";
import { renderLineProtocol, splitMetricName, InfluxPusher } from "../influx.js";
import { flattenSnapshot } from "../flatten.js";

test("splitMetricName keeps multi-token domains whole", () => {
  assert.deepEqual(splitMetricName("gpu_temperature_celsius"), ["gpu", "temperature_celsius"]);
  assert.deepEqual(splitMetricName("unified_memory_used_bytes"), ["unified_memory", "used_bytes"]);
  assert.deepEqual(splitMetricName("system_power_draw_watts"), ["system_power", "draw_watts"]);
  assert.deepEqual(splitMetricName("up"), ["unit", "up"]);
  assert.deepEqual(splitMetricName("uptime_seconds"), ["unit", "uptime_seconds"]);
});

test("one line per (measurement, tag set); all fields written as floats (no i suffix); tags escaped + sorted", () => {
  const snap = {
    id: "s1", name: "Spark 1", kind: "spark", online: true, uptime: 10, llmPorts: [8888],
    metrics: {
      gpu: { temperature: 55.5, usage: 42, power: { draw: 60, limit: 100 }, vram: { used: 1, total: 2, percentage: 50, available: 1 }, processes: [] },
      storage: [{ device: "nvme0n1p1", label: "/", used: 1, total: 2, available: 1, percentage: 50, readSpeed: 0, writeSpeed: 0 }],
      llm: [{ available: true, backend: "vllm", modelId: "org/model v2", slotsActive: 0, slotsTotal: 8, generationTps: 1.5, prefillTps: 0, totalOutputTokens: 77 }],
    },
  };
  const text = renderLineProtocol(flattenSnapshot(snap), { timestampMs: 1700000000000 });
  const lines = text.trimEnd().split("\n");
  const gpu = lines.find((l) => l.startsWith("sparkdash_gpu,"));
  assert.ok(gpu.startsWith("sparkdash_gpu,kind=spark,name=Spark\\ 1,spark=s1 "));
  assert.ok(gpu.includes("temperature_celsius=55.5"));
  assert.ok(gpu.includes("usage_percent=42.0"));
  assert.ok(!/=\d+i[, ]/.test(gpu), "no integer-typed fields");
  assert.ok(gpu.endsWith(" 1700000000000"));
  const unit = lines.find((l) => l.startsWith("sparkdash_unit,"));
  assert.ok(unit.includes("up=1.0"));
  assert.ok(unit.includes("uptime_seconds=10.0"));
  const st = lines.find((l) => l.startsWith("sparkdash_storage,"));
  assert.ok(st.includes("device=nvme0n1p1"));
  assert.ok(st.includes("label=/"));
  const llm = lines.find((l) => l.startsWith("sparkdash_llm,"));
  assert.ok(llm.includes("model=org/model\\ v2"));
  assert.ok(llm.includes("port=8888"));
  assert.ok(llm.includes("output_tokens_total=77.0"));
  assert.ok(llm.includes("generation_tokens_per_second=1.5"));
  // exactly one gpu line, one llm line
  assert.equal(lines.filter((l) => l.startsWith("sparkdash_gpu,")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("sparkdash_llm,")).length, 1);
});

test("empty samples → empty body", () => {
  assert.equal(renderLineProtocol([], { timestampMs: 1 }), "");
});

test("InfluxPusher posts line protocol with token + query params and tracks lastResult", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204, text: async () => "" };
  };
  const p = new InfluxPusher({
    getSnapshots: () => [{ id: "a", name: "A", online: true, metrics: {} }],
    url: "http://influx:8086/",
    org: "lab",
    bucket: "sparkdash",
    token: "tok",
    intervalMs: 5000,
    fetchImpl,
  });
  const r = await p.pushOnce();
  assert.equal(r.ok, true);
  assert.equal(r.lines, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://influx:8086/api/v2/write?org=lab&bucket=sparkdash&precision=ms");
  assert.equal(calls[0].init.headers.Authorization, "Token tok");
  assert.match(calls[0].init.body, /^sparkdash_unit,kind=spark,name=A,spark=a up=1\.0 \d+\n$/);
});

test("InfluxPusher records HTTP errors and network failures without throwing", async () => {
  const p = new InfluxPusher({
    getSnapshots: () => [{ id: "a", name: "A", online: true, metrics: {} }],
    url: "http://influx:8086",
    bucket: "b",
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }),
  });
  const r = await p.pushOnce();
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  const p2 = new InfluxPusher({
    getSnapshots: () => [{ id: "a", name: "A", online: true, metrics: {} }],
    url: "http://influx:8086",
    bucket: "b",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  const r2 = await p2.pushOnce();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /ECONNREFUSED/);
});
