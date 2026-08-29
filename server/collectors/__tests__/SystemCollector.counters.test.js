/**
 * Cumulative byte counters next to the rates: network (/proc/net/dev) and
 * disk (/sys/block/<dev>/stat). Exporters turn these into Prometheus
 * counters so bursts between samples are never lost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SystemCollector } from "../SystemCollector.js";
import { HOST_PATHS } from "../../config.js";

const NET_DEV = (rx, tx) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
enP7s7: ${rx} 100 0 0 0 0 0 0 ${tx} 50 0 0 0 0 0 0
enp1s0f0np0: ${rx * 3} 300 0 0 0 0 0 0 ${tx * 3} 150 0 0 0 0 0 0
`;

function localCollector() {
  const c = new SystemCollector({ id: "t", isLocal: true, disabledInterfaces: [], disabledDevices: [] });
  c._getInterfaceIpMap = async () => new Map([["enP7s7", "192.168.0.100"]]);
  c._getInterfaceOperstate = async () => "up";
  c._isVirtualNetworkInterface = (n) => n === "lo";
  c._getPrimaryInterface = async () => "enP7s7";
  return c;
}

test("local network metrics expose cumulative rxBytes/txBytes and derive speeds from their delta", async () => {
  const c = localCollector();
  let raw = NET_DEV(1_000_000, 500_000);
  c._readHostNetFile = async (f) => (f === "dev" ? raw : "");
  const first = await c._getNetworkMetrics(); // returns the interface array
  const a = first.find((i) => i.name === "enP7s7");
  assert.equal(a.rxBytes, 1_000_000);
  assert.equal(a.txBytes, 500_000);
  assert.equal(a.rxSpeed, 0, "no baseline yet → 0");
  const cx7 = first.find((i) => i.name === "enp1s0f0np0");
  assert.equal(cx7.rxBytes, 3_000_000);

  // Simulate 2 s of traffic: +2 MB rx, +1 MB tx
  c.lastNetworkStats.get("enP7s7").time -= 2000;
  c.lastNetworkStats.get("enp1s0f0np0").time -= 2000;
  raw = NET_DEV(3_000_000, 1_500_000);
  const second = await c._getNetworkMetrics();
  const b = second.find((i) => i.name === "enP7s7");
  assert.equal(b.rxBytes, 3_000_000);
  assert.equal(b.txBytes, 1_500_000);
  assert.ok(Math.abs(b.rxSpeed - 1_000_000) < 20_000, `rxSpeed ~1 MB/s, got ${b.rxSpeed}`);
  assert.ok(Math.abs(b.txSpeed - 500_000) < 10_000, `txSpeed ~0.5 MB/s, got ${b.txSpeed}`);
  // A burst that happened entirely inside the window is still fully present in the counter delta
  assert.equal(b.rxBytes - a.rxBytes, 2_000_000);
  assert.ok(!second.some((i) => i.name === "lo"));
});

test("disk I/O returns cumulative readBytes/writeBytes (sectors × 512) plus rates", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sd-sys-"));
  const prev = HOST_PATHS.SYS;
  HOST_PATHS.SYS = tmp;
  try {
    fs.mkdirSync(path.join(tmp, "block", "nvme0n1"), { recursive: true });
    const stat = (rd, wr) => `1 2 ${rd} 4 5 6 ${wr} 8 9 10 11`;
    fs.writeFileSync(path.join(tmp, "block", "nvme0n1", "stat"), stat(2000, 1000));
    const c = new SystemCollector({ id: "t", isLocal: true });
    const first = await c._getDiskIO("nvme0n1");
    assert.deepEqual(first, { readSpeed: 0, writeSpeed: 0, readBytes: 2000 * 512, writeBytes: 1000 * 512 });
    c.lastDiskIO.get("nvme0n1").time -= 1000;
    fs.writeFileSync(path.join(tmp, "block", "nvme0n1", "stat"), stat(4000, 1000));
    const second = await c._getDiskIO("nvme0n1");
    assert.equal(second.readBytes, 4000 * 512);
    assert.equal(second.writeBytes, 1000 * 512);
    assert.ok(Math.abs(second.readSpeed - 2000 * 512) < 20_000, `readSpeed ~1 MB/s, got ${second.readSpeed}`);
    assert.equal(second.writeSpeed, 0);
    // unreadable device → nulls, never throws
    const missing = await c._getDiskIO("nope");
    assert.deepEqual(missing, { readSpeed: 0, writeSpeed: 0, readBytes: null, writeBytes: null });
  } finally {
    HOST_PATHS.SYS = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
