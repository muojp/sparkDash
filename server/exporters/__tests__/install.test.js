import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { installExporters } from "../index.js";

const snaps = () => [{ id: "a", name: "A", kind: "spark", online: true, metrics: { cpu: { usage: 5, temperature: 1, draw: 1, tdp: 65 } } }];

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("GET /metrics is served before a SPA catch-all registered later (registration order)", async () => {
  const app = express();
  const ex = installExporters({
    app,
    getSnapshots: snaps,
    cfg: { prefix: "sparkdash_", prometheusEnabled: true, prometheusPath: "/metrics", influxUrl: "" },
  });
  // Same shape as server/index.js: SPA fallback registered AFTER exporters.
  app.get("*splat", (_req, res) => res.status(200).type("html").send("<html>spa</html>"));
  await withServer(app, async (base) => {
    const r = await fetch(`${base}/metrics`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/plain; version=0\.0\.4/);
    const body = await r.text();
    assert.ok(body.includes('sparkdash_cpu_usage_percent{spark="a",name="A",kind="spark"} 5'));
    const st = await fetch(`${base}/api/exporters`);
    const j = await st.json();
    assert.deepEqual(j, { prometheus: { path: "/metrics" }, influx: null });
    const spa = await fetch(`${base}/anything`);
    assert.ok((await spa.text()).includes("spa"));
  });
  assert.equal(ex.prometheus, true);
  assert.equal(ex.influx, null);
  ex.stop();
});

test("PROMETHEUS_METRICS=false disables /metrics; custom path honoured", async () => {
  const app = express();
  installExporters({ app, getSnapshots: snaps, cfg: { prefix: "x_", prometheusEnabled: false, prometheusPath: "/metrics", influxUrl: "" } });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/metrics`)).status, 404);
    assert.equal((await fetch(`${base}/api/exporters`)).status, 200);
  });
  const app2 = express();
  installExporters({ app: app2, getSnapshots: snaps, cfg: { prefix: "x_", prometheusEnabled: true, prometheusPath: "/internal/prom", influxUrl: "" } });
  await withServer(app2, async (base) => {
    assert.equal((await fetch(`${base}/metrics`)).status, 404);
    const r = await fetch(`${base}/internal/prom`);
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes("x_up{"));
  });
});

test("INFLUX_URL without bucket → push disabled, no crash", async () => {
  const app = express();
  const ex = installExporters({
    app, getSnapshots: snaps,
    cfg: { prefix: "sparkdash_", prometheusEnabled: true, prometheusPath: "/metrics", influxUrl: "http://127.0.0.1:1", influxBucket: "" },
  });
  assert.equal(ex.influx, null);
  ex.stop();
});

test("INFLUX_URL + bucket → pusher started and reported by /api/exporters; stop() clears the timer", async () => {
  const app = express();
  const ex = installExporters({
    app, getSnapshots: snaps,
    cfg: {
      prefix: "sparkdash_", prometheusEnabled: false, prometheusPath: "/metrics",
      influxUrl: "http://127.0.0.1:1/", influxOrg: "lab", influxBucket: "b", influxToken: "t", influxIntervalMs: 60000, influxTimeoutMs: 500,
    },
  });
  assert.ok(ex.influx);
  assert.equal(ex.influx.url, "http://127.0.0.1:1");
  assert.equal(ex.influx.intervalMs, 60000);
  await withServer(app, async (base) => {
    const j = await (await fetch(`${base}/api/exporters`)).json();
    assert.equal(j.prometheus, null);
    assert.equal(j.influx.bucket, "b");
    assert.equal(j.influx.org, "lab");
    assert.ok("last" in j.influx);
  });
  // The first push fires immediately against a closed port — must not throw.
  await new Promise((r) => setTimeout(r, 200));
  ex.stop();
  assert.equal(ex.influx._timer, null);
});
