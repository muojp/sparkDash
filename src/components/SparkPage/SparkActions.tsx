import { useEffect, useState } from "react";
import type { ClockCapStatus, SparkSnapshot } from "../../api/types";
import { fetchClockCap, setClockCap, shutdownSpark, wakeSpark } from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { openHermesUpdateDialog } from "../../hooks/useHermesUpdateDialog";
import { BoltIcon, EditIcon, PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";

interface SparkActionsProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
  /** Classes for the button-cluster wrapper (controls responsive visibility). */
  className?: string;
}

/**
 * Update Hermes / Shutdown·Wake / Edit action cluster.
 * Rendered twice: inline in the SparkHeader (desktop) and as a standalone row
 * just above "Resources" on mobile. Owning the shutdown dialog + transient
 * power message here keeps the two placements in sync.
 */
export function SparkActions({ spark, onEdit, className }: SparkActionsProps) {
  const online = spark.online;
  const [powerLoading, setPowerLoading] = useState(false);
  const [powerMsg, setPowerMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [capStatus, setCapStatus] = useState<ClockCapStatus | null>(null);
  const [capLoading, setCapLoading] = useState(false);

  useEffect(() => {
    if (!online) {
      setCapStatus(null);
      return;
    }
    let cancelled = false;
    fetchClockCap(spark.id)
      .then((status) => {
        if (!cancelled) setCapStatus(status);
      })
      .catch(() => {
        if (!cancelled) setCapStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [spark.id, online]);

  const hermes = spark.hermes;
  const hermesRunning = hermes?.status === "running";

  function handleHermesUpdate() {
    openHermesUpdateDialog({
      sparkId: spark.id,
      sparkName: spark.name,
      currentVersion: hermes?.version ?? null,
    });
  }

  async function handleShutdown() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await shutdownSpark(spark.id);
      setPowerMsg({ text: res.message || "Shutdown initiated", tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "Shutdown failed",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  async function handleWake() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setPowerMsg({ text: res.message || "Wake packet sent", tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "Wake failed",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  async function handleClockCapToggle() {
    if (!capStatus) return;
    setCapLoading(true);
    setPowerMsg(null);
    try {
      const next = await setClockCap(spark.id, !capStatus.active);
      setCapStatus(next);
      setPowerMsg({
        text: next.active
          ? `GPU clock cap on${next.smClockMHz != null ? ` (SM ${next.smClockMHz} MHz)` : ""}`
          : "GPU clock cap off — stock clocks until reboot",
        tone: "ok",
      });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "Clock cap toggle failed",
        tone: "err",
      });
    } finally {
      setCapLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  return (
    <>
      <div className={className}>
        {powerMsg && (
          <span className={`text-[11px] ${powerMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
            {powerMsg.text}
          </span>
        )}
        {hermesRunning && (
          <span
            className="flex items-center gap-1.5 text-[11px] text-warning"
            title="Running `hermes update` on this machine via SSH — this can take a few minutes."
          >
            <RotateIcon className="h-3 w-3" />
            Hermes updating…
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.status === "error" && (
          <span
            className="max-w-[16rem] truncate text-[11px] text-danger"
            title={hermes.error || "Hermes update failed"}
          >
            Hermes update failed
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.installed !== false && (
          <button
            type="button"
            onClick={() => void handleHermesUpdate()}
            disabled={powerLoading}
            title={
              hermes.updateAvailable === true
                ? `Run "hermes update" on this machine via SSH${
                    hermes.behindCommits ? ` (${hermes.behindCommits} commits behind)` : ""
                  }`
                : "Open Hermes Agent update status and run updates on this machine via SSH"
            }
            className={`flex items-center gap-1.5 rounded-md border bg-surface-elevated px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
              hermes.updateAvailable === true
                ? "border-warning/40 text-warning hover:bg-warning/15"
                : "border-border text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            <RotateIcon className="h-3 w-3" />
            Update Hermes
            {hermes.updateAvailable === true && (
              <span
                className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold leading-none text-white"
                title={
                  hermes.behindCommits != null
                    ? `${hermes.behindCommits} commit${hermes.behindCommits === 1 ? "" : "s"} behind`
                    : "Update available"
                }
              >
                {hermes.behindCommits != null ? hermes.behindCommits : "!"}
              </span>
            )}
          </button>
        )}
        {online && capStatus?.installed && (
          <button
            type="button"
            onClick={() => void handleClockCapToggle()}
            disabled={capLoading}
            title={
              capStatus.active
                ? "GPU clock cap active — click to use stock clocks until reboot"
                : "Apply the GPU clock cap for thermal headroom"
            }
            className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
              capStatus.active
                ? "border-success/40 bg-surface-elevated text-success hover:bg-success/15"
                : "border-border bg-surface-elevated text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            <BoltIcon className="h-3 w-3" />
            {capLoading ? "Clock cap…" : capStatus.active ? "Clock cap on" : "Clock cap off"}
          </button>
        )}
        {online ? (
          <button
            type="button"
            onClick={() => setShutdownOpen(true)}
            disabled={powerLoading}
            title="Graceful shutdown (requires /usr/local/bin/spark-shutdown on the host)"
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-danger/20 hover:text-danger disabled:opacity-50"
          >
            <PowerOffIcon className="h-3 w-3" />
            Shutdown
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleWake()}
            disabled={powerLoading}
            title="Wake-on-LAN (set MAC address in Edit Spark)"
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
          >
            <PowerOnIcon className="h-3 w-3" />
            Wake
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-surface-hover hover:text-text transition-colors"
          >
            <EditIcon className="h-3 w-3" />
            Edit
          </button>
        )}
      </div>

      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title={`Shut down ${spark.name}`}
        description={`Gracefully shut down ${spark.name}? This will stop all containers and power off the node.`}
        confirmLabel="Shut down"
      />
    </>
  );
}
