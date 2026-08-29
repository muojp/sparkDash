/**
 * flatten — turn a SparkMonitor.snapshot() into a flat list of numeric
 * samples shared by every exporter (Prometheus text format, InfluxDB line
 * protocol, …). Pure function: no I/O, no state.
 *
 * Each sample: { name, help, type, labels, value }
 *   - name   metric name WITHOUT prefix ("gpu_temperature_celsius")
 *   - type   "gauge" | "counter"
 *   - labels flat string map; unit labels (spark, name, kind) are always set
 *   - value  finite number (non-finite values are dropped)
 *
 * Units follow Prometheus conventions where the source allows: bytes,
 * seconds, celsius, watts, percent (0–100), ratio (0–1). Source values that
 * are MB are converted to bytes with 1024² (matches UNIT_CONVERSION.BYTES_TO_MB).
 */

const MB = 1024 * 1024;

const OOM_RISK = { low: 0, medium: 1, high: 2 };
const POSTURE_LEVEL = { ok: 0, warn: 1, danger: 2 };
const THROTTLE_REASON = { ok: 0, thermal: 1, power: 2, hw: 3, unknown: 4 };

/** Metric catalog — help text + type live here so every exporter agrees. */
export const METRICS = Object.freeze({
  up: ["gauge", "1 when the unit passed its last liveness check"],
  uptime_seconds: ["gauge", "System uptime in seconds (from /proc/uptime)"],
  unit_info: ["gauge", "Static unit facts as labels (role, lan_ip, device, gpu_chip, cpu_model, cuda_driver, worker_label, worker_head); value 1"],

  gpu_temperature_celsius: ["gauge", "GPU temperature"],
  gpu_usage_percent: ["gauge", "GPU utilization 0-100"],
  gpu_power_draw_watts: ["gauge", "GPU power draw"],
  gpu_power_limit_watts: ["gauge", "GPU power limit"],
  system_power_draw_watts: ["gauge", "Estimated total system power draw (GPU + CPU + peripherals)"],
  gpu_vram_used_bytes: ["gauge", "GPU / unified memory used by the GPU"],
  gpu_vram_total_bytes: ["gauge", "GPU memory total"],
  gpu_vram_available_bytes: ["gauge", "GPU memory available"],
  gpu_vram_usage_percent: ["gauge", "GPU memory usage 0-100"],
  gpu_throttle_active: ["gauge", "1 when any clock-limiting reason is active"],
  gpu_throttle_reason: ["gauge", "0=ok 1=thermal 2=power 3=hw 4=unknown"],
  gpu_sm_clock_mhz: ["gauge", "Current SM clock"],
  gpu_sm_clock_max_mhz: ["gauge", "Max SM clock"],
  gpu_sm_clock_percent: ["gauge", "Current SM clock as % of max"],
  gpu_process_vram_bytes: ["gauge", "VRAM used by a GPU process (top processes only)"],
  gpu_clock_cap_installed: ["gauge", "1 when the gb10-clock-cap systemd unit exists on the node"],
  gpu_clock_cap_enabled: ["gauge", "1 when the gb10-clock-cap unit is enabled (applied at boot)"],
  gpu_clock_cap_active: ["gauge", "1 when the GPU clock cap is currently applied (unit active)"],
  gpu_clock_cap_sm_clock_mhz: ["gauge", "SM clock read at clock-cap probe time"],

  cpu_usage_percent: ["gauge", "CPU utilization 0-100"],
  cpu_temperature_celsius: ["gauge", "CPU temperature"],
  cpu_power_draw_watts: ["gauge", "CPU power draw"],
  cpu_tdp_watts: ["gauge", "CPU TDP"],

  ram_used_bytes: ["gauge", "System RAM used"],
  ram_total_bytes: ["gauge", "System RAM total"],
  ram_usage_percent: ["gauge", "System RAM usage 0-100"],

  unified_memory_total_bytes: ["gauge", "Unified memory pool size"],
  unified_memory_gpu_used_bytes: ["gauge", "Unified memory used by GPU"],
  unified_memory_cpu_used_bytes: ["gauge", "Unified memory used by CPU"],
  unified_memory_used_bytes: ["gauge", "Unified memory used total"],
  unified_memory_available_bytes: ["gauge", "Unified memory available"],
  unified_memory_usage_percent: ["gauge", "Unified memory usage 0-100"],
  unified_memory_oom_risk: ["gauge", "0=low 1=medium 2=high"],
  unified_memory_bandwidth_gbps: ["gauge", "Memory bandwidth current (GB/s, from nvidia-smi dmon)"],
  unified_memory_bandwidth_peak_gbps: ["gauge", "Memory bandwidth peak (GB/s)"],

  storage_used_bytes: ["gauge", "Filesystem used"],
  storage_total_bytes: ["gauge", "Filesystem size"],
  storage_available_bytes: ["gauge", "Filesystem available"],
  storage_usage_percent: ["gauge", "Filesystem usage 0-100"],
  storage_read_bytes_per_second: ["gauge", "Block device read throughput (collector's last poll window)"],
  storage_write_bytes_per_second: ["gauge", "Block device write throughput (collector's last poll window)"],
  storage_read_bytes_total: ["counter", "Cumulative bytes read from the block device since boot — use rate() for loss-free throughput"],
  storage_write_bytes_total: ["counter", "Cumulative bytes written to the block device since boot"],

  network_link_speed_mbps: ["gauge", "Primary interface link speed"],
  network_primary_interface_info: ["gauge", "Default-route interface as the `interface` label; value 1"],
  network_receive_bytes_per_second: ["gauge", "Interface receive throughput (collector's last poll window)"],
  network_transmit_bytes_per_second: ["gauge", "Interface transmit throughput (collector's last poll window)"],
  network_receive_bytes_total: ["counter", "Cumulative bytes received on the interface since boot — use rate() for loss-free throughput"],
  network_transmit_bytes_total: ["counter", "Cumulative bytes transmitted on the interface since boot"],
  network_interface_up: ["gauge", "1 when operstate is up"],

  rdma_receive_bytes_total: ["counter", "Cumulative bytes received on the RDMA/RoCE port (IB port_rcv_data × 4) — NCCL traffic bypasses /proc/net/dev and only shows here"],
  rdma_transmit_bytes_total: ["counter", "Cumulative bytes transmitted on the RDMA/RoCE port (IB port_xmit_data × 4)"],
  rdma_receive_packets_total: ["counter", "Cumulative packets received on the RDMA/RoCE port"],
  rdma_transmit_packets_total: ["counter", "Cumulative packets transmitted on the RDMA/RoCE port"],
  rdma_receive_bytes_per_second: ["gauge", "RDMA/RoCE receive throughput (collector's last poll window)"],
  rdma_transmit_bytes_per_second: ["gauge", "RDMA/RoCE transmit throughput (collector's last poll window)"],
  rdma_link_speed_mbps: ["gauge", "RDMA/RoCE port link rate"],
  rdma_port_active: ["gauge", "1 when the IB port state is ACTIVE"],

  llm_available: ["gauge", "1 when the LLM server answered the probe"],
  llm_slots_active: ["gauge", "Active generation slots / requests"],
  llm_slots_max: ["gauge", "Total generation slots"],
  llm_generation_tokens_per_second: ["gauge", "Live decode tok/s"],
  llm_prefill_tokens_per_second: ["gauge", "Live prefill tok/s"],
  llm_cached_prefill_tokens_per_second: ["gauge", "Live cached prefill tok/s (backends that split kinds)"],
  llm_uncached_prefill_tokens_per_second: ["gauge", "Live uncached prefill tok/s"],
  llm_output_tokens_total: ["counter", "Cumulative generated tokens as reported by the LLM server"],
  llm_context_length: ["gauge", "Model context length"],
  llm_gpu_memory_utilization_ratio: ["gauge", "Engine GPU memory utilization 0-1 (vLLM)"],
  llm_kv_cache_usage_ratio: ["gauge", "KV cache usage 0-1 (vLLM)"],
  llm_requests_running: ["gauge", "Running requests (vLLM)"],
  llm_requests_waiting: ["gauge", "Waiting requests (vLLM)"],
  llm_ttft_p95_seconds: ["gauge", "Time-to-first-token p95 (vLLM)"],
  llm_e2e_p95_seconds: ["gauge", "End-to-end request latency p95 (vLLM)"],
  llm_itl_p95_seconds: ["gauge", "Inter-token latency p95 (vLLM)"],
  llm_preemptions_total: ["counter", "Cumulative preemptions (vLLM)"],
  llm_prefix_cache_hit_ratio: ["gauge", "Prefix cache hit rate 0-1 (vLLM)"],
  llm_mtp_acceptance_ratio: ["gauge", "Speculative / MTP acceptance rate 0-1 (vLLM)"],
  llm_posture_level: ["gauge", "Exposure posture of the LLM endpoint: 0=ok 1=warn 2=danger; labels auth (open|protected|keyed) and scope (local|lan|public|unknown)"],

  comfy_available: ["gauge", "1 when ComfyUI answered the probe"],
  comfy_queue_running: ["gauge", "Running ComfyUI jobs"],
  comfy_queue_pending: ["gauge", "Pending ComfyUI jobs"],
  comfy_progress_percent: ["gauge", "Active job progress 0-100"],
  comfy_queue_eta_seconds: ["gauge", "Estimated time to drain the queue"],

  tailscale_available: ["gauge", "1 when tailscale status was readable"],
  tailscale_online: ["gauge", "1 when the node reports itself online on its tailnet"],
  tailscale_key_expired: ["gauge", "1 when the node key is expired"],

  hermes_installed: ["gauge", "1 when the hermes binary was found"],
  hermes_update_available: ["gauge", "1 when hermes update --check reports pending commits"],
  hermes_behind_commits: ["gauge", "Commits behind origin/main"],
});

function num(v) {
  const n = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Flatten one snapshot.
 * @param {object} snap  SparkMonitor.snapshot()
 * @returns {Array<{name:string,type:string,help:string,labels:Record<string,string>,value:number}>}
 */
export function flattenSnapshot(snap) {
  const out = [];
  if (!snap || typeof snap !== "object") return out;
  const base = {
    spark: String(snap.id ?? ""),
    name: String(snap.name ?? snap.id ?? ""),
    kind: String(snap.kind ?? "spark"),
  };
  const push = (name, value, extra) => {
    const v = num(value);
    if (v === null) return;
    const [type, help] = METRICS[name] || ["gauge", ""];
    out.push({ name, type, help, labels: extra ? { ...base, ...extra } : base, value: v });
  };

  push("up", snap.online);
  if (snap.uptime != null) push("uptime_seconds", snap.uptime);
  {
    const hw = snap.hardware || {};
    push("unit_info", 1, {
      role: String(snap.role ?? ""),
      lan_ip: String(snap.lanIp ?? ""),
      device: String(hw.device ?? ""),
      gpu_chip: String(hw.gpuChip ?? ""),
      cpu_model: String(hw.cpuModel ?? ""),
      cuda_driver: String(hw.cudaDriver ?? ""),
      worker_label: String(snap.workerLabel ?? ""),
      worker_head: String(snap.workerHeadId ?? ""),
    });
  }

  const m = snap.metrics || {};

  // ── GPU ──
  const gpu = m.gpu;
  if (gpu) {
    push("gpu_temperature_celsius", gpu.temperature);
    push("gpu_usage_percent", gpu.usage);
    if (gpu.power) {
      push("gpu_power_draw_watts", gpu.power.draw);
      push("gpu_power_limit_watts", gpu.power.limit);
      if (gpu.power.systemDraw != null) push("system_power_draw_watts", gpu.power.systemDraw);
    }
    if (gpu.vram) {
      push("gpu_vram_used_bytes", gpu.vram.used * MB);
      push("gpu_vram_total_bytes", gpu.vram.total * MB);
      push("gpu_vram_available_bytes", gpu.vram.available * MB);
      push("gpu_vram_usage_percent", gpu.vram.percentage);
    }
    const t = gpu.throttle;
    if (t) {
      push("gpu_throttle_active", t.active);
      push("gpu_throttle_reason", THROTTLE_REASON[t.reason] ?? THROTTLE_REASON.unknown);
      if (t.smClockMHz != null) push("gpu_sm_clock_mhz", t.smClockMHz);
      if (t.smClockMaxMHz != null) push("gpu_sm_clock_max_mhz", t.smClockMaxMHz);
      if (t.smClockPct != null) push("gpu_sm_clock_percent", t.smClockPct);
    }
    for (const p of gpu.processes || []) {
      push("gpu_process_vram_bytes", p.vramMB * MB, {
        pid: String(p.pid),
        process: String(p.name ?? ""),
      });
    }
  }

  // ── GPU clock cap (opt-in probe; null fields = not probed yet / unreachable) ──
  const cc = snap.clockCap;
  if (cc && cc.monitoring) {
    if (cc.installed != null) push("gpu_clock_cap_installed", cc.installed);
    if (cc.enabled != null) push("gpu_clock_cap_enabled", cc.enabled);
    if (cc.active != null) push("gpu_clock_cap_active", cc.active);
    if (cc.smClockMHz != null) push("gpu_clock_cap_sm_clock_mhz", cc.smClockMHz);
  }

  // ── CPU / RAM ──
  const cpu = m.cpu;
  if (cpu) {
    push("cpu_usage_percent", cpu.usage);
    push("cpu_temperature_celsius", cpu.temperature);
    push("cpu_power_draw_watts", cpu.draw);
    push("cpu_tdp_watts", cpu.tdp);
  }
  const ram = m.ram;
  if (ram) {
    push("ram_used_bytes", ram.used * MB);
    push("ram_total_bytes", ram.total * MB);
    push("ram_usage_percent", ram.percentage);
  }

  // ── Unified memory ──
  const um = m.unifiedMemory;
  if (um) {
    push("unified_memory_total_bytes", um.total * MB);
    push("unified_memory_gpu_used_bytes", um.gpuUsed * MB);
    push("unified_memory_cpu_used_bytes", um.cpuUsed * MB);
    push("unified_memory_used_bytes", um.used * MB);
    push("unified_memory_available_bytes", um.available * MB);
    push("unified_memory_usage_percent", um.percentage);
    push("unified_memory_oom_risk", OOM_RISK[um.oomRisk] ?? 0);
    if (um.bandwidth) {
      push("unified_memory_bandwidth_gbps", um.bandwidth.current);
      push("unified_memory_bandwidth_peak_gbps", um.bandwidth.peak);
    }
  }

  // ── Storage ──
  for (const s of m.storage || []) {
    if (!s || s.disabled) continue;
    const l = { device: String(s.device ?? ""), label: String(s.label ?? s.device ?? "") };
    push("storage_used_bytes", s.used * MB, l);
    push("storage_total_bytes", s.total * MB, l);
    push("storage_available_bytes", s.available * MB, l);
    push("storage_usage_percent", s.percentage, l);
    push("storage_read_bytes_per_second", s.readSpeed, l);
    push("storage_write_bytes_per_second", s.writeSpeed, l);
    if (s.readBytes != null) push("storage_read_bytes_total", s.readBytes, l);
    if (s.writeBytes != null) push("storage_write_bytes_total", s.writeBytes, l);
  }

  // ── Network ──
  const net = m.network;
  if (net) {
    if (net.primaryInterface) {
      push("network_primary_interface_info", 1, { interface: String(net.primaryInterface) });
    }
    if (net.linkSpeedMbps != null) {
      push("network_link_speed_mbps", net.linkSpeedMbps, {
        interface: String(net.primaryInterface ?? ""),
      });
    }
    for (const i of net.interfaces || []) {
      if (!i || i.disabled) continue;
      const l = { interface: String(i.name ?? "") };
      push("network_receive_bytes_per_second", i.rxSpeed, l);
      push("network_transmit_bytes_per_second", i.txSpeed, l);
      if (i.rxBytes != null) push("network_receive_bytes_total", i.rxBytes, l);
      if (i.txBytes != null) push("network_transmit_bytes_total", i.txBytes, l);
      push("network_interface_up", i.operstate === "up", l);
    }
    for (const r of net.rdma || []) {
      if (!r) continue;
      const l = { hca: String(r.hca ?? ""), port: String(r.port ?? "") };
      if (r.rxBytes != null) push("rdma_receive_bytes_total", r.rxBytes, l);
      if (r.txBytes != null) push("rdma_transmit_bytes_total", r.txBytes, l);
      if (r.rxPackets != null) push("rdma_receive_packets_total", r.rxPackets, l);
      if (r.txPackets != null) push("rdma_transmit_packets_total", r.txPackets, l);
      push("rdma_receive_bytes_per_second", r.rxSpeed, l);
      push("rdma_transmit_bytes_per_second", r.txSpeed, l);
      if (r.rateMbps != null) push("rdma_link_speed_mbps", r.rateMbps, l);
      push("rdma_port_active", r.active === true || r.state === "active", l);
    }
  }

  // ── LLM (one entry per port, same order as snap.llmPorts) ──
  const ports = Array.isArray(snap.llmPorts) ? snap.llmPorts : [];
  (m.llm || []).forEach((llm, idx) => {
    if (!llm) return;
    const l = {
      port: String(ports[idx] ?? llm.port ?? ""),
      backend: String(llm.backend ?? ""),
      model: String(llm.modelId ?? ""),
    };
    push("llm_available", llm.available, l);
    push("llm_slots_active", llm.slotsActive, l);
    push("llm_slots_max", llm.slotsTotal, l);
    push("llm_generation_tokens_per_second", llm.generationTps, l);
    push("llm_prefill_tokens_per_second", llm.prefillTps, l);
    if (llm.cachedPrefillTps != null) push("llm_cached_prefill_tokens_per_second", llm.cachedPrefillTps, l);
    if (llm.uncachedPrefillTps != null) push("llm_uncached_prefill_tokens_per_second", llm.uncachedPrefillTps, l);
    push("llm_output_tokens_total", llm.totalOutputTokens, l);
    if (llm.contextLength != null) push("llm_context_length", llm.contextLength, l);
    if (llm.gpuMemoryUtilization != null) push("llm_gpu_memory_utilization_ratio", llm.gpuMemoryUtilization, l);
    if (llm.kvCacheUsage != null) push("llm_kv_cache_usage_ratio", llm.kvCacheUsage, l);
    if (llm.requestsRunning != null) push("llm_requests_running", llm.requestsRunning, l);
    if (llm.requestsWaiting != null) push("llm_requests_waiting", llm.requestsWaiting, l);
    if (llm.ttftP95Seconds != null) push("llm_ttft_p95_seconds", llm.ttftP95Seconds, l);
    if (llm.e2eP95Seconds != null) push("llm_e2e_p95_seconds", llm.e2eP95Seconds, l);
    if (llm.itlP95Seconds != null) push("llm_itl_p95_seconds", llm.itlP95Seconds, l);
    if (llm.preemptionsTotal != null) push("llm_preemptions_total", llm.preemptionsTotal, l);
    if (llm.prefixCacheHitRate != null) push("llm_prefix_cache_hit_ratio", llm.prefixCacheHitRate, l);
    if (llm.mtpAcceptanceRate != null) push("llm_mtp_acceptance_ratio", llm.mtpAcceptanceRate, l);
    if (llm.posture && llm.posture.level in POSTURE_LEVEL) {
      push("llm_posture_level", POSTURE_LEVEL[llm.posture.level], {
        ...l,
        auth: String(llm.posture.auth ?? "unknown"),
        scope: String(llm.posture.scope ?? "unknown"),
      });
    }
  });

  // ── ComfyUI ──
  const c = m.comfy;
  if (c) {
    const l = { port: String(c.port ?? snap.comfyPort ?? "") };
    push("comfy_available", c.available, l);
    push("comfy_queue_running", c.queueRunning, l);
    push("comfy_queue_pending", c.queuePending, l);
    if (c.progress && c.progress.percent != null) push("comfy_progress_percent", c.progress.percent, l);
    if (c.queueEtaMs != null) push("comfy_queue_eta_seconds", c.queueEtaMs / 1000, l);
  }

  // ── Tailscale ──
  const ts = m.tailscale;
  if (ts) {
    push("tailscale_available", ts.available);
    if (ts.online != null) push("tailscale_online", ts.online);
    push("tailscale_key_expired", ts.keyExpired);
  }

  // ── Hermes ──
  const h = snap.hermes;
  if (h && h.monitoring) {
    if (h.installed != null) push("hermes_installed", h.installed);
    if (h.updateAvailable != null) push("hermes_update_available", h.updateAvailable);
    if (h.behindCommits != null) push("hermes_behind_commits", h.behindCommits);
  }

  return out;
}

/** Flatten many snapshots (registry order preserved). */
export function flattenSnapshots(snaps) {
  const out = [];
  for (const s of snaps || []) out.push(...flattenSnapshot(s));
  return out;
}
