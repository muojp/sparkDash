/**
 * ClockCapProbe — state of the gb10-clock-cap systemd unit
 * (https://github.com/agjs/gb10-clock-cap) on one unit, read over SSH.
 *
 * Read-only: `systemctl is-enabled` / `is-active` + the current SM clock.
 * Never starts/stops the unit — toggling stays with the on-demand
 * /api/sparks/:id/clock-cap endpoint. Status goes over SSH even for the local
 * Spark: systemctl inside the container would query the container, not the
 * host. Opt-in via CLOCK_CAP_MONITORING (config.js) since stock sparkDash
 * installs have no such unit; on hosts without it `installed` is false.
 */
import { sshExec } from "./ssh.js";
import { CLOCK_CAP_PROBE_TIMEOUT_MS } from "../config.js";

export const CLOCK_CAP_UNIT = "gb10-clock-cap.service";
export const CLOCK_CAP_STATUS_CMD =
  `enabled=$(systemctl is-enabled ${CLOCK_CAP_UNIT} 2>/dev/null || echo unknown); ` +
  `active=$(systemctl is-active ${CLOCK_CAP_UNIT} 2>/dev/null || echo unknown); ` +
  `clock=$(nvidia-smi --query-gpu=clocks.sm --format=csv,noheader,nounits 2>/dev/null | head -n1); ` +
  `echo "cap:$enabled|$active|$clock"`;

/** Parse the `cap:<enabled>|<active>|<clock>` line (last one wins). */
export function parseClockCapStatus(out) {
  const line =
    String(out || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("cap:"))
      .pop() || "cap:unknown|unknown|";
  const [enabled = "unknown", active = "unknown", clock = ""] = line.slice(4).split("|");
  const mhz = parseInt(clock, 10);
  return {
    installed: enabled !== "unknown" && enabled !== "not-found",
    enabled: enabled === "enabled",
    active: active === "active",
    smClockMHz: Number.isFinite(mhz) ? mhz : null,
  };
}

/** Snapshot shape when nothing has been probed yet (or monitoring is off). */
export function defaultClockCap(monitoring) {
  return {
    monitoring: Boolean(monitoring),
    installed: null,
    enabled: null,
    active: null,
    smClockMHz: null,
    checkedAt: null,
    error: null,
  };
}

export class ClockCapProbe {
  constructor(spark) {
    this.spark = spark;
  }

  setTarget(spark) {
    this.spark = spark;
  }

  /** Never throws — errors land in `error` so the poll loop stays quiet. */
  async probe() {
    try {
      const out = await sshExec(this.spark, CLOCK_CAP_STATUS_CMD, {
        timeoutMs: CLOCK_CAP_PROBE_TIMEOUT_MS,
      });
      return { ...parseClockCapStatus(out), checkedAt: Date.now(), error: null };
    } catch (err) {
      return {
        installed: null,
        enabled: null,
        active: null,
        smClockMHz: null,
        checkedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
