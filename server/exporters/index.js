/**
 * Exporter wiring — one entry point for index.js.
 *
 *   installExporters({ app, getSnapshots })
 *     → { prometheus: boolean, influx: InfluxPusher | null, stop() }
 *
 * Configuration is env-only (see config.js EXPORTERS): the export targets
 * are infrastructure, not per-user UI state, and env keeps tokens out of
 * settings.json / the unauthenticated settings API.
 */
import { EXPORTERS } from "../config.js";
import { createPrometheusHandler } from "./prometheus.js";
import { InfluxPusher } from "./influx.js";

export function installExporters({ app, getSnapshots, cfg = EXPORTERS }) {
  let prometheus = false;
  if (cfg.prometheusEnabled) {
    app.get(cfg.prometheusPath, createPrometheusHandler(getSnapshots, { prefix: cfg.prefix }));
    prometheus = true;
    console.log(`[exporter:prometheus] serving GET ${cfg.prometheusPath}`);
  }

  /** @type {InfluxPusher | null} */
  let influx = null;
  if (cfg.influxUrl) {
    if (!cfg.influxBucket) {
      console.error("[exporter:influx] INFLUX_URL is set but INFLUX_BUCKET is missing — push disabled");
    } else {
      influx = new InfluxPusher({
        getSnapshots,
        url: cfg.influxUrl,
        org: cfg.influxOrg,
        bucket: cfg.influxBucket,
        token: cfg.influxToken,
        intervalMs: cfg.influxIntervalMs,
        timeoutMs: cfg.influxTimeoutMs,
        prefix: cfg.prefix,
      });
      influx.start();
    }
  }

  // Tiny status endpoint so a deployment can verify the push side without
  // reading logs (Prometheus is self-evident: curl /metrics).
  app.get("/api/exporters", (_req, res) => {
    res.json({
      prometheus: prometheus ? { path: cfg.prometheusPath } : null,
      influx: influx
        ? { url: influx.url, bucket: influx.bucket, org: influx.org, intervalMs: influx.intervalMs, last: influx.lastResult }
        : null,
    });
  });

  return {
    prometheus,
    influx,
    stop() {
      influx?.stop();
    },
  };
}
