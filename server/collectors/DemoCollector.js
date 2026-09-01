/**
 * DemoCollector — synthetic metrics with the exact shape of SystemCollector
 * / LlmProbe output. Enabled by SPARKDASH_DEMO=1 (see config.js DEMO_MODE);
 * SparkMonitor swaps these in for every unit so the dashboard, WebSocket
 * stream and metrics exporters can be exercised on a laptop or in CI with no
 * SSH, sysfs or nvidia-smi.
 *
 * Values are smooth random walks seeded from the unit id so two demo units
 * look different but stay stable across restarts.
 */

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Walker {
  constructor(rand, { min, max, start, step }) {
    this.rand = rand;
    this.min = min;
    this.max = max;
    this.step = step;
    this.v = start ?? (min + max) / 2;
  }
  next() {
    this.v += (this.rand() - 0.5) * 2 * this.step;
    if (this.v < this.min) this.v = this.min + (this.min - this.v) * 0.5;
    if (this.v > this.max) this.v = this.max - (this.v - this.max) * 0.5;
    return this.v;
  }
}

const r1 = (n) => Math.round(n * 10) / 10;

export class DemoCollector {
  constructor(spark) {
    this.spark = spark;
    const rand = rng(hashSeed(String(spark?.id ?? "demo")));
    this._rand = rand;
    this._startedAt = Date.now();
    const isHost = spark?.kind === "host";
    this.totalMB = isHost ? 64 * 1024 : 128 * 1024;
    this.vramTotalMB = isHost ? 24 * 1024 : this.totalMB;
    this.w = {
      gpuUsage: new Walker(rand, { min: 0, max: 100, start: 40, step: 8 }),
      gpuTemp: new Walker(rand, { min: 35, max: 85, start: 55, step: 1.5 }),
      gpuPower: new Walker(rand, { min: 10, max: isHost ? 300 : 100, start: 60, step: 6 }),
      gpuUsedMB: new Walker(rand, { min: 2048, max: this.vramTotalMB * 0.9, start: this.vramTotalMB * 0.5, step: 512 }),
      cpuUsage: new Walker(rand, { min: 0, max: 100, start: 25, step: 6 }),
      cpuTemp: new Walker(rand, { min: 30, max: 80, start: 48, step: 1 }),
      cpuPower: new Walker(rand, { min: 5, max: 65, start: 20, step: 3 }),
      ramUsedMB: new Walker(rand, { min: 4096, max: this.totalMB * 0.6, start: this.totalMB * 0.3, step: 256 }),
      bw: new Walker(rand, { min: 0, max: 273, start: 80, step: 15 }),
      rx: new Walker(rand, { min: 0, max: 1.2e9, start: 5e7, step: 2e7 }),
      tx: new Walker(rand, { min: 0, max: 1.2e9, start: 2e7, step: 1e7 }),
      rd: new Walker(rand, { min: 0, max: 3e9, start: 1e8, step: 5e7 }),
      wr: new Walker(rand, { min: 0, max: 2e9, start: 5e7, step: 3e7 }),
      smClock: new Walker(rand, { min: 600, max: 1800, start: 1500, step: 60 }),
    };
    this._storageUsedMB = 380 * 1024 + Math.floor(rand() * 100 * 1024);
    // Cumulative byte counters (integrated from the rate walkers each poll)
    this._net = new Map(); // iface → { rx, tx, at }
    this._disk = { read: 0, write: 0, at: Date.now() };
  }

  /** Integrate a rate into a cumulative counter across polls. */
  _accumulate(entry, key, rate, now) {
    const dt = Math.max(0, (now - entry.at) / 1000);
    entry[key] += Math.round(rate * dt);
  }

  // SparkMonitor seeds its metric cache from these before the first poll.
  _defaultGpu() {
    return {
      temperature: 0,
      usage: 0,
      power: { draw: 0, limit: 100, systemDraw: 0 },
      vram: { used: 0, total: this.vramTotalMB, percentage: 0, available: this.vramTotalMB },
      processes: [],
      throttle: null,
    };
  }
  _defaultCpu() {
    return { usage: 0, temperature: 0, draw: 0, tdp: 65 };
  }
  _defaultRam() {
    return { used: 0, total: this.totalMB, percentage: 0 };
  }
  _defaultNetwork() {
    return { primaryInterface: null, linkSpeedMbps: null, interfaces: [], wolMac: null };
  }
  _defaultUnifiedMemory() {
    return {
      total: this.totalMB,
      gpuUsed: 0,
      cpuUsed: 0,
      used: 0,
      available: this.totalMB,
      percentage: 0,
      oomRisk: "low",
      bandwidth: { current: 0, peak: 273 },
    };
  }

  /** Liveness — always reachable. */
  async pingHost() {
    return true;
  }

  /** Optional hook used by SparkMonitor in demo mode instead of /proc/uptime. */
  uptimeSeconds() {
    return Math.floor((Date.now() - this._startedAt) / 1000) + 86400 * 3;
  }

  async detectHardware() {
    return {
      device: "Demo GPU host",
      cpuModel: "Demo CPU 16-core",
      cpuCores: 16,
      totalMemoryGB: Math.round(this.totalMB / 1024),
      gpuChip: "Demo RTX",
      cudaDriver: "580.00",
      storageModel: "Demo NVMe 1TB",
    };
  }

  async collectGpu() {
    const usage = this.w.gpuUsage.next();
    const used = Math.round(this.w.gpuUsedMB.next());
    const total = this.vramTotalMB;
    const draw = this.w.gpuPower.next();
    const smClock = this.w.smClock.next();
    const thermal = this.w.gpuTemp.v > 80;
    return {
      temperature: r1(this.w.gpuTemp.next()),
      usage: r1(usage),
      power: { draw: r1(draw), limit: 100, systemDraw: r1(draw + this.w.cpuPower.v + 15) },
      vram: {
        used,
        total,
        percentage: r1((used / total) * 100),
        available: total - used,
      },
      processes: [
        { pid: 4242, name: "vllm", vramMB: Math.round(used * 0.8) },
        { pid: 5151, name: "python3", vramMB: Math.round(used * 0.15) },
      ],
      throttle: {
        thermal,
        hwSlowdown: false,
        powerCap: usage > 90,
        active: thermal || usage > 90,
        reason: thermal ? "thermal" : usage > 90 ? "power" : "ok",
        smClockMHz: Math.round(smClock),
        smClockMaxMHz: 1800,
        smClockPct: r1((smClock / 1800) * 100),
        detail: thermal ? "SW thermal slowdown" : "",
      },
    };
  }

  async collectCpu() {
    return {
      usage: r1(this.w.cpuUsage.next()),
      temperature: r1(this.w.cpuTemp.next()),
      draw: r1(this.w.cpuPower.next()),
      tdp: 65,
    };
  }

  async collectRam() {
    const used = Math.round(this.w.ramUsedMB.next());
    return { used, total: this.totalMB, percentage: r1((used / this.totalMB) * 100) };
  }

  async collectNetwork() {
    const now = Date.now();
    const rx = Math.round(this.w.rx.next());
    const tx = Math.round(this.w.tx.next());
    const specs = [
      { name: "enP7s7", rxSpeed: rx, txSpeed: tx, ip: this.spark?.lanIp || null, operstate: "up" },
      { name: "enp1s0f0np0", rxSpeed: Math.round(rx * 3), txSpeed: Math.round(tx * 3), ip: this.spark?.cx7Ip || null, operstate: "up" },
      { name: "wlP9s9", rxSpeed: 0, txSpeed: 0, ip: null, operstate: "down" },
    ];
    const interfaces = specs.map((i) => {
      let c = this._net.get(i.name);
      if (!c) {
        c = { rx: 0, tx: 0, at: now };
        this._net.set(i.name, c);
      }
      this._accumulate(c, "rx", i.rxSpeed, now);
      this._accumulate(c, "tx", i.txSpeed, now);
      c.at = now;
      return { ...i, rxBytes: c.rx, txBytes: c.tx };
    });
    return { primaryInterface: "enP7s7", linkSpeedMbps: 10000, wolMac: null, interfaces };
  }

  async collectStorage() {
    const total = 3.6 * 1024 * 1024;
    this._storageUsedMB += Math.round((this._rand() - 0.45) * 64);
    const used = Math.min(total, Math.max(0, this._storageUsedMB));
    const now = Date.now();
    const readSpeed = Math.round(this.w.rd.next());
    const writeSpeed = Math.round(this.w.wr.next());
    this._accumulate(this._disk, "read", readSpeed, now);
    this._accumulate(this._disk, "write", writeSpeed, now);
    this._disk.at = now;
    return [
      {
        device: "nvme0n1p1",
        label: "/",
        used,
        total,
        available: total - used,
        percentage: r1((used / total) * 100),
        readSpeed,
        writeSpeed,
        readBytes: this._disk.read,
        writeBytes: this._disk.write,
      },
    ];
  }

  async collectUnifiedMemory() {
    const gpuUsed = Math.round(this.w.gpuUsedMB.v);
    const cpuUsed = Math.round(this.w.ramUsedMB.v);
    const used = gpuUsed + cpuUsed;
    const total = this.totalMB;
    const pct = (used / total) * 100;
    return {
      total,
      gpuUsed,
      cpuUsed,
      used,
      available: total - used,
      percentage: r1(pct),
      oomRisk: pct > 92 ? "high" : pct > 80 ? "medium" : "low",
      bandwidth: { current: r1(this.w.bw.next()), peak: 273 },
    };
  }
}

/** Synthetic LlmProbe: vLLM-flavoured metrics with a cumulative token counter. */
export class DemoLlmProbe {
  constructor(spark, port) {
    this.spark = spark;
    this.port = port;
    const rand = rng(hashSeed(`${spark?.id ?? "demo"}:${port}`));
    this._rand = rand;
    this.w = {
      gen: new Walker(rand, { min: 0, max: 120, start: 40, step: 10 }),
      prefill: new Walker(rand, { min: 0, max: 4000, start: 1200, step: 300 }),
      kv: new Walker(rand, { min: 0.05, max: 0.95, start: 0.4, step: 0.05 }),
      ttft: new Walker(rand, { min: 0.05, max: 2.5, start: 0.4, step: 0.1 }),
    };
    this.totalPrefillTokens = 0;
    this.totalOutputTokens = 0;
    this.preemptions = 0;
    this._lastAt = Date.now();
  }

  async probe() {
    const now = Date.now();
    const dt = (now - this._lastAt) / 1000;
    this._lastAt = now;
    const gen = this.w.gen.next();
    const prefill = this.w.prefill.next();
    this.totalOutputTokens += Math.round(gen * dt);
    this.totalPrefillTokens += Math.round(prefill * dt);
    if (this._rand() < 0.02) this.preemptions += 1;
    const running = Math.round(gen / 30);
    return {
      available: true,
      backend: "vllm",
      modelId: `demo/model-${this.port}`,
      modelPath: null,
      contextLength: 32768,
      gpuMemoryUtilization: 0.9,
      slotsActive: running,
      slotsTotal: 8,
      generationTps: r1(gen),
      prefillTps: r1(prefill),
      cachedPrefillTps: null,
      uncachedPrefillTps: null,
      totalPrefillTokens: this.totalPrefillTokens,
      totalOutputTokens: this.totalOutputTokens,
      kvCacheUsage: Math.round(this.w.kv.next() * 1000) / 1000,
      requestsRunning: running,
      requestsWaiting: Math.max(0, running - 3),
      ttftP95Seconds: r1(this.w.ttft.next() * 10) / 10,
      preemptionsTotal: this.preemptions,
      prefixCacheHitRate: 0.62,
      e2eP95Seconds: r1(this.w.ttft.v * 8),
      itlP95Seconds: 0.03,
      mtpAcceptanceRate: null,
      posture: { level: "ok", auth: "open", scope: "local", label: "demo", detail: "synthetic" },
      error: null,
    };
  }
}

/** Synthetic gb10-clock-cap state: installed, cap active, SM clock follows the GPU walker. */
export class DemoClockCapProbe {
  constructor(spark, collector) {
    this.spark = spark;
    this.collector = collector;
  }
  setTarget(spark) {
    this.spark = spark;
  }
  async probe() {
    const clock = this.collector?.w?.smClock?.v;
    return {
      installed: true,
      enabled: true,
      active: true,
      smClockMHz: Number.isFinite(clock) ? Math.round(clock) : 1500,
      checkedAt: Date.now(),
      error: null,
    };
  }
}
