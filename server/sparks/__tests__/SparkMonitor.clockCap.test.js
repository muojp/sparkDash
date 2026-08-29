/** Clock-cap polling in SparkMonitor (opt-in via CLOCK_CAP_MONITORING). Demo mode so no SSH. */
import test from "node:test";
import assert from "node:assert/strict";
process.env.SPARKDASH_DEMO = "1";
process.env.CLOCK_CAP_MONITORING = "1";
const { SparkMonitor } = await import("../SparkMonitor.js");
const { flattenSnapshot } = await import("../../exporters/flatten.js");

const cfg = () => ({ id: "cc-1", name: "CC", kind: "spark", lanIp: "10.0.0.9", isLocal: false, ssh: { host: "10.0.0.9", user: "u", auth: "key" }, role: "worker" });

test("snapshot carries clockCap with monitoring=true and null state before the first poll", () => {
  const m = new SparkMonitor(cfg());
  const s = m.snapshot();
  assert.deepEqual(s.clockCap, { monitoring: true, installed: null, enabled: null, active: null, smClockMHz: null, checkedAt: null, error: null });
  // nothing exported until probed
  assert.equal(flattenSnapshot(s).some((x) => x.name.startsWith("gpu_clock_cap")), false);
  m.stop();
});

test("after a poll the state is populated and exported; probe survives updateConfig", async () => {
  const m = new SparkMonitor(cfg());
  m._running = true;
  await m._pollDomain("clockCap");
  const s = m.snapshot();
  assert.equal(s.clockCap.installed, true);
  assert.equal(s.clockCap.active, true);
  assert.ok(Number.isFinite(s.clockCap.checkedAt));
  const names = Object.fromEntries(flattenSnapshot(s).filter((x) => x.name.startsWith("gpu_clock_cap")).map((x) => [x.name, x.value]));
  assert.deepEqual(Object.keys(names).sort(), ["gpu_clock_cap_active", "gpu_clock_cap_enabled", "gpu_clock_cap_installed", "gpu_clock_cap_sm_clock_mhz"]);
  assert.equal(names.gpu_clock_cap_active, 1);
  const probe = m.clockCapProbe;
  m.updateConfig({ ...cfg(), name: "renamed" });
  assert.equal(m.clockCapProbe, probe);
  assert.equal(m.clockCapProbe.spark.name, "renamed");
  m._running = false;
  m.stop();
});

test("start() registers the clock-cap interval; stop() clears it", () => {
  const m = new SparkMonitor(cfg());
  m.start();
  const n = m._intervals.length;
  assert.ok(n >= 8, `expected clock-cap timer among ${n} intervals`);
  m.stop();
  assert.equal(m._intervals.length, 0);
});
