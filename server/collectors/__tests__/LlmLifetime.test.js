import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { LlmLifetimeStore } from "../LlmLifetime.js";

test("persists delta totals across backend and sparkDash restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-llm-lifetime-"));
  const file = path.join(dir, "totals.json");
  try {
    const first = new LlmLifetimeStore(file);
    assert.deepEqual(first.update("spark-a", 8888, 1000, 500, 800, 200), {
      rawInput: 1000,
      rawOutput: 500,
      totalInput: 1000,
      totalOutput: 500,
      rawCachedInput: 800,
      totalCachedInput: 800,
      rawUncachedInput: 200,
      totalUncachedInput: 200,
    });
    const advanced = first.update("spark-a", 8888, 1200, 700, 950, 250);
    assert.equal(advanced.totalOutput, 700);
    assert.equal(advanced.totalCachedInput, 950);
    assert.equal(advanced.totalUncachedInput, 250);

    // Backend reset: add the post-reset current values instead of decreasing.
    const reset = first.update("spark-a", 8888, 20, 10, 15, 5);
    assert.equal(reset.totalInput, 1220);
    assert.equal(reset.totalOutput, 710);
    assert.equal(reset.totalCachedInput, 965);
    assert.equal(reset.totalUncachedInput, 255);

    // New store instance simulates a sparkDash process restart.
    const restarted = new LlmLifetimeStore(file);
    const resumed = restarted.update("spark-a", 8888, 30, 15, 22, 8);
    assert.equal(resumed.totalInput, 1230);
    assert.equal(resumed.totalOutput, 715);
    assert.equal(resumed.totalCachedInput, 972);
    assert.equal(resumed.totalUncachedInput, 258);

    // Spark/port series are independent.
    assert.equal(restarted.update("spark-b", 8888, 7, 3).totalOutput, 3);
    assert.equal(restarted.update("spark-a", 9999, 5, 2).totalOutput, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
