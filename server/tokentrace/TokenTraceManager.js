import os from "node:os";
import path from "node:path";
import { ExpertLogTailer } from "./ExpertLogTailer.js";

function roleOf(spark) {
  if (["head", "worker", "standalone"].includes(spark?.role)) return spark.role;
  return spark?.workerNode ? "worker" : "standalone";
}

export function resolveTokenTracePair(sparks, requestedHeadId = "") {
  const units = sparks || [];
  const workersAll = units.filter((s) => roleOf(s) === "worker");
  const explicitHeads = units.filter((s) => roleOf(s) === "head");
  const referencedIds = new Set(workersAll.map((s) => s.workerHeadId).filter(Boolean));
  const inferredHeads = units.filter((s) => referencedIds.has(s.id));
  const heads = (explicitHeads.length ? explicitHeads : inferredHeads).filter(
    (s) => !requestedHeadId || s.id === requestedHeadId
  );
  if (heads.length !== 1) {
    return { pair: null, reason: `expected one head; found ${heads.length}` };
  }
  const head = heads[0];
  let workers = workersAll.filter(
    (s) => roleOf(s) === "worker" && (!s.workerHeadId || s.workerHeadId === head.id)
  );
  const linked = workers.filter((s) => s.workerHeadId === head.id);
  if (linked.length) workers = linked;
  if (workers.length !== 1) {
    return { pair: null, reason: `head ${head.id} expected one worker; found ${workers.length}` };
  }
  const worker = workers[0];
  return {
    pair: {
      head,
      worker,
      public: {
        head: { id: head.id, name: head.name },
        worker: { id: worker.id, name: worker.name },
      },
    },
    reason: null,
  };
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const BYTES_PER_MIB = 1024 * 1024;

export function machineView(snapshot) {
  if (!snapshot) return null;
  const gpu = snapshot.metrics?.gpu;
  const swap = snapshot.metrics?.ram?.swap;
  const ports = snapshot.metrics?.network?.rdma || [];
  const storage = (snapshot.metrics?.storage || []).filter((d) => !d.disabled);
  return {
    id: snapshot.id,
    name: snapshot.name,
    online: Boolean(snapshot.online),
    gpu: gpu ? {
      temperature: finite(gpu.temperature),
      usage: finite(gpu.usage),
      power: finite(gpu.power?.draw),
      systemPower: finite(gpu.power?.systemDraw),
      // GB10 reports utilization.memory=0 even at 95% SM utilization: NVML
      // does not instrument its unified LPDDR5X controller. Treat zero as
      // unavailable instead of presenting a convincing but false 0%.
      memoryController: (finite(gpu.memoryControllerUtil) || 0) > 0
        ? finite(gpu.memoryControllerUtil)
        : null,
    } : null,
    rdma: {
      rxGbps: ports.reduce((n, p) => n + (finite(p.rxSpeed) || 0), 0) * 8 / 1e9,
      txGbps: ports.reduce((n, p) => n + (finite(p.txSpeed) || 0), 0) * 8 / 1e9,
      active: ports.some((p) => p.active),
    },
    paging: swap ? {
      swapUsedMB: finite(swap.used),
      swapTotalMB: finite(swap.total),
      swapPercent: finite(swap.percentage),
      swapInPages: finite(swap.inPages),
      swapInPagesPerSec: finite(swap.inPagesPerSec),
      majorFaults: finite(swap.majorFaults),
      majorFaultsPerSec: finite(swap.majorFaultsPerSec),
    } : null,
    // SystemCollector rates are bytes/s. TokenTrace labels these MiB/s.
    storageReadMBps: storage.reduce((n, d) => n + (finite(d.readSpeed) || 0), 0) / BYTES_PER_MIB,
    storageWriteMBps: storage.reduce((n, d) => n + (finite(d.writeSpeed) || 0), 0) / BYTES_PER_MIB,
  };
}

function median(values) {
  if (!values.length) return 67;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class TokenTraceManager {
  constructor({
    getSparks,
    getSnapshots,
    createTailer = (options) => new ExpertLogTailer(options),
    demo = /^(1|true|yes|on)$/i.test(process.env.TOKENTRACE_DEMO || ""),
    demoIntervalMs = 90,
    tokenOutputMode = process.env.TOKENTRACE_TOKEN_OUTPUT || "metadata",
    detokenizeUrl = process.env.TOKENTRACE_DETOKENIZE_URL || "http://127.0.0.1:8888/detokenize",
    detokenizeModel = process.env.TOKENTRACE_MODEL || "",
    fetchImpl = globalThis.fetch,
  }) {
    this.getSparks = getSparks;
    this.getSnapshots = getSnapshots;
    this.createTailer = createTailer;
    this.demo = demo;
    this.demoIntervalMs = demoIntervalMs;
    this.tokenOutputMode = tokenOutputMode === "detokenize" ? "detokenize" : "metadata";
    this.detokenizeUrl = detokenizeUrl;
    this.detokenizeModel = detokenizeModel;
    this.fetchImpl = fetchImpl;
    this.tokenTextAvailable = this.tokenOutputMode === "metadata" ? null : false;
    this.tokenTextError = this.tokenOutputMode === "detokenize" && !detokenizeModel
      ? "TOKENTRACE_MODEL is required for detokenize mode"
      : null;
    this.tokenState = new Map();
    this.decodeQueue = Promise.resolve();
    this.clients = new Set();
    this.tailer = null;
    this.demoTimer = null;
    this.connected = false;
    this.lastError = null;
    this.lastByRequest = new Map();
    this.durations = [];
    this.demoStep = 0;
  }

  mapping() {
    const result = resolveTokenTracePair(this.getSparks(), process.env.TOKENTRACE_HEAD_ID || "");
    if (!this.demo && result.pair && result.pair.head.isLocal !== true) {
      return { pair: null, reason: `TokenTrace head ${result.pair.head.id} must be configured as Local` };
    }
    return result;
  }

  status() {
    const { pair, reason } = this.mapping();
    return {
      type: "tokentrace_status",
      available: Boolean(pair),
      connected: this.connected,
      source: this.demo ? "demo" : "local-files",
      mapping: pair?.public || null,
      reason: reason || this.lastError,
      tokenOutput: {
        mode: this.tokenOutputMode,
        available: this.tokenTextAvailable,
        reason: this.tokenTextError,
      },
    };
  }

  subscribe(ws) {
    this.clients.add(ws);
    this._sendOne(ws, this.status());
    if (this.clients.size === 1) this.start();
  }

  unsubscribe(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) this.stop();
  }

  start() {
    if (this.tailer || this.demoTimer) return;
    const { pair, reason } = this.mapping();
    if (!pair) {
      this.lastError = reason;
      this._broadcast(this.status());
      return;
    }
    this.lastError = null;
    if (this.demo) {
      this.connected = true;
      this._broadcast(this.status());
      this.demoTimer = setInterval(() => this._demoStep(), this.demoIntervalMs);
      this._demoStep();
      return;
    }
    const user = pair.head.ssh?.user || os.userInfo().username;
    const hostHome = user === "root" ? ["root"] : ["home", user];
    const directory = process.env.TOKENTRACE_DIR || (process.env.HOST_ROOT_PATH
      ? path.join(process.env.HOST_ROOT_PATH, ...hostHome, ".cache", "huggingface", "tokentrace")
      : path.join(os.homedir(), ".cache", "huggingface", "tokentrace"));
    this.tailer = this.createTailer({
      directory,
      onEvent: (event) => this._ingest(event),
      onState: ({ connected, error }) => {
        this.connected = connected;
        this.lastError = error;
        this._broadcast(this.status());
      },
    });
    this.tailer.start();
  }

  stop() {
    clearInterval(this.demoTimer);
    this.demoTimer = null;
    this.tailer?.stop();
    this.tailer = null;
    this.connected = false;
  }

  close() {
    this.clients.clear();
    this.stop();
  }

  _ingest(event) {
    if (this.tokenOutputMode !== "detokenize" || !event?.tokenIds?.length || !this.detokenizeModel) {
      this._accept(event);
      return;
    }
    this.decodeQueue = this.decodeQueue.then(async () => {
      const enriched = await this._withTokenText(event);
      this._accept(enriched);
    }).catch((error) => {
      this.tokenTextAvailable = false;
      this.tokenTextError = error?.message || String(error);
      this._accept(event);
      this._broadcast(this.status());
    });
  }

  async _withTokenText(event) {
    const previous = this.tokenState.get(event.req) || { ids: [], text: "" };
    let ids = [...previous.ids, ...event.tokenIds];
    let previousText = previous.text;
    // Bound request state. A reset only affects the first visible chunk after
    // the boundary; subsequent deltas are exact again.
    if (ids.length > 4096) {
      ids = ids.slice(-256);
      previousText = "";
    }
    const response = await this.fetchImpl(this.detokenizeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.detokenizeModel, tokens: ids }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`detokenize HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body?.prompt !== "string") throw new Error("detokenize response omitted prompt");
    const fullText = body.prompt;
    const tokenText = previousText && fullText.startsWith(previousText)
      ? fullText.slice(previousText.length)
      : fullText;
    this.tokenState.set(event.req, { ids, text: fullText });
    const changed = !this.tokenTextAvailable || this.tokenTextError;
    this.tokenTextAvailable = true;
    this.tokenTextError = null;
    if (changed) this._broadcast(this.status());
    return { ...event, tokenText };
  }

  refreshMapping() {
    if (!this.clients.size) return;
    this.stop();
    this.start();
  }

  _accept(event) {
    if (event?.type !== "expert_step" || typeof event.routing !== "string") return;
    const layers = Number(event.layers);
    const topk = Number(event.topk);
    const rows = Number(event.rows);
    if (!Number.isInteger(layers) || layers < 1 || layers > 128 ||
        !Number.isInteger(topk) || topk < 1 || topk > 16 ||
        !Number.isInteger(rows) || rows < 1 || rows > 12) return;
    const decodedBytes = Buffer.byteLength(event.routing, "base64");
    if (decodedBytes !== layers * topk * rows) return;
    const t = finite(event.t);
    if (t == null) return;
    const prev = this.lastByRequest.get(event.req);
    const durationMs = prev == null ? null : Math.max(0, Math.min(10_000, (t - prev) * 1000));
    this.lastByRequest.set(event.req, t);
    if (durationMs != null && durationMs > 5) {
      this.durations.push(durationMs);
      if (this.durations.length > 120) this.durations.shift();
    }
    const baselineMs = median(this.durations);
    let stepClass = "NORMAL";
    if (Number(event.rowsTotal) > 32) stepClass = "PREFILL";
    else if (durationMs != null && durationMs > baselineMs * 1.15) stepClass = "STALL";
    else if (Number(event.sampled) >= 5 && (durationMs == null || durationMs <= baselineMs * 1.1)) stepClass = "FAST";
    const { pair } = this.mapping();
    const byId = new Map(this.getSnapshots().map((s) => [s.id, s]));
    this._broadcast({
      type: "tokentrace_step",
      event: { ...event, durationMs, baselineMs, stepClass },
      machines: pair ? [machineView(byId.get(pair.head.id)), machineView(byId.get(pair.worker.id))].filter(Boolean) : [],
    });
  }

  _demoStep() {
    const sampledPattern = [1, 2, 6, 3, 5, 1, 4];
    const sampled = sampledPattern[this.demoStep % sampledPattern.length];
    const rejected = this.demoStep % 5 === 0 ? 2 : 0;
    const rows = Math.min(8, sampled + rejected);
    const bytes = Buffer.alloc(rows * 43 * 6);
    for (let row = 0; row < rows; row++) {
      for (let layer = 0; layer < 43; layer++) {
        for (let k = 0; k < 6; k++) {
          bytes[(row * 43 + layer) * 6 + k] = (layer * 17 + row * 31 + k * 37 + this.demoStep * 3) % 256;
        }
      }
    }
    this._accept({
      type: "expert_step",
      t: Date.now() / 1000,
      host: "dgx01",
      rank: 0,
      step: this.demoStep,
      req: "live-demo-request",
      layers: 43,
      topk: 6,
      rows,
      rowsTotal: rows,
      truncated: false,
      position: 240 + this.demoStep * sampled,
      draft: rows - 1,
      sampled,
      rejected,
      tokenIds: [],
      tokenText: this.tokenOutputMode === "detokenize"
        ? [" routing", " experts", " choose", " tokens", " efficiently", ".", " live"][this.demoStep % 7]
        : undefined,
      routing: bytes.toString("base64"),
    });
    this.demoStep += 1;
  }

  _sendOne(ws, value) {
    if (ws?.readyState !== 1) return;
    try { ws.send(JSON.stringify(value)); } catch { /* closed concurrently */ }
  }

  _broadcast(value) {
    const payload = JSON.stringify(value);
    for (const ws of this.clients) {
      if (ws?.readyState !== 1 || ws.bufferedAmount > 1_000_000) continue;
      try { ws.send(payload); } catch { /* isolated client failure */ }
    }
  }
}
