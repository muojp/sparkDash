/**
 * SparkMonitor in demo mode + snapshot shape contract.
 * DEMO_MODE is read from env at import time, so set it before importing.
 */
import test from "node:test";
import assert from "node:assert/strict";
process.env.SPARKDASH_DEMO = "1";
const { SparkMonitor } = await import("../SparkMonitor.js");
const { DemoCollector, DemoLlmProbe } = await import("../../collectors/DemoCollector.js");
const { flattenSnapshot } = await import("../../exporters/flatten.js");

const cfg = (extra = {}) => ({
  id: "demo-1", name: "Demo 1", kind: "spark", lanIp: "10.0.0.1", isLocal: false,
  ssh: { host: "10.0.0.1", user: "nvidia", auth: "key" }, llmPorts: [8888, 8889], role: "head", ...extra,
});

test("demo mode swaps in DemoCollector + DemoLlmProbe (one per port)", () => {
  const m = new SparkMonitor(cfg());
  assert.ok(m.collector instanceof DemoCollector);
  assert.equal(m.llmProbes.size, 2);
  for (const p of m.llmProbes.values()) assert.ok(p instanceof DemoLlmProbe);
  m.stop();
});

test("updateConfig adds/removes demo probes by port and keeps existing instances", () => {
  const m = new SparkMonitor(cfg());
  const keep = m.llmProbes.get(8888);
  m.updateConfig(cfg({ llmPorts: [8888, 9999] }));
  assert.deepEqual([...m.llmProbes.keys()], [8888, 9999]);
  assert.equal(m.llmProbes.get(8888), keep);
  assert.ok(m.llmProbes.get(9999) instanceof DemoLlmProbe);
  m.updateConfig(cfg({ role: "worker" }));
  assert.equal(m.llmProbes.size, 0);
  assert.deepEqual(m.snapshot().metrics.llm, []);
  m.stop();
});

test("snapshot before any poll has the full metric key tree (UI + exporter safety)", () => {
  const m = new SparkMonitor(cfg());
  const s = m.snapshot();
  assert.equal(s.id, "demo-1");
  assert.equal(s.online, false);
  assert.deepEqual(s.llmPorts, [8888, 8889]);
  assert.deepEqual(Object.keys(s.metrics), ["gpu", "cpu", "ram", "storage", "network", "unifiedMemory", "llm", "comfy", "tailscale"]);
  assert.deepEqual(Object.keys(s.metrics.gpu), ["temperature", "usage", "power", "vram", "processes", "throttle"]);
  assert.deepEqual(Object.keys(s.metrics.unifiedMemory), ["total", "gpuUsed", "cpuUsed", "used", "available", "percentage", "oomRisk", "bandwidth"]);
  // Only `up` before the first poll delivers data? No — defaults are exported as 0s, which is what the UI shows too.
  const names = new Set(flattenSnapshot(s).map((x) => x.name));
  assert.ok(names.has("up"));
  assert.ok(names.has("gpu_usage_percent"));
  assert.ok(!names.has("llm_available"));
  m.stop();
});

test("after one poll cycle the demo unit is online with populated metrics that flatten cleanly", async () => {
  const m = new SparkMonitor(cfg({ kind: "host" }));
  m._running = true; // enable _poll without starting timers
  await m._poll();
  const s = m.snapshot();
  assert.equal(s.online, true);
  assert.ok(Number.isInteger(s.uptime) && s.uptime > 0);
  assert.ok(s.metrics.gpu.temperature > 0);
  assert.ok(s.metrics.gpu.vram.total > 0);
  assert.equal(s.metrics.storage.length, 1);
  assert.equal(s.metrics.network.interfaces.length, 3);
  assert.equal(s.metrics.llm.length, 2);
  assert.equal(s.metrics.llm[0].backend, "vllm");
  const samples = flattenSnapshot(s);
  const names = new Set(samples.map((x) => x.name));
  for (const n of [
    "uptime_seconds", "gpu_temperature_celsius", "gpu_vram_used_bytes", "gpu_throttle_active", "gpu_process_vram_bytes",
    "cpu_usage_percent", "ram_used_bytes", "unified_memory_bandwidth_gbps", "storage_used_bytes",
    "network_receive_bytes_per_second", "network_link_speed_mbps",
    "llm_generation_tokens_per_second", "llm_output_tokens_total", "llm_kv_cache_usage_ratio",
    "network_receive_bytes_total", "network_transmit_bytes_total", "storage_read_bytes_total", "storage_write_bytes_total",
  ]) assert.ok(names.has(n), `missing ${n}`);
  for (const x of samples) assert.ok(Number.isFinite(x.value), `${x.name} not finite`);
  assert.equal(samples.filter((x) => x.name === "llm_available").length, 2);
  // Detected hardware for kind=host resolves asynchronously — poll, don't sleep a fixed time
  for (let i = 0; i < 50 && m.snapshot().hardware.device !== "Demo GPU host"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(m.snapshot().hardware.device, "Demo GPU host");
  m._running = false;
  m.stop();
});

test("demo network / disk byte counters are monotonic and integrate the rate", async () => {
  const c = new DemoCollector(cfg());
  let prevRx = -1, prevRd = -1;
  for (let i = 0; i < 5; i++) {
    const net = await c.collectNetwork();
    const cx7 = net.interfaces.find((x) => x.name === "enp1s0f0np0");
    assert.ok(cx7.rxBytes >= prevRx);
    prevRx = cx7.rxBytes;
    const st = (await c.collectStorage())[0];
    assert.ok(st.readBytes >= prevRd);
    prevRd = st.readBytes;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(prevRx > 0 && prevRd > 0, "counters advanced with elapsed time");
});

test("demo LLM output token counter is monotonic across probes", async () => {
  const p = new DemoLlmProbe(cfg(), 8888);
  let last = -1;
  for (let i = 0; i < 5; i++) {
    const r = await p.probe();
    assert.ok(r.totalOutputTokens >= last);
    last = r.totalOutputTokens;
    assert.equal(r.available, true);
    assert.ok(r.generationTps >= 0 && r.generationTps <= 120);
  }
});

test("demo collector values stay inside their declared ranges over many samples", async () => {
  const c = new DemoCollector(cfg());
  for (let i = 0; i < 200; i++) {
    const g = await c.collectGpu();
    assert.ok(g.usage >= 0 && g.usage <= 100);
    assert.ok(g.temperature >= 35 && g.temperature <= 85);
    assert.ok(g.vram.used <= g.vram.total);
    const um = await c.collectUnifiedMemory();
    assert.ok(um.used <= um.total, "unified used <= total");
    assert.ok(["low", "medium", "high"].includes(um.oomRisk));
    const st = (await c.collectStorage())[0];
    assert.ok(st.used >= 0 && st.used <= st.total);
  }
});

test("two demo units with different ids produce different (but deterministic) series", async () => {
  const a1 = await new DemoCollector(cfg({ id: "a" })).collectGpu();
  const a2 = await new DemoCollector(cfg({ id: "a" })).collectGpu();
  const b1 = await new DemoCollector(cfg({ id: "b" })).collectGpu();
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b1);
});
