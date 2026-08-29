/**
 * Prometheus exporter — renders flattened samples in the text exposition
 * format (0.0.4) and serves them on GET /metrics. Pull model: point a
 * Prometheus `scrape_config` at http://<sparkdash>:5555/metrics.
 *
 * No prom-client dependency on purpose: the metric set is small and fully
 * described by exporters/flatten.js, so a ~60-line renderer keeps the
 * runtime image lean and the format under our control.
 */
import { flattenSnapshots, METRICS } from "./flatten.js";

/** Escape a label value per the exposition format. */
function escapeLabel(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Escape HELP text (backslash + newline only). */
function escapeHelp(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatValue(v) {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

/**
 * Render samples as Prometheus text. Samples are grouped by metric name so
 * each family has exactly one HELP/TYPE header (required by the format).
 * @param {ReturnType<typeof flattenSnapshots>} samples
 * @param {{ prefix?: string }} [opts]
 */
export function renderPrometheus(samples, opts = {}) {
  const prefix = opts.prefix ?? "sparkdash_";
  /** @type {Map<string, Array<typeof samples[number]>>} */
  const families = new Map();
  for (const s of samples) {
    const list = families.get(s.name);
    if (list) list.push(s);
    else families.set(s.name, [s]);
  }
  const lines = [];
  for (const [name, list] of families) {
    const [type, help] = METRICS[name] || [list[0].type, list[0].help];
    const full = prefix + name;
    lines.push(`# HELP ${full} ${escapeHelp(help)}`);
    lines.push(`# TYPE ${full} ${type}`);
    for (const s of list) {
      const labels = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(",");
      lines.push(`${full}{${labels}} ${formatValue(s.value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Build an Express handler for GET /metrics.
 * @param {() => object[]} getSnapshots  returns SparkMonitor.snapshot()[] in registry order
 * @param {{ prefix?: string }} [opts]
 */
export function createPrometheusHandler(getSnapshots, opts = {}) {
  return (_req, res) => {
    let body;
    try {
      body = renderPrometheus(flattenSnapshots(getSnapshots()), opts);
    } catch (err) {
      console.error("[exporter:prometheus] render failed:", err.message);
      return res.status(500).type("text/plain").send("render failed\n");
    }
    // setHeader/end (not res.set/send): Express would re-serialize the type
    // and move charset ahead of version; keep the canonical exposition value.
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  };
}
