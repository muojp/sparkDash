import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TokenTraceFullscreenCanvas } from "./TokenTraceFullscreenCanvas";

export interface TraceStatus {
  type: "tokentrace_status";
  available: boolean;
  connected: boolean;
  source: "demo" | "local-files";
  mapping: {
    head: { id: string; name: string };
    worker: { id: string; name: string };
  } | null;
  reason: string | null;
  tokenOutput: {
    mode: "metadata" | "detokenize";
    available: boolean | null;
    reason: string | null;
  };
}

export interface TraceEvent {
  type: "expert_step";
  t: number;
  host: string;
  rank: number;
  step: number;
  req: string;
  layers: number;
  topk: number;
  rows: number;
  rowsTotal: number;
  truncated: boolean;
  position: number;
  draft: number | null;
  sampled: number;
  rejected: number;
  tokenIds?: number[];
  tokenText?: string;
  routing: string;
  durationMs: number | null;
  baselineMs: number;
  stepClass: "PREFILL" | "FAST" | "NORMAL" | "STALL";
}

export interface Machine {
  id: string;
  name: string;
  online: boolean;
  gpu: null | {
    temperature: number | null;
    usage: number | null;
    power: number | null;
    systemPower: number | null;
    memoryController: number | null;
  };
  rdma: { rxGbps: number; txGbps: number; active: boolean };
  paging: null | {
    swapUsedMB: number | null;
    swapTotalMB: number | null;
    swapPercent: number | null;
    swapInPages: number | null;
    swapInPagesPerSec: number | null;
    majorFaults: number | null;
    majorFaultsPerSec: number | null;
  };
  storageReadMBps: number;
  storageWriteMBps: number;
}

export interface StepMessage {
  type: "tokentrace_step";
  event: TraceEvent;
  machines: Machine[];
}

const CLASS_COLOR: Record<TraceEvent["stepClass"], string> = {
  PREFILL: "#b4a0dc",
  FAST: "#46c878",
  NORMAL: "#6e8cbe",
  STALL: "#f08c3c",
};

function timecode(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(Math.floor(d.getMilliseconds() / 10))}`;
}

function number(value: number | null | undefined, digits = 0): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function pagingActive(machine: Machine | undefined): boolean {
  return (machine?.paging?.swapInPagesPerSec || 0) > 0 || (machine?.paging?.majorFaultsPerSec || 0) > 0;
}

function decodeRouting(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function layerTicks(layers: number): number[] {
  if (layers <= 1) return [0];
  return [...new Set([0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round((layers - 1) * ratio)))];
}

function ExpertCanvas({ event, onContinuity }: { event: TraceEvent | null; onContinuity: (values: number[]) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shapeRef = useRef("");
  const layersRef = useRef(0);
  const heatRef = useRef(new Float32Array(0));
  const everRef = useRef(new Uint8Array(0));
  const flashRef = useRef(new Uint8Array(0));
  const previousTokenRef = useRef<Uint8Array | null>(null);
  const mutationAtRef = useRef(performance.now());
  const flashAtRef = useRef(0);

  useEffect(() => {
    if (!event) return;
    const shape = `${event.layers}:${event.topk}`;
    if (shapeRef.current !== shape) {
      shapeRef.current = shape;
      layersRef.current = event.layers;
      heatRef.current = new Float32Array(event.layers * 256);
      everRef.current = new Uint8Array(event.layers * 256);
      flashRef.current = new Uint8Array(event.layers * 256);
      previousTokenRef.current = null;
      onContinuity(Array(event.layers).fill(0));
    }
    const now = performance.now();
    const decay = Math.exp(-(now - mutationAtRef.current) / 4000);
    const heat = heatRef.current;
    for (let i = 0; i < heat.length; i++) heat[i] *= decay;
    mutationAtRef.current = now;
    const route = decodeRouting(event.routing);
    const accepted = Math.min(event.sampled, event.rows);
    const flash = flashRef.current;
    flash.fill(0);
    for (let row = 0; row < event.rows; row++) {
      for (let layer = 0; layer < event.layers; layer++) {
        for (let k = 0; k < event.topk; k++) {
          const expert: number = route[(row * event.layers + layer) * event.topk + k] ?? 0;
          const index = layer * 256 + expert;
          if (row < accepted) flash[index] = 1;
          else if (flash[index] !== 1) flash[index] = 2;
          if (row < accepted) {
            heat[index] = Math.min(1, heat[index] + 0.25);
            everRef.current[index] = 1;
          }
        }
      }
    }
    if (accepted > 0) {
      const offset = (accepted - 1) * event.layers * event.topk;
      const token = route.slice(offset, offset + event.layers * event.topk);
      const previous = previousTokenRef.current;
      if (previous) {
        const overlap = Array.from({ length: event.layers }, (_, layer) => {
          const prev = new Set(previous.slice(layer * event.topk, (layer + 1) * event.topk));
          let count = 0;
          for (const expert of token.slice(layer * event.topk, (layer + 1) * event.topk)) {
            if (prev.has(expert)) count += 1;
          }
          return count;
        });
        onContinuity(overlap);
      }
      previousTokenRef.current = token;
    }
    flashAtRef.current = now;
  }, [event, onContinuity]);

  useEffect(() => {
    let frame = 0;
    let lastDraw = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - lastDraw < 45) return;
      lastDraw = now;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d", { alpha: false });
      if (!canvas || !context) return;
      const cell = 6;
      const heatDecay = Math.exp(-(now - mutationAtRef.current) / 4000);
      const flashDecay = Math.exp(-(now - flashAtRef.current) / 260);
      context.fillStyle = "#0b0f14";
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (let layer = 0; layer < layersRef.current; layer++) {
        for (let expert = 0; expert < 256; expert++) {
          const index = layer * 256 + expert;
          const value = heatRef.current[index] * heatDecay;
          let r = everRef.current[index] ? 8 + value * 82 : 22;
          let g = everRef.current[index] ? 36 + value * 194 : 26;
          let b = everRef.current[index] ? 50 + value * 205 : 32;
          const flash = flashRef.current[index];
          if (flash && flashDecay > 0.03) {
            const target = flash === 1 ? [255, 255, 255] : [255, 190, 90];
            r = r * (1 - flashDecay) + target[0] * flashDecay;
            g = g * (1 - flashDecay) + target[1] * flashDecay;
            b = b * (1 - flashDecay) + target[2] * flashDecay;
          }
          context.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
          context.fillRect(expert * cell, layer * cell, cell - 1, cell - 1);
        }
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  const layers = event?.layers || 43;
  return <canvas ref={canvasRef} width={1536} height={layers * 6} className="tt-expert-canvas" aria-label={`${layers} layers by 256 routed experts`} />;
}

function MachineCard({ machine, role }: { machine: Machine | undefined; role: string }) {
  return (
    <article className="tt-machine">
      <div className="tt-machine-head">
        <div><span className={`tt-dot ${machine?.online ? "is-online" : ""}`} />{machine?.id || role}</div>
        <span>{role}</span>
      </div>
      <div className="tt-machine-grid font-tabular">
        <div><label>GPU util</label><strong>{number(machine?.gpu?.usage)}%</strong></div>
        <div><label>GPU power · temp</label><strong>{number(machine?.gpu?.power)} W · {number(machine?.gpu?.temperature)}°</strong></div>
        <div><label>RoCE rx</label><strong>{number(machine?.rdma.rxGbps, 2)} Gb/s</strong></div>
        <div><label>RoCE tx</label><strong>{number(machine?.rdma.txGbps, 2)} Gb/s</strong></div>
        {machine?.paging && <>
          <div><label>Swap</label><strong>{number((machine.paging.swapUsedMB || 0) / 1024, 1)} GiB</strong></div>
          <div><label>Swap-in · majfault</label><strong className={pagingActive(machine) ? "tt-hot" : ""}>{number(machine.paging.swapInPagesPerSec, 1)} p/s · {number(machine.paging.majorFaultsPerSec, 1)}/s</strong></div>
        </>}
      </div>
    </article>
  );
}

export function TokenTracePage() {
  const [status, setStatus] = useState<TraceStatus | null>(null);
  const [steps, setSteps] = useState<StepMessage[]>([]);
  const [continuity, setContinuity] = useState<number[]>([]);
  const [socketOpen, setSocketOpen] = useState(false);
  const [fhdActive, setFhdActive] = useState(false);
  const fhdRef = useRef<HTMLDivElement>(null);
  const latest = steps.at(-1) || null;

  const updateContinuity = useCallback((values: number[]) => setContinuity(values), []);

  const enterFhd = useCallback(async () => {
    const stage = fhdRef.current;
    if (!stage) return;
    try {
      await stage.requestFullscreen();
    } catch {
      setFhdActive(true);
    }
  }, []);

  useEffect(() => {
    const onFullscreen = () => setFhdActive(document.fullscreenElement === fhdRef.current);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && fhdActive && !document.fullscreenElement) setFhdActive(false);
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("keydown", onKey);
    };
  }, [fhdActive]);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    fetch("/api/tokentrace").then((r) => r.json()).then((v) => !disposed && setStatus(v)).catch(() => {});
    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
      ws.onopen = () => {
        setSocketOpen(true);
        ws?.send(JSON.stringify({ type: "tokentrace_subscribe" }));
      };
      ws.onmessage = (message) => {
        try {
          const value = JSON.parse(message.data);
          if (value.type === "tokentrace_status") setStatus(value);
          if (value.type === "tokentrace_step") {
            // Keep enough counter history for the fullscreen 30 s paging
            // totals; individual graphs still render their latest 120 steps.
            setSteps((current) => [...current.slice(-599), value]);
          }
        } catch { /* malformed frames are ignored */ }
      };
      ws.onclose = () => {
        setSocketOpen(false);
        if (!disposed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tokentrace_unsubscribe" }));
      ws?.close();
    };
  }, []);

  const historyMax = useMemo(
    () => Math.max(100, ...steps.slice(-120).map((s) => s.event.durationMs || s.event.baselineMs || 0)) * 1.08,
    [steps]
  );
  const event = latest?.event || null;
  const tokenRate = event?.durationMs && event.durationMs > 0
    ? event.sampled / (event.durationMs / 1000)
    : null;
  const tokenSteps = event ? steps.filter((step) => step.event.req === event.req) : steps;
  const mapped = status?.mapping;
  const ticks = layerTicks(event?.layers || 43);

  return (
    <div className="tt-page">
      <header className="tt-header">
        <div>
          <a href="/" className="tt-brand">spark<span>Dash</span></a>
          <span className="tt-slash">/</span>
          <strong>TokenTrace Live</strong>
        </div>
        <div className="tt-status-row">
          <span className={`tt-live ${socketOpen && status?.connected ? "is-live" : ""}`}>
            <i />{status?.connected ? "LIVE" : "WAITING"}
          </span>
          <span>{mapped ? `${mapped.head.id} + ${mapped.worker.id}` : "cluster mapping unavailable"}</span>
          <button type="button" className="tt-fhd-button" onClick={enterFhd}>FULL SCREEN</button>
          <a href="/">Back to dashboard</a>
        </div>
      </header>

      <main className="tt-main">
        <section className="tt-title-row">
          <div>
            <h1 className="tt-model-title">
              DeepSeek-V4-Flash
              <span>· TP=2 over RoCE · MTP-5</span>
            </h1>
          </div>
          <div className="tt-time font-tabular">
            <span>token output</span>
            <strong>{event ? timecode(event.t) : "--:--:--.--"}</strong>
          </div>
        </section>

        {!status?.available && (
          <div className="tt-alert">TokenTrace needs one Head and one linked Worker in sparkDash. {status?.reason}</div>
        )}

        <section className="tt-map-layout">
          <article className="tt-panel tt-map-panel">
            <div className="tt-panel-head">
              <div><b>Routed experts</b><span>{event?.layers || "—"} layers × 256 experts · accepted white · rejected amber</span></div>
            </div>
            <div className="tt-map-wrap">
              <span className={`tt-node-edge left ${pagingActive(latest?.machines[0]) ? "is-paging" : ""}`}>{mapped?.head.id || "head"}</span>
              <ExpertCanvas event={event} onContinuity={updateContinuity} />
              <span className={`tt-node-edge right ${pagingActive(latest?.machines[1]) ? "is-paging" : ""}`}>{mapped?.worker.id || "worker"}</span>
            </div>
            <div className="tt-axis">{ticks.map((layer) => <span key={layer}>L{String(layer).padStart(2, "0")}</span>)}</div>
          </article>

          <aside className="tt-panel tt-current">
            <div className="tt-class" style={{ color: event ? CLASS_COLOR[event.stepClass] : undefined }}>
              {event?.stepClass || "IDLE"}
            </div>
            <div className="tt-current-data font-tabular">
              <div className="tt-current-metrics">
                <div className="tt-big-number">{number(event?.durationMs, 1)}<small> ms</small></div>
                <div className="tt-big-number tt-rate-number" style={{ color: event ? CLASS_COLOR[event.stepClass] : undefined }}>
                  {number(tokenRate, 1)}<small> tok/s</small>
                </div>
              </div>
              <div className="tt-current-summary">
                <div><span>accepted</span><strong>{event?.sampled ?? "—"}</strong></div>
                <div><span>rows</span><strong>{event?.rowsTotal ?? "—"}</strong></div>
                <div><span>baseline</span><strong>{number(event?.baselineMs, 1)}<small> ms</small></strong></div>
              </div>
            </div>
            <div className="tt-request">
              <span>request</span><code>{event?.req || "waiting for a token step"}</code>
              <span>position</span><code>{event?.position ?? "—"}</code>
            </div>
          </aside>
        </section>

        <section className="tt-machines">
          <MachineCard machine={latest?.machines[0]} role="HEAD" />
          <MachineCard machine={latest?.machines[1]} role="WORKER" />
        </section>

        <section className="tt-lower">
          <article className="tt-panel tt-history">
            <div className="tt-panel-head"><div><b>Engine step time</b><span>latest 120 steps</span></div></div>
            <div className="tt-bars">
              {steps.slice(-120).map((step, index) => {
                const height = Math.max(5, ((step.event.durationMs || step.event.baselineMs) / historyMax) * 100);
                return <i key={`${step.event.step}-${index}`} title={`${number(step.event.durationMs, 1)} ms`} style={{ height: `${height}%`, background: CLASS_COLOR[step.event.stepClass] }} />;
              })}
            </div>
            <div className="tt-history-foot font-tabular"><span>p50 {number(event?.baselineMs, 1)} ms</span><span>{steps.length} samples</span></div>
          </article>

          <article className="tt-panel tt-token-log">
            <div className="tt-panel-head"><div><b>Token output</b><span>wall-clock arrival time</span></div></div>
            <div className="tt-log-lines font-tabular">
              {tokenSteps.slice(-5).reverse().map((step, index) => (
                <div key={`${step.event.step}-${index}`}>
                  <time>{timecode(step.event.t)}</time>
                  <code>pos {step.event.position}</code>
                  <span className="tt-token-text" style={{ color: CLASS_COLOR[step.event.stepClass] }}>
                    {step.event.tokenText != null ? step.event.tokenText.replace(/\n/g, " ⏎ ") : `+${step.event.sampled} token${step.event.sampled === 1 ? "" : "s"}`}
                  </span>
                </div>
              ))}
              {!steps.length && <div className="tt-empty">Waiting for the next recorder flush…</div>}
            </div>
          </article>
        </section>

        <section className="tt-panel tt-continuity">
          <div className="tt-panel-head"><div><b>Routing continuity</b><span>experts shared with the previous accepted token, per layer</span></div></div>
          <div className="tt-continuity-bars">
            {continuity.map((value, layer) => <i key={layer} title={`L${layer}: ${value}/${event?.topk || 0}`} style={{ height: `${Math.max(5, value / (event?.topk || 1) * 100)}%` }} />)}
          </div>
          <div className="tt-continuity-axis">{ticks.map((layer) => <span key={layer}>L{String(layer).padStart(2, "0")}</span>)}</div>
        </section>
      </main>
      <TokenTraceFullscreenCanvas
        containerRef={fhdRef}
        active={fhdActive}
        status={status}
        steps={steps}
      />
    </div>
  );
}
