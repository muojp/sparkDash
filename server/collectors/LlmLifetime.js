/**
 * Persistent, restart-safe token accumulation.
 *
 * Backends expose counters that reset when the inference process restarts.
 * Store the last raw values and add only observed deltas so the exported
 * totals remain monotonic across both backend and sparkDash restarts.
 */
import fs from "fs";
import { LLM_LIFETIME_JSON_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

function finiteCounter(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function seriesKey(sparkId, port) {
  return `${sparkId}:${port}`;
}

export class LlmLifetimeStore {
  constructor(filePath = LLM_LIFETIME_JSON_PATH) {
    this.filePath = filePath;
    this._data = {};
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") this._data = parsed;
    } catch {
      this._data = {};
    }
  }

  /**
   * @param {string} sparkId
   * @param {number} port
   * @param {number|null|undefined} input
   * @param {number|null|undefined} output
   * @param {number|null|undefined} cachedInput
   * @param {number|null|undefined} uncachedInput
   */
  update(sparkId, port, input, output, cachedInput = null, uncachedInput = null) {
    if (!sparkId || !Number.isInteger(Number(port))) return null;
    const key = seriesKey(sparkId, Number(port));
    const previous = this._data[key] || {
      rawInput: null,
      rawOutput: null,
      totalInput: null,
      totalOutput: null,
      rawCachedInput: null,
      totalCachedInput: null,
      rawUncachedInput: null,
      totalUncachedInput: null,
    };
    const next = { ...previous };
    let changed = false;

    const accumulate = (value, rawKey, totalKey) => {
      const current = finiteCounter(value);
      if (current == null) return;
      const rawPrevious = finiteCounter(previous[rawKey]);
      const increment = rawPrevious == null || current < rawPrevious
        ? current
        : current - rawPrevious;
      next[rawKey] = current;
      next[totalKey] = (finiteCounter(previous[totalKey]) ?? 0) + increment;
      changed = next[rawKey] !== previous[rawKey] || next[totalKey] !== previous[totalKey] || changed;
    };

    accumulate(input, "rawInput", "totalInput");
    accumulate(output, "rawOutput", "totalOutput");
    const inputCounter = finiteCounter(input);
    const cachedCounter = finiteCounter(cachedInput);
    const uncachedCounter = finiteCounter(uncachedInput);
    if (cachedCounter != null) {
      accumulate(cachedCounter, "rawCachedInput", "totalCachedInput");
    }
    // Prefer the backend's independent local-compute counter. Deriving this as
    // input-cached is unsafe because Prometheus counters can be updated between
    // samples, making the subtraction briefly decrease and look like a reset.
    if (uncachedCounter != null) {
      accumulate(uncachedCounter, "rawUncachedInput", "totalUncachedInput");
    }
    this._data[key] = next;
    if (changed) atomicWrite(this.filePath, JSON.stringify(this._data));
    return { ...next };
  }
}

export const llmLifetime = new LlmLifetimeStore();
