/**
 * RDMA / RoCE port counters from /sys/class/infiniband. NCCL over RoCE never
 * touches /proc/net/dev, so these are the only place fabric traffic shows up.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SystemCollector,
  ibDataToBytes,
  parseIbRateMbps,
  parseIbState,
  parseIbPortLine,
  IB_PORT_PROBE_CMD,
} from "../SystemCollector.js";
import { HOST_PATHS } from "../../config.js";

function writePort(root, hca, port, { rcv, xmit, rcvPkts = 10, xmitPkts = 20, rate, state }) {
  const p = path.join(root, "class", "infiniband", hca, "ports", port);
  fs.mkdirSync(path.join(p, "counters"), { recursive: true });
  fs.writeFileSync(path.join(p, "counters", "port_rcv_data"), `${rcv}\n`);
  fs.writeFileSync(path.join(p, "counters", "port_xmit_data"), `${xmit}\n`);
  fs.writeFileSync(path.join(p, "counters", "port_rcv_packets"), `${rcvPkts}\n`);
  fs.writeFileSync(path.join(p, "counters", "port_xmit_packets"), `${xmitPkts}\n`);
  fs.writeFileSync(path.join(p, "rate"), `${rate}\n`);
  fs.writeFileSync(path.join(p, "state"), `${state}\n`);
}

test("pure helpers: ×4 byte units, rate and state parsing", () => {
  assert.equal(ibDataToBytes("250"), 1000);
  assert.equal(ibDataToBytes("0"), 0);
  assert.equal(ibDataToBytes(""), null);
  assert.equal(ibDataToBytes("x"), null);
  assert.equal(parseIbRateMbps("200 Gb/sec (2X NDR)"), 200_000);
  assert.equal(parseIbRateMbps("40 Gb/sec (4X QDR)"), 40_000);
  assert.equal(parseIbRateMbps("2.5 Gb/sec (1X SDR)"), 2_500);
  assert.equal(parseIbRateMbps(""), null);
  assert.equal(parseIbState("4: ACTIVE"), "active");
  assert.equal(parseIbState("1: DOWN"), "down");
  assert.equal(parseIbState(""), "unknown");
});

test("parseIbPortLine parses the remote probe output line", () => {
  const s = parseIbPortLine("rocep1s0f0 1 238774510192 238067359390 1231952504 1201990809 200 Gb/sec (2X NDR) | 4: ACTIVE");
  assert.deepEqual(s, {
    hca: "rocep1s0f0",
    port: "1",
    rxBytes: 238774510192 * 4,
    txBytes: 238067359390 * 4,
    rxPackets: 1231952504,
    txPackets: 1201990809,
    rateMbps: 200_000,
    state: "active",
  });
  assert.equal(parseIbPortLine(""), null);
  assert.equal(parseIbPortLine("garbage"), null);
  assert.ok(IB_PORT_PROBE_CMD.includes("/sys/class/infiniband/*/ports/*"));
});

test("local sysfs: enumerates HCAs/ports, derives speeds from counter deltas, missing dir → []", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sd-ib-"));
  const prev = HOST_PATHS.SYS;
  HOST_PATHS.SYS = tmp;
  try {
    const c = new SystemCollector({ id: "t", isLocal: true });
    assert.deepEqual(c._getRdmaMetrics(), [], "no infiniband dir → []");

    writePort(tmp, "rocep1s0f0", "1", { rcv: 1000, xmit: 500, rate: "200 Gb/sec (2X NDR)", state: "4: ACTIVE" });
    writePort(tmp, "rocep1s0f1", "1", { rcv: 0, xmit: 0, rate: "40 Gb/sec (4X QDR)", state: "1: DOWN" });
    const first = c._getRdmaMetrics();
    assert.equal(first.length, 2);
    const a = first.find((p) => p.hca === "rocep1s0f0");
    assert.equal(a.rxBytes, 4000);
    assert.equal(a.txBytes, 2000);
    assert.equal(a.rxPackets, 10);
    assert.equal(a.rateMbps, 200_000);
    assert.equal(a.state, "active");
    assert.equal(a.active, true);
    assert.equal(a.rxSpeed, 0, "no baseline yet → 0");
    const down = first.find((p) => p.hca === "rocep1s0f1");
    assert.equal(down.active, false);
    assert.equal(down.state, "down");

    // 2 s later: +8 MB rx (in ×4 units: +2M), +4 MB tx
    c.lastRdmaStats.get("rocep1s0f0/1").time -= 2000;
    writePort(tmp, "rocep1s0f0", "1", { rcv: 1000 + 2_000_000, xmit: 500 + 1_000_000, rate: "200 Gb/sec (2X NDR)", state: "4: ACTIVE" });
    const second = c._getRdmaMetrics();
    const b = second.find((p) => p.hca === "rocep1s0f0");
    assert.equal(b.rxBytes - a.rxBytes, 8_000_000);
    assert.ok(Math.abs(b.rxSpeed - 4_000_000) < 40_000, `rxSpeed ~4 MB/s, got ${b.rxSpeed}`);
    assert.ok(Math.abs(b.txSpeed - 2_000_000) < 20_000, `txSpeed ~2 MB/s, got ${b.txSpeed}`);

    // counter reset (reboot) never yields negative speeds
    c.lastRdmaStats.get("rocep1s0f0/1").time -= 1000;
    writePort(tmp, "rocep1s0f0", "1", { rcv: 5, xmit: 5, rate: "200 Gb/sec (2X NDR)", state: "4: ACTIVE" });
    const third = c._getRdmaMetrics().find((p) => p.hca === "rocep1s0f0");
    assert.equal(third.rxSpeed, 0);
  } finally {
    HOST_PATHS.SYS = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("remote probe output: rdma section is parsed via the shared helpers and rated; defaults carry rdma: []", () => {
  const c = new SystemCollector({ id: "r", isLocal: false, host: "x", disabledInterfaces: [] });
  const ib = "rocep1s0f0 1 100 200 3 4 200 Gb/sec (2X NDR) | 4: ACTIVE\nrocep1s0f1 1 0 0 0 0 40 Gb/sec (4X QDR) | 1: DOWN\n\n";
  const sections = ["dev", "route", "ip", "oper", "mac", ib].join("---").split("---");
  const rdma = c._rateRdmaPorts((sections[5] || "").split("\n").map(parseIbPortLine).filter(Boolean));
  assert.equal(rdma.length, 2);
  assert.equal(rdma[0].rxBytes, 400);
  assert.equal(rdma[0].active, true);
  assert.equal(rdma[1].active, false);
  assert.equal(rdma[0].rxSpeed, 0);
  assert.deepEqual(c._defaultNetwork().rdma, []);
});
