import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ExpertLogTailer, findLatestIndex } from "../ExpertLogTailer.js";

function step(step, off, rows = 2) {
  return {
    step, t: 1000 + step * 0.07, n: rows, off, len: rows * 3 * 2,
    req: ["chatcmpl-test"], sched: [rows], pos: [step * 2], draft: [rows - 1],
    sampled: [1], rejected: [rows - 1],
    tokens: [[700 + step]],
  };
}

test("read-only tailer starts at latest flushed step and follows appends", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-tail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, "experts-dgx01-r0-123-20260829T000000Z");
  const idx = `${base}.idx.jsonl`;
  const data = `${base}.u8`;
  const meta = { type: "meta", host: "dgx01", rank: 0, layers: 3, topk: 2 };
  fs.writeFileSync(data, Buffer.from(Array.from({ length: 24 }, (_, i) => i)));
  fs.writeFileSync(idx, [meta, step(0, 0), step(1, 12)].map(JSON.stringify).join("\n") + "\n");
  fs.chmodSync(idx, 0o444);
  fs.chmodSync(data, 0o444);

  const events = [];
  const states = [];
  let lockKilled = false;
  const tailer = new ExpertLogTailer({
    directory: dir,
    pollIntervalMs: 10,
    scanIntervalMs: 10,
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    spawnSubscriberLock: () => {
      const child = new EventEmitter();
      child.kill = () => { lockKilled = true; };
      return child;
    },
  });
  tailer.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(events.map((event) => event.step), [1]);
  assert.equal(Buffer.from(events[0].routing, "base64").length, 12);
  assert.deepEqual(events[0].tokenIds, [701]);
  assert(states.some((state) => state.connected));

  fs.chmodSync(idx, 0o644);
  fs.chmodSync(data, 0o644);
  fs.appendFileSync(data, Buffer.from(Array.from({ length: 12 }, (_, i) => 30 + i)));
  fs.appendFileSync(idx, `${JSON.stringify(step(2, 24))}\n`);
  fs.chmodSync(idx, 0o444);
  fs.chmodSync(data, 0o444);
  await new Promise((resolve) => setTimeout(resolve, 40));
  tailer.stop();
  assert.deepEqual(events.map((event) => event.step), [1, 2]);
  assert(lockKilled);
});

test("findLatestIndex selects rank and newest mtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-index-"));
  const older = path.join(dir, "experts-a-r0-1-20260828T000000Z.idx.jsonl");
  const newer = path.join(dir, "experts-a-r0-2-20260829T000000Z.idx.jsonl");
  fs.writeFileSync(older, "");
  fs.writeFileSync(newer, "");
  fs.utimesSync(older, 1, 1);
  fs.utimesSync(newer, 2, 2);
  assert.equal(findLatestIndex(dir, 0), newer);
  assert.equal(findLatestIndex(dir, 1), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
