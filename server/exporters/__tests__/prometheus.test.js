import test from "node:test";
import assert from "node:assert/strict";
import { renderPrometheus, createPrometheusHandler } from "../prometheus.js";
import { flattenSnapshot } from "../flatten.js";

const samples = [
  { name: "up", type: "gauge", help: "x", labels: { spark: "s1", name: "Spark 1", kind: "spark" }, value: 1 },
  { name: "gpu_usage_percent", type: "gauge", help: "x", labels: { spark: "s1", name: "Spark 1", kind: "spark" }, value: 42.5 },
  { name: "gpu_usage_percent", type: "gauge", help: "x", labels: { spark: "s2", name: 'Weird "name"\\', kind: "host" }, value: 0 },
  { name: "llm_output_tokens_total", type: "counter", help: "x", labels: { spark: "s1", name: "Spark 1", kind: "spark", port: "8888" }, value: 123 },
];

test("renders one HELP/TYPE per family, grouped, with escaped labels", () => {
  const text = renderPrometheus(samples);
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("# HELP sparkdash_gpu_usage_percent")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("# TYPE sparkdash_gpu_usage_percent gauge")).length, 1);
  assert.ok(lines.includes('sparkdash_up{spark="s1",name="Spark 1",kind="spark"} 1'));
  assert.ok(lines.includes('sparkdash_gpu_usage_percent{spark="s1",name="Spark 1",kind="spark"} 42.5'));
  assert.ok(lines.includes('sparkdash_gpu_usage_percent{spark="s2",name="Weird \\"name\\"\\\\",kind="host"} 0'));
  assert.ok(lines.includes("# TYPE sparkdash_llm_output_tokens_total counter"));
  assert.ok(text.endsWith("\n"));
  // TYPE header must precede its samples
  const typeIdx = lines.indexOf("# TYPE sparkdash_gpu_usage_percent gauge");
  const firstSample = lines.findIndex((l) => l.startsWith("sparkdash_gpu_usage_percent{"));
  assert.ok(typeIdx < firstSample);
});

test("custom prefix", () => {
  const text = renderPrometheus(samples.slice(0, 1), { prefix: "dgx_" });
  assert.ok(text.includes("dgx_up{"));
  assert.ok(!text.includes("sparkdash_"));
});

test("HELP text comes from the catalog for real metric names", () => {
  const out = flattenSnapshot({ id: "a", name: "A", online: true, metrics: { cpu: { usage: 1, temperature: 2, draw: 3, tdp: 4 } } });
  const text = renderPrometheus(out);
  assert.ok(text.includes("# HELP sparkdash_cpu_usage_percent CPU utilization 0-100"));
});

test("express handler sets content-type and body", async () => {
  const handler = createPrometheusHandler(() => [
    { id: "a", name: "A", online: true, metrics: {} },
  ]);
  const headers = {};
  let body = "";
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    end: (b) => { body = b; },
    status: () => res,
    type: () => res,
    send: (b) => { body = b; },
  };
  handler({}, res);
  assert.match(headers["Content-Type"], /^text\/plain; version=0\.0\.4/);
  assert.ok(body.includes('sparkdash_up{spark="a",name="A",kind="spark"} 1'));
});
