/**
 * Persistent, restart-safe token accumulation.
 *
 * Backends expose counters that reset when the inference process restarts.
 * Store the last raw values and add only observed deltas so the exported
 * totals remain monotonic across both backend and sparkDash restarts.
 *
 * Series are keyed by spark, port AND model. A pair that is switched between
 * two models on the same port — one 121 GiB node cannot hold two 300B-class
 * checkpoints, so switching is the normal way to run them — otherwise looks
 * like one backend that keeps resetting, and the second model inherits the
 * first model's lifetime total. The exported series carries a `model` label,
 * so that produced a GLM series which claimed DeepSeek's two billion input
 * tokens on its first request.
 */
import fs from "fs";
import { LLM_LIFETIME_JSON_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

function finiteCounter(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function seriesKey(sparkId, port, model) {
  return `${sparkId}:${port}:${model ?? ""}`;
}

/**
 * Keys written before totals were split per model: the original `spark:port`,
 * and `spark:port:` — the shape a probe produced when it persisted before the
 * served model name was known. Neither is a model series; both are migrated.
 */
function legacyKeys(sparkId, port) {
  return [`${sparkId}:${port}`, `${sparkId}:${port}:`];
}
const PRE_SPLIT_SUFFIX = "__pre_model_split__";

function isModelName(model) {
  return typeof model === "string" && model !== "" && model !== PRE_SPLIT_SUFFIX;
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
   * Move a pre-model-split entry onto its rightful model key, once.
   *
   * If the backend's current input counter has not gone backwards from the one
   * stored under the old key, the process that accumulated those totals is
   * still the one answering, so this model owns them and the entry is adopted.
   * Otherwise the counter reset — a restart, or the other model — and there is
   * no way to tell from the file which model earned them, so the entry is
   * parked under a `__pre_model_split__` key rather than credited to whichever
   * model happened to come up first. The parked entry is inert: nothing reads
   * it, it just stops the history from being silently reassigned or lost.
   */
  _migrateLegacy(sparkId, port, key, input) {
    const legacy = legacyKeys(sparkId, port).find((k) => this._data[k]);
    if (!legacy) return;
    const entry = this._data[legacy];
    if (this._data[key]) {
      // The model already has its own series: the old entry cannot be its
      // continuation, so it is parked (never merged, never dropped).
      this._data[seriesKey(sparkId, port, PRE_SPLIT_SUFFIX)] = { ...entry };
      delete this._data[legacy];
      atomicWrite(this.filePath, JSON.stringify(this._data));
      return;
    }
    const current = finiteCounter(input);
    const stored = finiteCounter(entry.rawInput);
    const continues = current != null && stored != null && current >= stored;
    if (continues) this._data[key] = { ...entry };
    else this._data[seriesKey(sparkId, port, PRE_SPLIT_SUFFIX)] = { ...entry };
    delete this._data[legacy];
    atomicWrite(this.filePath, JSON.stringify(this._data));
  }

  /**
   * @param {string} sparkId
   * @param {number} port
   * @param {number|null|undefined} input
   * @param {number|null|undefined} output
   * @param {number|null|undefined} cachedInput
   * @param {number|null|undefined} uncachedInput
   * @param {string|null|undefined} model  Served model name. Last so that the
   *   model-less call shape still behaves as it did.
   */
  update(sparkId, port, input, output, cachedInput = null, uncachedInput = null, model = null) {
    if (!sparkId || !Number.isInteger(Number(port))) return null;
    // No served model name yet (backend still booting, /v1/models not answered):
    // nothing is persisted. Keying on an empty model once orphaned a port's whole
    // history under `spark:port:` — an entry no series is labelled with.
    if (!isModelName(model)) return null;
    const key = seriesKey(sparkId, Number(port), model);
    this._migrateLegacy(sparkId, Number(port), key, input);
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

  /**
   * Every model's lifetime totals stored for one spark:port, so a model that is
   * not the one currently served (switched out, or the port is between
   * backends) keeps an exported series instead of vanishing from the graphs.
   * Parked pre-split entries are not included.
   * @param {string} sparkId
   * @param {number} port
   * @returns {Array<{model: string, totalInput: number|null, totalOutput: number|null, totalCachedInput: number|null, totalUncachedInput: number|null}>}
   */
  entries(sparkId, port) {
    if (!sparkId || !Number.isInteger(Number(port))) return [];
    const prefix = `${sparkId}:${Number(port)}:`;
    const out = [];
    for (const [key, entry] of Object.entries(this._data)) {
      if (!key.startsWith(prefix) || !entry) continue;
      const model = key.slice(prefix.length);
      if (!isModelName(model)) continue;
      out.push({
        model,
        totalInput: finiteCounter(entry.totalInput),
        totalOutput: finiteCounter(entry.totalOutput),
        totalCachedInput: finiteCounter(entry.totalCachedInput),
        totalUncachedInput: finiteCounter(entry.totalUncachedInput),
      });
    }
    return out.sort((a, b) => a.model.localeCompare(b.model));
  }
}

export const llmLifetime = new LlmLifetimeStore();
