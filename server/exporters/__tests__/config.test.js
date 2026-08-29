/** config.js EXPORTERS / DEMO_MODE env parsing — evaluated at import, so spawn fresh processes. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function load(env) {
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", 'import("./server/config.js").then(m => console.log(JSON.stringify({ EXPORTERS: m.EXPORTERS, DEMO_MODE: m.DEMO_MODE, CLOCK_CAP_MONITORING: m.CLOCK_CAP_MONITORING, POLL_INTERVAL_CLOCK_CAP: m.POLL_INTERVAL_CLOCK_CAP })))'],
    { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }
  );
  return JSON.parse(out);
}

test("defaults: prometheus on at /metrics, influx off, demo off", () => {
  const { EXPORTERS, DEMO_MODE } = load({});
  assert.equal(EXPORTERS.prometheusEnabled, true);
  assert.equal(EXPORTERS.prometheusPath, "/metrics");
  assert.equal(EXPORTERS.prefix, "sparkdash_");
  assert.equal(EXPORTERS.influxUrl, "");
  assert.equal(EXPORTERS.influxIntervalMs, 10000);
  assert.equal(EXPORTERS.influxTimeoutMs, 5000);
  assert.equal(DEMO_MODE, false);
});

test("clock cap monitoring is off by default, 60 s cadence, env-overridable", () => {
  const d = load({});
  assert.equal(d.CLOCK_CAP_MONITORING, false);
  assert.equal(d.POLL_INTERVAL_CLOCK_CAP, 60000);
  const e = load({ CLOCK_CAP_MONITORING: "1", POLL_INTERVAL_CLOCK_CAP: "15000" });
  assert.equal(e.CLOCK_CAP_MONITORING, true);
  assert.equal(e.POLL_INTERVAL_CLOCK_CAP, 15000);
});

test("boolean env parsing accepts 0/false/no/off (case-insensitive) and treats anything else as true", () => {
  for (const v of ["0", "false", "FALSE", "no", "off"]) {
    assert.equal(load({ PROMETHEUS_METRICS: v }).EXPORTERS.prometheusEnabled, false, v);
    assert.equal(load({ SPARKDASH_DEMO: v }).DEMO_MODE, false, v);
  }
  for (const v of ["1", "true", "yes", "on"]) {
    assert.equal(load({ PROMETHEUS_METRICS: v }).EXPORTERS.prometheusEnabled, true, v);
    assert.equal(load({ SPARKDASH_DEMO: v }).DEMO_MODE, true, v);
  }
});

test("influx settings are read from INFLUX_* env", () => {
  const { EXPORTERS } = load({
    INFLUX_URL: "http://influx:8086", INFLUX_ORG: "lab", INFLUX_BUCKET: "sd", INFLUX_TOKEN: "t",
    INFLUX_INTERVAL_MS: "2500", INFLUX_TIMEOUT_MS: "1000", METRICS_PREFIX: "dgx_", PROMETHEUS_METRICS_PATH: "/prom",
  });
  assert.equal(EXPORTERS.influxUrl, "http://influx:8086");
  assert.equal(EXPORTERS.influxOrg, "lab");
  assert.equal(EXPORTERS.influxBucket, "sd");
  assert.equal(EXPORTERS.influxToken, "t");
  assert.equal(EXPORTERS.influxIntervalMs, 2500);
  assert.equal(EXPORTERS.influxTimeoutMs, 1000);
  assert.equal(EXPORTERS.prefix, "dgx_");
  assert.equal(EXPORTERS.prometheusPath, "/prom");
});
