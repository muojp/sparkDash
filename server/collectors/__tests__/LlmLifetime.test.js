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
    assert.deepEqual(first.update("spark-a", 8888, 1000, 500, 800, 200, "m"), {
      rawInput: 1000,
      rawOutput: 500,
      totalInput: 1000,
      totalOutput: 500,
      rawCachedInput: 800,
      totalCachedInput: 800,
      rawUncachedInput: 200,
      totalUncachedInput: 200,
    });
    const advanced = first.update("spark-a", 8888, 1200, 700, 950, 250, "m");
    assert.equal(advanced.totalOutput, 700);
    assert.equal(advanced.totalCachedInput, 950);
    assert.equal(advanced.totalUncachedInput, 250);

    // Backend reset: add the post-reset current values instead of decreasing.
    const reset = first.update("spark-a", 8888, 20, 10, 15, 5, "m");
    assert.equal(reset.totalInput, 1220);
    assert.equal(reset.totalOutput, 710);
    assert.equal(reset.totalCachedInput, 965);
    assert.equal(reset.totalUncachedInput, 255);

    // New store instance simulates a sparkDash process restart.
    const restarted = new LlmLifetimeStore(file);
    const resumed = restarted.update("spark-a", 8888, 30, 15, 22, 8, "m");
    assert.equal(resumed.totalInput, 1230);
    assert.equal(resumed.totalOutput, 715);
    assert.equal(resumed.totalCachedInput, 972);
    assert.equal(resumed.totalUncachedInput, 258);

    // Spark/port series are independent.
    assert.equal(restarted.update("spark-b", 8888, 7, 3, null, null, "m").totalOutput, 3);
    assert.equal(restarted.update("spark-a", 9999, 5, 2, null, null, "m").totalOutput, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps each model's totals apart on a shared port", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-llm-lifetime-model-"));
  const file = path.join(dir, "totals.json");
  try {
    const store = new LlmLifetimeStore(file);
    const A = "deepseek-v4-flash";
    const B = "glm-5.3-flash-nvfp4";

    assert.equal(store.update("dgx01", 8888, 1_000, 400, 900, 100, A).totalInput, 1000);
    assert.equal(store.update("dgx01", 8888, 3_000, 900, 2700, 300, A).totalInput, 3000);

    // The pair is switched to the other model: same spark, same port, counters
    // back near zero. That must start B's own total, not extend A's 3000.
    const first = store.update("dgx01", 8888, 50, 20, 40, 10, B);
    assert.equal(first.totalInput, 50);
    assert.equal(first.totalOutput, 20);
    assert.equal(first.totalCachedInput, 40);

    // A's totals are untouched and resume where they left off when it returns.
    assert.equal(store.update("dgx01", 8888, 3_200, 950, 2880, 320, A).totalInput, 3200);
    assert.equal(store.update("dgx01", 8888, 120, 60, 95, 25, B).totalInput, 120);

    // Survives a sparkDash restart with both models' entries intact.
    const restarted = new LlmLifetimeStore(file);
    assert.equal(restarted.update("dgx01", 8888, 3_300, 980, 2970, 330, A).totalInput, 3300);
    assert.equal(restarted.update("dgx01", 8888, 130, 65, 100, 30, B).totalInput, 130);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adopts a pre-model-split entry only when the same backend is still counting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-llm-lifetime-migrate-"));
  const legacy = { "dgx01:8888": { rawInput: 1_000, rawOutput: 400, totalInput: 9_000, totalOutput: 4_000 } };

  // Counter has not gone backwards: the process that earned those totals is
  // the one answering now, so the running model keeps them.
  const adoptFile = path.join(dir, "adopt.json");
  fs.writeFileSync(adoptFile, JSON.stringify(legacy));
  const adopted = new LlmLifetimeStore(adoptFile).update("dgx01", 8888, 1_100, 450, null, null, "same-model");
  assert.equal(adopted.totalInput, 9_100);
  assert.equal(JSON.parse(fs.readFileSync(adoptFile, "utf8"))["dgx01:8888"], undefined);

  // Counter reset: it cannot be known which model earned them, so the new
  // model starts clean and the old entry is parked rather than credited.
  const parkFile = path.join(dir, "park.json");
  fs.writeFileSync(parkFile, JSON.stringify(legacy));
  const fresh = new LlmLifetimeStore(parkFile).update("dgx01", 8888, 20, 5, null, null, "other-model");
  assert.equal(fresh.totalInput, 20);
  const parked = JSON.parse(fs.readFileSync(parkFile, "utf8"));
  assert.equal(parked["dgx01:8888"], undefined);
  assert.equal(parked["dgx01:8888:__pre_model_split__"].totalInput, 9_000);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("persists nothing until the served model name is known", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-llm-lifetime-nomodel-"));
  const file = path.join(dir, "totals.json");
  try {
    const store = new LlmLifetimeStore(file);
    // A probe polls counters before /v1/models has answered: no model, no series.
    assert.equal(store.update("dgx01", 8888, 16, 16, 0, 16), null);
    assert.equal(store.update("dgx01", 8888, 16, 16, 0, 16, ""), null);
    assert.equal(store.update("dgx01", 8888, 16, 16, 0, 16, null), null);
    assert.equal(fs.existsSync(file), false);
    // The first sample with a model seeds that model's total, nothing else.
    const first = store.update("dgx01", 8888, 40, 30, 0, 40, "glm-5.3-flash-nvfp4");
    assert.equal(first.totalOutput, 30);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), ["dgx01:8888:glm-5.3-flash-nvfp4"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates the empty-model legacy shape and parks it when the model already has a series", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-llm-lifetime-emptykey-"));
  try {
    // `spark:port:` is what a probe wrote when it persisted before the model was
    // known. Same rules as `spark:port`: adopt if the counter continues…
    const adoptFile = path.join(dir, "adopt.json");
    fs.writeFileSync(adoptFile, JSON.stringify({ "dgx01:8888:": { rawInput: 100, rawOutput: 40, totalInput: 900, totalOutput: 400 } }));
    const adopted = new LlmLifetimeStore(adoptFile).update("dgx01", 8888, 110, 45, null, null, "same-model");
    assert.equal(adopted.totalInput, 910);
    assert.equal(JSON.parse(fs.readFileSync(adoptFile, "utf8"))["dgx01:8888:"], undefined);

    // …park if it reset…
    const parkFile = path.join(dir, "park.json");
    fs.writeFileSync(parkFile, JSON.stringify({ "dgx01:8888:": { rawInput: 100, rawOutput: 40, totalInput: 900, totalOutput: 400 } }));
    assert.equal(new LlmLifetimeStore(parkFile).update("dgx01", 8888, 5, 2, null, null, "other").totalInput, 5);
    assert.equal(JSON.parse(fs.readFileSync(parkFile, "utf8"))["dgx01:8888:__pre_model_split__"].totalInput, 900);

    // …and park, never merge, when the running model already owns a series.
    const ownedFile = path.join(dir, "owned.json");
    fs.writeFileSync(ownedFile, JSON.stringify({
      "dgx01:8888:": { rawInput: 16, rawOutput: 16, totalInput: 2_111_984_950, totalOutput: 57_501_339 },
      "dgx01:8888:glm": { rawInput: 500_000, rawOutput: 40_000, totalInput: 500_000, totalOutput: 40_000 },
    }));
    const glm = new LlmLifetimeStore(ownedFile).update("dgx01", 8888, 510_000, 41_000, null, null, "glm");
    assert.equal(glm.totalOutput, 41_000);
    const owned = JSON.parse(fs.readFileSync(ownedFile, "utf8"));
    assert.equal(owned["dgx01:8888:"], undefined);
    assert.equal(owned["dgx01:8888:__pre_model_split__"].totalOutput, 57_501_339);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("entries() lists every model's totals for a spark:port, parked entries excluded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-llm-lifetime-entries-"));
  const file = path.join(dir, "totals.json");
  try {
    const store = new LlmLifetimeStore(file);
    store.update("dgx01", 8888, 3_000, 900, 2_700, 300, "deepseek-v4-flash");
    store.update("dgx01", 8888, 50, 20, 40, 10, "glm-5.3-flash-nvfp4");
    store.update("dgx01", 9999, 7, 3, null, null, "elsewhere");
    store._data["dgx01:8888:__pre_model_split__"] = { totalInput: 1, totalOutput: 1 };
    assert.deepEqual(store.entries("dgx01", 8888), [
      { model: "deepseek-v4-flash", totalInput: 3000, totalOutput: 900, totalCachedInput: 2700, totalUncachedInput: 300 },
      { model: "glm-5.3-flash-nvfp4", totalInput: 50, totalOutput: 20, totalCachedInput: 40, totalUncachedInput: 10 },
    ]);
    assert.deepEqual(store.entries("dgx01", 8889), []);
    assert.deepEqual(new LlmLifetimeStore(file).entries("dgx01", 9999).map((e) => e.model), ["elsewhere"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
