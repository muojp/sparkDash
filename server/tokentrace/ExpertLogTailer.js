import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_LINE = 64 * 1024;
const MAX_CATCHUP = 256 * 1024;

export function findLatestIndex(directory, rank = 0) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const marker = `-r${rank}-`;
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("experts-") &&
      entry.name.includes(marker) && entry.name.endsWith(".idx.jsonl"))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file))[0]?.file || null;
}

function defaultSubscriberLock(_indexPath, indexFd) {
  // fd 3 is a dup of Node's read-only index descriptor and therefore shares
  // its open-file-description. flock exits immediately after applying the
  // lock; the lock remains on Node's descriptor until rotation/stop closes it.
  return spawn("flock", ["--shared", "3"], {
    stdio: ["ignore", "ignore", "ignore", indexFd],
  });
}

function parseJson(line) {
  if (!line || line.length > MAX_LINE) return null;
  try { return JSON.parse(line); } catch { return null; }
}

export class ExpertLogTailer {
  constructor({
    directory,
    rank = 0,
    pollIntervalMs = 50,
    scanIntervalMs = 500,
    maxRows = 8,
    onEvent = () => {},
    onState = () => {},
    spawnSubscriberLock = defaultSubscriberLock,
  }) {
    this.directory = directory;
    this.rank = rank;
    this.pollIntervalMs = pollIntervalMs;
    this.scanIntervalMs = scanIntervalMs;
    this.maxRows = Math.max(1, Math.min(12, maxRows));
    this.onEvent = onEvent;
    this.onState = onState;
    this.spawnSubscriberLock = spawnSubscriberLock;
    this.timer = null;
    this.running = false;
    this.lastScan = 0;
    this.idxPath = null;
    this.idxFd = null;
    this.dataFd = null;
    this.offset = 0;
    this.buffer = "";
    this.meta = null;
    this.pending = [];
    this.lockChild = null;
    this.stateKey = "";
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._tick();
    this.timer = setInterval(() => this._tick(), this.pollIntervalMs);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    this._closeFiles();
    this._state(false, null);
  }

  _state(connected, error) {
    const value = { connected, error: error || null, path: this.idxPath };
    const key = JSON.stringify(value);
    if (key === this.stateKey) return;
    this.stateKey = key;
    this.onState(value);
  }

  _tick() {
    if (!this.running) return;
    try {
      const now = Date.now();
      if (!this.idxPath || now - this.lastScan >= this.scanIntervalMs) {
        this.lastScan = now;
        const latest = findLatestIndex(this.directory, this.rank);
        if (latest && latest !== this.idxPath) this._open(latest);
        else if (!latest && !this.idxPath) this._state(false, `waiting for expert log in ${this.directory}`);
      }
      if (!this.idxFd) return;
      this._ensureLock();
      this._readAppended();
      this._drainPending();
    } catch (err) {
      const message = err?.message || String(err);
      this._closeFiles();
      this._state(false, message);
    }
  }

  _open(indexPath) {
    this._closeFiles();
    const dataPath = indexPath.slice(0, -".idx.jsonl".length) + ".u8";
    const idxFd = fs.openSync(indexPath, "r");
    let dataFd;
    try {
      dataFd = fs.openSync(dataPath, "r");
      const stat = fs.fstatSync(idxFd);
      const firstSize = Math.min(stat.size, MAX_LINE);
      const first = Buffer.alloc(firstSize);
      fs.readSync(idxFd, first, 0, first.length, 0);
      const firstNl = first.indexOf(10);
      const meta = parseJson(first.subarray(0, firstNl < 0 ? first.length : firstNl).toString("utf8"));
      if (meta?.type !== "meta") throw new Error(`invalid TokenTrace metadata: ${indexPath}`);
      this.idxPath = indexPath;
      this.idxFd = idxFd;
      this.dataFd = dataFd;
      this.meta = meta;
      this.offset = stat.size;
      this.buffer = "";
      this.pending = [];
      const latest = this._lastCompleteRecord(stat.size);
      if (latest) this.pending.push(latest);
      this._ensureLock();
      this._state(true, null);
      this._drainPending();
    } catch (err) {
      try { fs.closeSync(idxFd); } catch { /* already closed */ }
      if (dataFd != null) try { fs.closeSync(dataFd); } catch { /* already closed */ }
      throw err;
    }
  }

  _lastCompleteRecord(size) {
    if (!size) return null;
    const start = Math.max(0, size - MAX_CATCHUP);
    const tail = Buffer.alloc(size - start);
    fs.readSync(this.idxFd, tail, 0, tail.length, start);
    let text = tail.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const value = parseJson(lines[i]);
      if (Number.isInteger(value?.step)) return value;
    }
    return null;
  }

  _readAppended() {
    const size = fs.fstatSync(this.idxFd).size;
    if (size < this.offset) {
      const current = this.idxPath;
      this.idxPath = null;
      this._open(current);
      return;
    }
    if (size === this.offset) return;
    const delta = size - this.offset;
    if (delta > MAX_CATCHUP) {
      const latest = this._lastCompleteRecord(size);
      this.offset = size;
      this.buffer = "";
      if (latest) this.pending = [latest];
      return;
    }
    const chunk = Buffer.alloc(delta);
    const read = fs.readSync(this.idxFd, chunk, 0, chunk.length, this.offset);
    this.offset += read;
    this.buffer += chunk.subarray(0, read).toString("utf8");
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const value = parseJson(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
      if (Number.isInteger(value?.step)) this.pending.push(value);
    }
    if (this.pending.length > 64) this.pending = this.pending.slice(-64);
  }

  _drainPending() {
    while (this.pending.length) {
      if (!this._emitRecord(this.pending[0])) break;
      this.pending.shift();
    }
  }

  _emitRecord(rec) {
    const layers = Number(this.meta?.layers);
    const topk = Number(this.meta?.topk);
    const n = Number(rec.n);
    const off = Number(rec.off);
    const len = Number(rec.len);
    if (!Number.isInteger(layers) || layers < 1 || layers > 128 ||
        !Number.isInteger(topk) || topk < 1 || topk > 16 ||
        !Number.isInteger(n) || n < 1 ||
        !Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(len) || len !== n * layers * topk ||
        !Array.isArray(rec.req) || !Array.isArray(rec.sched)) return true;
    if (fs.fstatSync(this.dataFd).size < off + len) return false;
    const stride = layers * topk;
    let cursor = 0;
    for (let i = 0; i < rec.req.length; i += 1) {
      const totalRows = Math.max(0, Number(rec.sched[i]) || 0);
      const available = Math.max(0, Math.min(totalRows, n - cursor));
      const rows = Math.min(available, this.maxRows);
      if (rows > 0) {
        const routing = Buffer.alloc(rows * stride);
        const read = fs.readSync(this.dataFd, routing, 0, routing.length, off + cursor * stride);
        if (read !== routing.length) return false;
        this.onEvent({
          type: "expert_step",
          t: rec.t,
          host: this.meta.host,
          rank: this.meta.rank,
          step: rec.step,
          req: rec.req[i],
          layers,
          topk,
          rows,
          rowsTotal: available,
          truncated: rows < available,
          position: rec.pos?.[i],
          draft: rec.draft == null ? null : rec.draft?.[i],
          sampled: rec.sampled?.[i],
          rejected: rec.rejected?.[i],
          tokenIds: Array.isArray(rec.tokens?.[i])
            ? rec.tokens[i].slice(0, 12).map(Number).filter((token) => Number.isInteger(token) && token >= 0)
            : [],
          routing: routing.toString("base64"),
        });
      }
      cursor += totalRows;
    }
    return true;
  }

  _ensureLock() {
    if (this.lockChild || !this.idxPath) return;
    const child = this.spawnSubscriberLock(this.idxPath, this.idxFd);
    this.lockChild = child;
    child.once?.("error", () => { if (this.lockChild === child) this.lockChild = null; });
    child.once?.("exit", (code) => {
      // A successful short-lived child leaves the lock on idxFd. Keep the
      // child object as a truthy marker so polling does not re-run flock.
      if (code !== 0 && this.lockChild === child) this.lockChild = null;
    });
  }

  _closeFiles() {
    if (this.lockChild) {
      this.lockChild.removeAllListeners?.();
      this.lockChild.kill?.("SIGTERM");
      this.lockChild = null;
    }
    if (this.idxFd != null) try { fs.closeSync(this.idxFd); } catch { /* best effort */ }
    if (this.dataFd != null) try { fs.closeSync(this.dataFd); } catch { /* best effort */ }
    this.idxFd = null;
    this.dataFd = null;
    this.idxPath = null;
    this.meta = null;
    this.offset = 0;
    this.buffer = "";
    this.pending = [];
  }
}
