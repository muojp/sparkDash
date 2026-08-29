import test from "node:test";
import assert from "node:assert/strict";
import { parseClockCapStatus, defaultClockCap, ClockCapProbe, CLOCK_CAP_STATUS_CMD } from "../ClockCapProbe.js";

test("parses enabled/active/clock", () => {
  assert.deepEqual(parseClockCapStatus("cap:enabled|active|2177\n"), { installed: true, enabled: true, active: true, smClockMHz: 2177 });
  assert.deepEqual(parseClockCapStatus("cap:enabled|inactive|3003"), { installed: true, enabled: true, active: false, smClockMHz: 3003 });
  assert.deepEqual(parseClockCapStatus("cap:disabled|inactive|"), { installed: true, enabled: false, active: false, smClockMHz: null });
});

test("unit missing → installed=false; garbage / empty → all false, null clock", () => {
  assert.equal(parseClockCapStatus("cap:not-found|inactive|2000").installed, false);
  assert.equal(parseClockCapStatus("cap:unknown|unknown|").installed, false);
  assert.deepEqual(parseClockCapStatus(""), { installed: false, enabled: false, active: false, smClockMHz: null });
  assert.deepEqual(parseClockCapStatus(null), { installed: false, enabled: false, active: false, smClockMHz: null });
});

test("last cap: line wins and MOTD noise is ignored", () => {
  const out = "Welcome to Ubuntu\ncap:enabled|inactive|3003\nsomething\ncap:enabled|active|2177\n";
  assert.equal(parseClockCapStatus(out).active, true);
  assert.equal(parseClockCapStatus(out).smClockMHz, 2177);
});

test("status command is read-only (no start/stop/enable/disable)", () => {
  assert.match(CLOCK_CAP_STATUS_CMD, /is-enabled/);
  assert.match(CLOCK_CAP_STATUS_CMD, /is-active/);
  assert.doesNotMatch(CLOCK_CAP_STATUS_CMD, /systemctl (start|stop|enable|disable|restart|daemon-reload)/);
  assert.doesNotMatch(CLOCK_CAP_STATUS_CMD, /-lgc|-rgc|sudo/);
});

test("defaultClockCap shape", () => {
  assert.deepEqual(defaultClockCap(true), { monitoring: true, installed: null, enabled: null, active: null, smClockMHz: null, checkedAt: null, error: null });
  assert.equal(defaultClockCap(false).monitoring, false);
});

test("probe() never throws: SSH failure lands in error with null state", async () => {
  // No ssh config → sshExec rejects synchronously-ish; probe must swallow it.
  const p = new ClockCapProbe({ id: "x", lanIp: "", ssh: {} });
  const r = await p.probe();
  assert.equal(r.installed, null);
  assert.equal(r.active, null);
  assert.match(r.error, /SSH config missing/);
  assert.ok(Number.isFinite(r.checkedAt));
});
