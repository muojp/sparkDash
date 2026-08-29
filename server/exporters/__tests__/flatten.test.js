import test from "node:test";
import assert from "node:assert/strict";
import { flattenSnapshot, flattenSnapshots, METRICS } from "../flatten.js";

const MB = 1024 * 1024;

const snap = {
  id: "s1",
  name: "Spark 1",
  kind: "spark",
  online: true,
  uptime: 1234,
  role: "worker",
  lanIp: "192.168.0.130",
  workerLabel: "distributed",
  workerHeadId: "dgx01",
  hardware: { device: "NVIDIA DGX Spark", cpuModel: "GB10", gpuChip: "GB10", cudaDriver: null },
  llmPorts: [8888, 8889],
  comfyPort: 8188,
  hermes: { monitoring: true, installed: true, updateAvailable: false, behindCommits: 0 },
  metrics: {
    gpu: {
      temperature: 55.5,
      usage: 42,
      power: { draw: 60, limit: 100, systemDraw: 95 },
      vram: { used: 1024, total: 4096, percentage: 25, available: 3072 },
      processes: [{ pid: 42, name: "vllm", vramMB: 512 }],
      throttle: { active: true, reason: "thermal", smClockMHz: 900, smClockMaxMHz: 1800, smClockPct: 50 },
    },
    cpu: { usage: 10, temperature: 40, draw: 15, tdp: 65 },
    ram: { used: 2048, total: 8192, percentage: 25 },
    unifiedMemory: {
      total: 8192, gpuUsed: 1024, cpuUsed: 2048, used: 3072, available: 5120, percentage: 37.5,
      oomRisk: "medium", bandwidth: { current: 120.5, peak: 273 },
    },
    storage: [
      { device: "nvme0n1p1", label: "/", used: 100, total: 1000, available: 900, percentage: 10, readSpeed: 5, writeSpeed: 6, readBytes: 5000, writeBytes: 6000 },
      { device: "sda1", label: "/mnt", used: 1, total: 2, available: 1, percentage: 50, readSpeed: 0, writeSpeed: 0, disabled: true },
    ],
    network: {
      primaryInterface: "enP7s7",
      linkSpeedMbps: 10000,
      interfaces: [
        { name: "enP7s7", rxSpeed: 100, txSpeed: 200, rxBytes: 123456789, txBytes: 987654321, operstate: "up" },
        { name: "enp1s0f0np0", rxSpeed: 0, txSpeed: 0, operstate: "up" },
        { name: "wlan0", rxSpeed: 0, txSpeed: 0, operstate: "down", disabled: true },
      ],
    },
    llm: [
      { available: true, backend: "vllm", modelId: "org/model", slotsActive: 1, slotsTotal: 8, generationTps: 33.3, prefillTps: 500, totalOutputTokens: 9999, kvCacheUsage: 0.4, requestsRunning: 1, requestsWaiting: null, preemptionsTotal: 2, posture: { level: "warn", auth: "open", scope: "lan", label: "Open · LAN", detail: "" } },
      { available: false, backend: null, modelId: null, slotsActive: 0, slotsTotal: 0, generationTps: 0, prefillTps: 0, totalOutputTokens: 0, error: "ECONNREFUSED" },
    ],
    comfy: { available: true, port: 8188, queueRunning: 1, queuePending: 3, progress: { percent: 42 }, queueEtaMs: 90000 },
    tailscale: { available: true, online: false, keyExpired: false },
  },
};

const find = (samples, name, labels = {}) =>
  samples.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v));

test("every sample has base labels, finite value and a catalog entry", () => {
  const out = flattenSnapshot(snap);
  assert.ok(out.length > 40);
  for (const s of out) {
    assert.equal(s.labels.spark, "s1");
    assert.equal(s.labels.name, "Spark 1");
    assert.equal(s.labels.kind, "spark");
    assert.ok(Number.isFinite(s.value), `${s.name} not finite`);
    assert.ok(METRICS[s.name], `${s.name} missing from METRICS catalog`);
    assert.ok(["gauge", "counter"].includes(s.type));
  }
});

test("unit + gpu + memory conversions", () => {
  const out = flattenSnapshot(snap);
  assert.equal(find(out, "up").value, 1);
  assert.equal(find(out, "uptime_seconds").value, 1234);
  assert.equal(find(out, "gpu_temperature_celsius").value, 55.5);
  assert.equal(find(out, "gpu_vram_used_bytes").value, 1024 * MB);
  assert.equal(find(out, "system_power_draw_watts").value, 95);
  assert.equal(find(out, "gpu_throttle_active").value, 1);
  assert.equal(find(out, "gpu_throttle_reason").value, 1);
  assert.equal(find(out, "gpu_process_vram_bytes", { pid: "42", process: "vllm" }).value, 512 * MB);
  assert.equal(find(out, "unified_memory_oom_risk").value, 1);
  assert.equal(find(out, "unified_memory_bandwidth_gbps").value, 120.5);
  assert.equal(find(out, "ram_total_bytes").value, 8192 * MB);
});

test("disabled storage devices / interfaces are skipped", () => {
  const out = flattenSnapshot(snap);
  assert.ok(find(out, "storage_used_bytes", { device: "nvme0n1p1", label: "/" }));
  assert.equal(find(out, "storage_used_bytes", { device: "sda1" }), undefined);
  assert.equal(find(out, "network_receive_bytes_per_second", { interface: "enP7s7" }).value, 100);
  assert.equal(find(out, "network_interface_up", { interface: "enP7s7" }).value, 1);
  assert.equal(find(out, "network_receive_bytes_per_second", { interface: "wlan0" }), undefined);
  assert.equal(find(out, "network_link_speed_mbps", { interface: "enP7s7" }).value, 10000);
});

test("cumulative network / storage counters are exported as counters, omitted when the collector lacks them", () => {
  const out = flattenSnapshot(snap);
  const rx = find(out, "network_receive_bytes_total", { interface: "enP7s7" });
  assert.equal(rx.value, 123456789);
  assert.equal(rx.type, "counter");
  assert.equal(find(out, "network_transmit_bytes_total", { interface: "enP7s7" }).value, 987654321);
  // remote-style entry without counters → gauge only
  assert.ok(find(out, "network_receive_bytes_per_second", { interface: "enp1s0f0np0" }));
  assert.equal(find(out, "network_receive_bytes_total", { interface: "enp1s0f0np0" }), undefined);
  assert.equal(find(out, "storage_read_bytes_total", { device: "nvme0n1p1" }).value, 5000);
  assert.equal(find(out, "storage_write_bytes_total", { device: "nvme0n1p1" }).type, "counter");
});

test("llm entries are labelled by port from snap.llmPorts and optional fields are omitted when null", () => {
  const out = flattenSnapshot(snap);
  const a = find(out, "llm_generation_tokens_per_second", { port: "8888" });
  assert.equal(a.value, 33.3);
  assert.equal(a.labels.backend, "vllm");
  assert.equal(a.labels.model, "org/model");
  assert.equal(find(out, "llm_output_tokens_total", { port: "8888" }).type, "counter");
  assert.equal(find(out, "llm_kv_cache_usage_ratio", { port: "8888" }).value, 0.4);
  assert.equal(find(out, "llm_requests_waiting", { port: "8888" }), undefined);
  assert.equal(find(out, "llm_preemptions_total", { port: "8888" }).value, 2);
  const b = find(out, "llm_available", { port: "8889" });
  assert.equal(b.value, 0);
  assert.equal(b.labels.backend, "");
  assert.equal(find(out, "llm_kv_cache_usage_ratio", { port: "8889" }), undefined);
});

test("comfy / tailscale / hermes", () => {
  const out = flattenSnapshot(snap);
  assert.equal(find(out, "comfy_queue_pending", { port: "8188" }).value, 3);
  assert.equal(find(out, "comfy_progress_percent").value, 42);
  assert.equal(find(out, "comfy_queue_eta_seconds").value, 90);
  assert.equal(find(out, "tailscale_online").value, 0);
  assert.equal(find(out, "hermes_installed").value, 1);
  assert.equal(find(out, "hermes_update_available").value, 0);
});

test("info metrics carry static facts as labels", () => {
  const out = flattenSnapshot(snap);
  const info = find(out, "unit_info");
  assert.equal(info.value, 1);
  assert.equal(info.labels.role, "worker");
  assert.equal(info.labels.lan_ip, "192.168.0.130");
  assert.equal(info.labels.device, "NVIDIA DGX Spark");
  assert.equal(info.labels.gpu_chip, "GB10");
  assert.equal(info.labels.cuda_driver, "");
  assert.equal(info.labels.worker_label, "distributed");
  assert.equal(info.labels.worker_head, "dgx01");
  assert.equal(find(out, "network_primary_interface_info", { interface: "enP7s7" }).value, 1);
  const posture = find(out, "llm_posture_level", { port: "8888" });
  assert.equal(posture.value, 1);
  assert.equal(posture.labels.auth, "open");
  assert.equal(posture.labels.scope, "lan");
  assert.equal(find(out, "llm_posture_level", { port: "8889" }), undefined);
});

test("offline / empty snapshot degrades to up=0 only plus default metric objects", () => {
  const out = flattenSnapshot({ id: "x", name: "X", online: false, uptime: null, metrics: {} });
  assert.deepEqual(out.map((s) => s.name), ["up", "unit_info"]);
  assert.equal(out[0].value, 0);
  assert.equal(out[1].labels.role, "");
  assert.deepEqual(flattenSnapshot(null), []);
  assert.deepEqual(flattenSnapshots([]), []);
});

test("non-finite values are dropped instead of exported", () => {
  const out = flattenSnapshot({ id: "x", name: "X", online: true, metrics: { cpu: { usage: NaN, temperature: "abc", draw: Infinity, tdp: 65 } } });
  assert.deepEqual(out.map((s) => s.name), ["up", "unit_info", "cpu_tdp_watts"]);
});
