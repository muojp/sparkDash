/**
 * InfluxDB exporter — push model. Every `intervalMs` the current snapshots
 * are flattened, encoded as InfluxDB line protocol and POSTed to the v2
 * write API (`/api/v2/write`). Works with InfluxDB 2.x / 3.x (v2-compatible
 * write endpoint) and with InfluxDB 1.8 via `/api/v2/write` compatibility
 * (use `org=""`, `bucket="db/rp"`, token="user:pass").
 *
 * Line layout — one point per unit per (measurement, extra-label set):
 *   sparkdash_gpu,spark=s1,name=Spark-1,kind=spark temperature_celsius=55,usage_percent=12 <ts>
 *   sparkdash_llm,spark=s1,name=Spark-1,kind=spark,port=8888,backend=vllm,model=… generation_tokens_per_second=…
 *
 * i.e. the flatten metric name is split at its first component into the
 * measurement (`sparkdash_<domain>`) and the field (`<rest>`). Series labels
 * become tags. This keeps Grafana queries natural (`from(bucket) |> filter(_measurement == "sparkdash_gpu")`).
 */
import { flattenSnapshots } from "./flatten.js";

/** Domain = first token of the metric name; a few multi-token domains are kept whole. */
const MULTI_TOKEN_DOMAINS = ["unified_memory", "system_power"];
/** Unit-level metrics live in the `unit` measurement (no domain prefix of their own). */
const UNIT_LEVEL = new Set(["up", "uptime_seconds"]);

/** "gpu_temperature_celsius" → ["gpu", "temperature_celsius"]; "up" → ["unit", "up"]. */
export function splitMetricName(name) {
  if (UNIT_LEVEL.has(name)) return ["unit", name];
  for (const d of MULTI_TOKEN_DOMAINS) {
    if (name.startsWith(d + "_")) return [d, name.slice(d.length + 1)];
  }
  const i = name.indexOf("_");
  if (i < 0) return ["unit", name];
  return [name.slice(0, i), name.slice(i + 1)];
}

/** Escape a tag key/value or field key per line protocol. */
function escTag(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/=/g, "\\=").replace(/ /g, "\\ ").replace(/\n/g, " ");
}
function escMeasurement(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/ /g, "\\ ");
}

/**
 * Encode samples as line protocol.
 * @param {ReturnType<typeof flattenSnapshots>} samples
 * @param {{ prefix?: string, timestampMs?: number }} [opts]
 * @returns {string} newline-terminated lines ("" when no samples)
 */
export function renderLineProtocol(samples, opts = {}) {
  const prefix = opts.prefix ?? "sparkdash_";
  const ts = opts.timestampMs ?? Date.now();
  /** @type {Map<string, {measurement:string, tags:string, fields:Map<string,number>}>} */
  const points = new Map();
  for (const s of samples) {
    // Prometheus-style `*_info` metrics (value 1, facts in labels) have no
    // InfluxDB equivalent worth storing — the same facts already ride along
    // as tags on the other points of that unit. Skip them.
    if (s.name.endsWith("_info")) continue;
    const [domain, fieldName] = splitMetricName(s.name);
    const meas = prefix + domain;
    const tags = Object.keys(s.labels)
      .sort()
      .filter((k) => s.labels[k] !== "")
      .map((k) => `${escTag(k)}=${escTag(s.labels[k])}`)
      .join(",");
    const key = meas + "|" + tags;
    let p = points.get(key);
    if (!p) {
      p = { measurement: meas, tags, fields: new Map() };
      points.set(key, p);
    }
    p.fields.set(fieldName, s.value);
  }
  const lines = [];
  for (const p of points.values()) {
    if (p.fields.size === 0) continue;
    // Always write floats: a gauge that happens to land on an integer value
    // for one tick must not flip the stored field type (InfluxDB rejects the
    // whole write with "field type conflict" once a field has a type).
    const fields = Array.from(p.fields)
      .map(([k, v]) => `${escTag(k)}=${Number.isInteger(v) ? v.toFixed(1) : v}`)
      .join(",");
    const head = p.tags ? `${escMeasurement(p.measurement)},${p.tags}` : escMeasurement(p.measurement);
    lines.push(`${head} ${fields} ${ts}`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Periodic pusher. Construct with options, call start(); stop() on shutdown.
 * Failures are logged (rate-limited) and never throw into the caller.
 */
export class InfluxPusher {
  /**
   * @param {object} o
   * @param {() => object[]} o.getSnapshots
   * @param {string} o.url        e.g. http://influxdb:8086
   * @param {string} o.org
   * @param {string} o.bucket
   * @param {string} [o.token]
   * @param {number} [o.intervalMs=10000]
   * @param {number} [o.timeoutMs=5000]
   * @param {string} [o.prefix="sparkdash_"]
   * @param {typeof fetch} [o.fetchImpl]  injectable for tests
   */
  constructor(o) {
    this.getSnapshots = o.getSnapshots;
    this.url = String(o.url).replace(/\/+$/, "");
    this.org = o.org ?? "";
    this.bucket = o.bucket;
    this.token = o.token ?? "";
    this.intervalMs = Math.max(1000, Number(o.intervalMs) || 10000);
    this.timeoutMs = Math.max(500, Number(o.timeoutMs) || 5000);
    this.prefix = o.prefix ?? "sparkdash_";
    this._fetch = o.fetchImpl ?? globalThis.fetch;
    this._timer = null;
    this._inflight = false;
    this._consecutiveErrors = 0;
    /** @type {{ ok: boolean, at: number, status?: number, error?: string, lines?: number }} */
    this.lastResult = { ok: false, at: 0 };
  }

  get writeUrl() {
    const q = new URLSearchParams({ org: this.org, bucket: this.bucket, precision: "ms" });
    return `${this.url}/api/v2/write?${q}`;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => void this.pushOnce(), this.intervalMs);
    this._timer.unref?.();
    void this.pushOnce();
    console.log(
      `[exporter:influx] pushing to ${this.url} bucket=${this.bucket} org=${this.org || "(none)"} every ${this.intervalMs}ms`
    );
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** One push cycle. Resolves to the result record (never rejects). */
  async pushOnce() {
    if (this._inflight) return this.lastResult;
    this._inflight = true;
    const at = Date.now();
    try {
      const body = renderLineProtocol(flattenSnapshots(this.getSnapshots()), {
        prefix: this.prefix,
        timestampMs: at,
      });
      const lines = body ? body.split("\n").length - 1 : 0;
      if (!body) {
        this.lastResult = { ok: true, at, lines: 0 };
        return this.lastResult;
      }
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res;
      try {
        res = await this._fetch(this.writeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...(this.token ? { Authorization: `Token ${this.token}` } : {}),
          },
          body,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(to);
      }
      if (res.status === 204 || res.ok) {
        if (this._consecutiveErrors > 0) console.log("[exporter:influx] write recovered");
        this._consecutiveErrors = 0;
        this.lastResult = { ok: true, at, status: res.status, lines };
      } else {
        const text = await res.text().catch(() => "");
        this._noteError(`HTTP ${res.status} ${text.slice(0, 200)}`);
        this.lastResult = { ok: false, at, status: res.status, error: text.slice(0, 200), lines };
      }
    } catch (err) {
      const msg = err?.name === "AbortError" ? `timeout after ${this.timeoutMs}ms` : err.message;
      this._noteError(msg);
      this.lastResult = { ok: false, at, error: msg };
    } finally {
      this._inflight = false;
    }
    return this.lastResult;
  }

  /** Log the first error and then every 30th so a dead Influx doesn't flood the log. */
  _noteError(msg) {
    this._consecutiveErrors += 1;
    if (this._consecutiveErrors === 1 || this._consecutiveErrors % 30 === 0) {
      console.error(
        `[exporter:influx] write failed (${this._consecutiveErrors}x): ${msg}`
      );
    }
  }
}
