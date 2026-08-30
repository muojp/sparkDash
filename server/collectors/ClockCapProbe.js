/**
 * ClockCapProbe — state of the gb10-clock-cap systemd unit
 * (https://github.com/agjs/gb10-clock-cap) on one unit, read over SSH.
 *
 * Read-only: `systemctl is-enabled` / `is-active` + the current SM clock.
 * The periodic probe is read-only. The on-demand API deliberately keeps the
 * older runtime toggle, but limits it to exact `systemctl start` / `stop`
 * commands. Status goes over SSH even for the local Spark: systemctl inside the
 * container would query the container, not the host. Opt-in via
 * CLOCK_CAP_MONITORING (config.js) since stock sparkDash installs have no such
 * unit; on hosts without it `installed` is false.
 */
import { sshExec } from "./ssh.js";
import { CLOCK_CAP_PROBE_TIMEOUT_MS } from "../config.js";

export const CLOCK_CAP_UNIT = "gb10-clock-cap.service";
export const CLOCK_CAP_STATUS_CMD =
  `enabled=$(systemctl is-enabled ${CLOCK_CAP_UNIT} 2>/dev/null || echo unknown); ` +
  `active=$(systemctl is-active ${CLOCK_CAP_UNIT} 2>/dev/null || echo unknown); ` +
  `clock=$(nvidia-smi --query-gpu=clocks.sm --format=csv,noheader,nounits 2>/dev/null | head -n1); ` +
  `echo "cap:$enabled|$active|$clock"`;

/** Fixed commands matched verbatim by the host sudoers rule. */
export function clockCapActionCommand(active) {
  if (typeof active !== "boolean") throw new TypeError("active must be a boolean");
  return active
    ? `sudo -n systemctl start ${CLOCK_CAP_UNIT}`
    : `sudo -n systemctl stop ${CLOCK_CAP_UNIT}`;
}

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

/** Read one host's unit state. Unlike probe(), failures are returned to the API. */
export async function readClockCapStatus(spark) {
  const out = await sshExec(spark, CLOCK_CAP_STATUS_CMD, {
    timeoutMs: CLOCK_CAP_PROBE_TIMEOUT_MS,
  });
  return parseClockCapStatus(out);
}

/** Apply/remove the cap for this boot only; unit enablement is never changed. */
export async function setClockCapActive(spark, active) {
  await sshExec(spark, clockCapActionCommand(active), { timeoutMs: 15000 });
  return readClockCapStatus(spark);
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
      return { ...(await readClockCapStatus(this.spark)), checkedAt: Date.now(), error: null };
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
