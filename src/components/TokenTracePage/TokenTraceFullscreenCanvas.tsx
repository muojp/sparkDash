import { type RefObject, useEffect, useRef } from "react";
import type { Machine, StepMessage, TraceEvent, TraceStatus } from "./TokenTracePage";

const WIDTH = 1920;
const HEIGHT = 1080;
const EXPERTS = 256;
const BG = "#080d12";
const FG = "#dce3e9";
const DIM = "#7e8996";
const GRID = "#28303a";
const NEVER = [18, 22, 28] as const;
const LO = [8, 36, 50] as const;
const HI = [90, 230, 245] as const;
const ACCEPT = [240, 248, 250] as const;
const REJECT = [255, 174, 66] as const;
const NODE_COLORS = ["#6eaae8", "#5dd69a"] as const;
const CLASS_COLORS: Record<TraceEvent["stepClass"], string> = {
  PREFILL: "#b4a0dc",
  FAST: "#46c878",
  NORMAL: "#789bd0",
  STALL: "#ff8f35",
};

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  active: boolean;
  status: TraceStatus | null;
  steps: StepMessage[];
}

interface VisualState {
  layers: number;
  topk: number;
  heat: Float32Array;
  ever: Uint8Array;
  flash: Uint8Array;
  previous: Uint8Array | null;
  continuity: number[];
  mutationAt: number;
  flashAt: number;
  seen: Set<string>;
}

function initialVisual(): VisualState {
  return {
    layers: 0,
    topk: 0,
    heat: new Float32Array(0),
    ever: new Uint8Array(0),
    flash: new Uint8Array(0),
    previous: null,
    continuity: [],
    mutationAt: performance.now(),
    flashAt: 0,
    seen: new Set(),
  };
}

function rgb(values: readonly number[]): string {
  return `rgb(${values[0] | 0},${values[1] | 0},${values[2] | 0})`;
}

function decodeRouting(value: string): Uint8Array {
  const raw = atob(value);
  const result = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
  return result;
}

function timecode(epoch: number): string {
  const date = new Date(epoch * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(Math.floor(date.getMilliseconds() / 10))}`;
}

function metric(value: number | null | undefined, digits = 0): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function font(context: CanvasRenderingContext2D, size: number, mono = true, weight = 400) {
  context.font = `${weight} ${size}px ${mono ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" : "Inter, system-ui, sans-serif"}`;
}

function text(context: CanvasRenderingContext2D, value: string, x: number, y: number, color = FG, align: CanvasTextAlign = "left") {
  context.fillStyle = color;
  context.textAlign = align;
  context.textBaseline = "top";
  context.fillText(value, x, y);
}

function line(context: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color = GRID, width = 1) {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.beginPath();
  context.moveTo(x0, y0);
  context.lineTo(x1, y1);
  context.stroke();
}

function fit(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
}

function applyStep(state: VisualState, message: StepMessage) {
  const event = message.event;
  const key = `${event.req}:${event.step}:${event.t}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  if (state.seen.size > 800) state.seen = new Set([...state.seen].slice(-400));
  if (state.layers !== event.layers || state.topk !== event.topk) {
    state.layers = event.layers;
    state.topk = event.topk;
    state.heat = new Float32Array(event.layers * EXPERTS);
    state.ever = new Uint8Array(event.layers * EXPERTS);
    state.flash = new Uint8Array(event.layers * EXPERTS);
    state.previous = null;
    state.continuity = Array(event.layers).fill(0);
  }
  const now = performance.now();
  const decay = Math.exp(-(now - state.mutationAt) / 4000);
  for (let i = 0; i < state.heat.length; i++) state.heat[i] *= decay;
  state.mutationAt = now;
  const route = decodeRouting(event.routing);
  const accepted = Math.min(event.sampled, event.rows);
  state.flash.fill(0);
  for (let row = 0; row < event.rows; row++) {
    for (let layer = 0; layer < event.layers; layer++) {
      for (let k = 0; k < event.topk; k++) {
        const expert = route[(row * event.layers + layer) * event.topk + k] ?? 0;
        const index = layer * EXPERTS + expert;
        if (row < accepted) state.flash[index] = 1;
        else if (state.flash[index] !== 1) state.flash[index] = 2;
        if (row < accepted) {
          state.heat[index] = Math.min(1, state.heat[index] + 0.25);
          state.ever[index] = 1;
        }
      }
    }
  }
  if (accepted > 0) {
    const offset = (accepted - 1) * event.layers * event.topk;
    const current = route.slice(offset, offset + event.layers * event.topk);
    if (state.previous) {
      state.continuity = Array.from({ length: event.layers }, (_, layer) => {
        const before = new Set(state.previous!.slice(layer * event.topk, (layer + 1) * event.topk));
        let shared = 0;
        for (const expert of current.slice(layer * event.topk, (layer + 1) * event.topk)) {
          if (before.has(expert)) shared++;
        }
        return shared;
      });
    }
    state.previous = current;
  }
  state.flashAt = now;
}

function pagingActive(machine: Machine | undefined): boolean {
  return (machine?.paging?.swapInPagesPerSec || 0) > 0 || (machine?.paging?.majorFaultsPerSec || 0) > 0;
}

function drawExpertMap(
  context: CanvasRenderingContext2D,
  state: VisualState,
  message: StepMessage | undefined,
  now: number,
  mapping: TraceStatus["mapping"]
) {
  const event = message?.event || null;
  const x0 = 96;
  const y0 = 118;
  const cellW = 7;
  const cellH = 7;
  const layers = state.layers || event?.layers || 43;
  const mapW = EXPERTS * cellW;
  const mapH = layers * cellH;
  const heatDecay = Math.exp(-(now - state.mutationAt) / 4000);
  const flashDecay = Math.exp(-(now - state.flashAt) / 260);
  context.fillStyle = "#0b0f14";
  context.fillRect(x0, y0, mapW, mapH);
  for (let layer = 0; layer < layers; layer++) {
    for (let expert = 0; expert < EXPERTS; expert++) {
      const index = layer * EXPERTS + expert;
      const heat = (state.heat[index] || 0) * heatDecay;
      let color: number[] = state.ever[index]
        ? [LO[0] + (HI[0] - LO[0]) * heat, LO[1] + (HI[1] - LO[1]) * heat, LO[2] + (HI[2] - LO[2]) * heat]
        : [...NEVER];
      const flash = state.flash[index];
      if (flash && flashDecay > 0.03) {
        const target = flash === 1 ? ACCEPT : REJECT;
        color = color.map((channel, i) => channel * (1 - flashDecay) + target[i] * flashDecay);
      }
      context.fillStyle = rgb(color);
      context.fillRect(x0 + expert * cellW, y0 + layer * cellH, cellW - 1, cellH - 1);
    }
  }
  const headPaging = pagingActive(message?.machines[0]);
  const workerPaging = pagingActive(message?.machines[1]);
  context.fillStyle = headPaging ? "#ff5d45" : "#343e49";
  context.fillRect(x0 - 14, y0, 8, mapH);
  context.fillStyle = workerPaging ? "#ff5d45" : "#343e49";
  context.fillRect(x0 + mapW + 6, y0, 8, mapH);
  font(context, 16);
  const headLabel = mapping?.head.id || message?.machines[0]?.id || "head";
  const workerLabel = mapping?.worker.id || message?.machines[1]?.id || "worker";
  text(context, headLabel, x0 - 14, y0 - 26, NODE_COLORS[0]);
  text(context, workerLabel, WIDTH - 6, y0 - 26, NODE_COLORS[1], "right");
  if (headPaging) text(context, "PAGING", x0 + 54, y0 - 26, "#ff795f");
  if (workerPaging) text(context, "PAGING", WIDTH - 74, y0 - 26, "#ff795f", "right");
  text(context, `${layers} layers × 256 routed experts — one cell per expert; accepted token = white, rejected draft-only work = amber`, x0 + 230, y0 - 26, DIM);
  for (let layer = 0; layer < layers; layer += 5) text(context, `L${String(layer).padStart(2, "0")}`, x0 - 52, y0 + layer * cellH - 3, DIM);
  for (let expert = 0; expert < EXPERTS; expert += 32) text(context, `e${expert}`, x0 + expert * cellW, y0 + mapH + 4, DIM);
  const legendY = y0 + mapH + 29;
  const legends: Array<[string, string]> = [
    ["used → bright; unused → fades; never used → dark", rgb(HI)],
    ["this step: accepted token", rgb(ACCEPT)],
    ["this step: rejected draft only (wasted)", rgb(REJECT)],
  ];
  let x = x0;
  for (const [label, color] of legends) {
    context.fillStyle = color;
    context.fillRect(x, legendY + 3, 14, 14);
    text(context, label, x + 20, legendY, DIM);
    x += 34 + context.measureText(label).width;
  }
}

type MachineMetric = {
  label: string;
  unit: string;
  value: (machine: Machine | undefined) => number | null | undefined;
  digits: number;
  counter?: (machine: Machine | undefined) => number | null | undefined;
  hot?: boolean;
};

const MACHINE_METRICS: MachineMetric[] = [
  { label: "RoCE tx", unit: "Gb/s", value: (m) => m?.rdma?.txGbps, digits: 2 },
  { label: "RoCE rx", unit: "Gb/s", value: (m) => m?.rdma?.rxGbps, digits: 2 },
  { label: "GPU", unit: "W", value: (m) => m?.gpu?.power, digits: 1 },
  { label: "GPU util", unit: "%", value: (m) => m?.gpu?.usage, digits: 0 },
  { label: "swap-in", unit: "p/s · 30s", value: (m) => m?.paging?.swapInPagesPerSec, counter: (m) => m?.paging?.swapInPages, digits: 1, hot: true },
  { label: "majfault", unit: "/s · 30s", value: (m) => m?.paging?.majorFaultsPerSec, counter: (m) => m?.paging?.majorFaults, digits: 1, hot: true },
  { label: "NVMe rd", unit: "MB/s", value: (m) => m?.storageReadMBps, digits: 1 },
  { label: "NVMe wr", unit: "MB/s", value: (m) => m?.storageWriteMBps, digits: 1 },
  { label: "temp", unit: "°C", value: (m) => m?.gpu?.temperature, digits: 0 },
];

function drawMachineRows(context: CanvasRenderingContext2D, steps: StepMessage[]) {
  const current = steps.at(-1);
  const newestTime = current?.event.t || 0;
  const recent30 = steps.filter((step) => step.event.t >= newestTime - 30);
  const graphSteps = steps.slice(-120);
  const x0 = 96;
  const y0 = 510;
  const hostW = 92;
  const columnW = (1792 - hostW) / MACHINE_METRICS.length;
  font(context, 16);
  text(context, "per node, current sparkDash snapshot · mini graph = latest 120 engine steps · paging = rate / 30 s total", x0, y0 - 23, DIM);
  MACHINE_METRICS.forEach((item, index) => {
    text(context, `${item.label} ${item.unit}`, x0 + hostW + (index + 1) * columnW - 8, y0, DIM, "right");
  });
  [0, 1].forEach((hostIndex) => {
    const machine = current?.machines[hostIndex];
    const rowY = y0 + 28 + hostIndex * 60;
    font(context, 19);
    text(context, machine?.id || (hostIndex ? "worker" : "head"), x0, rowY, NODE_COLORS[hostIndex]);
    font(context, 13);
    const swapUsed = machine?.paging?.swapUsedMB;
    text(context, swapUsed != null
      ? `swap ${(swapUsed / 1024).toFixed(1)}G`
      : "swap —", x0, rowY + 25, pagingActive(machine) ? "#ff795f" : DIM);
    MACHINE_METRICS.forEach((item, metricIndex) => {
      const right = x0 + hostW + (metricIndex + 1) * columnW - 8;
      const value = item.value(machine);
      let display = metric(value, item.digits);
      if (item.counter) {
        const firstMachine = recent30.find((step) => item.counter?.(step.machines[hostIndex]) != null)?.machines[hostIndex];
        const first = item.counter(firstMachine);
        const last = item.counter(machine);
        const total = first != null && last != null ? Math.max(0, last - first) : null;
        display = `${display} / ${total == null ? "—" : Math.round(total).toLocaleString()}`;
      }
      font(context, item.counter ? 19 : 24);
      text(context, display, right, rowY - 3, item.hot && (value || 0) > 0 ? "#ff795f" : FG, "right");
      const values = graphSteps.map((step) => item.value(step.machines[hostIndex]) || 0);
      const max = Math.max(1, ...values);
      const graphX = x0 + hostW + metricIndex * columnW + 8;
      const graphW = columnW - 16;
      const graphY = rowY + 42;
      line(context, graphX, graphY, graphX + graphW, graphY, GRID);
      context.fillStyle = item.hot ? "#ff5d45" : NODE_COLORS[hostIndex];
      const barW = graphW / Math.max(values.length, 1);
      values.forEach((sample, index) => {
        const height = Math.max(sample > 0 ? 1 : 0, Math.round(12 * sample / max));
        context.fillRect(graphX + index * barW, graphY - height, Math.max(1, barW - 0.5), height);
      });
    });
  });
}

type TextSegment = { value: string; color: string };

function tokenStreamLines(context: CanvasRenderingContext2D, steps: StepMessage[], maxWidth: number): TextSegment[][] {
  const lines: TextSegment[][] = [[]];
  let width = 0;
  for (const step of steps) {
    const raw = step.event.tokenText;
    if (raw == null || raw === "") continue;
    const value = raw.replace(/\n/g, " ⏎ ");
    const color = CLASS_COLORS[step.event.stepClass];
    let chunk = "";
    for (const character of value) {
      const next = chunk + character;
      const nextWidth = context.measureText(next).width;
      if (width + nextWidth > maxWidth && (width > 0 || chunk)) {
        if (chunk) lines.at(-1)!.push({ value: chunk, color });
        lines.push([]);
        width = 0;
        chunk = character;
      } else {
        chunk = next;
      }
    }
    if (chunk) {
      lines.at(-1)!.push({ value: chunk, color });
      width += context.measureText(chunk).width;
    }
  }
  return lines.slice(-4);
}

function touched(event: TraceEvent | null): number {
  if (!event) return 0;
  const route = decodeRouting(event.routing);
  const set = new Set<number>();
  for (let row = 0; row < event.rows; row++) {
    for (let layer = 0; layer < event.layers; layer++) {
      for (let k = 0; k < event.topk; k++) {
        const expert = route[(row * event.layers + layer) * event.topk + k] ?? 0;
        set.add(layer * EXPERTS + expert);
      }
    }
  }
  return set.size;
}

function drawGauges(context: CanvasRenderingContext2D, steps: StepMessage[], state: VisualState) {
  const current = steps.at(-1)?.event || null;
  const x0 = 96;
  const y0 = 700;
  const graphW = 720;
  const graphH = 90;
  font(context, 16);
  text(context, "engine step time (bar = one step, colour = class; line = baseline p50)", x0, y0 - 24, DIM);
  if (!current) {
    line(context, x0, y0 + graphH, x0 + graphW, y0 + graphH, GRID);
    text(context, "current step", 896, y0 - 24, DIM);
    font(context, 40);
    text(context, "WAITING", 896, y0, DIM);
    font(context, 16);
    text(context, "experts", 1300, y0 - 24, DIM);
    font(context, 20);
    text(context, "waiting for the next complete recorder step", 1300, y0, DIM);
    context.strokeStyle = "#505660";
    context.strokeRect(1300, y0 + 62, 560, 8);
    return;
  }
  const baseline = current.baselineMs || 67;
  const recent = steps.slice(-120);
  const barW = graphW / 120;
  const durationMax = Math.max(baseline, ...recent.map((step) => step.event.durationMs || step.event.baselineMs || 0));
  const scaleMax = Math.max(1, durationMax * 1.08);
  const startX = x0 + graphW - recent.length * barW;
  recent.forEach((step, index) => {
    const duration = step.event.durationMs || step.event.baselineMs || 0;
    const height = Math.min(graphH, duration * graphH / scaleMax);
    context.fillStyle = CLASS_COLORS[step.event.stepClass];
    context.fillRect(startX + index * barW, y0 + graphH - height, Math.max(2, barW - 2), height);
  });
  const baselineY = y0 + graphH - baseline * graphH / scaleMax;
  line(context, x0, baselineY, x0 + graphW, baselineY, "#bfc5cb");
  text(context, `${baseline.toFixed(0)} ms`, x0 + graphW + 8, baselineY - 9, DIM);

  const middleX = 896;
  const duration = current.durationMs || 0;
  const rate = duration > 0 ? current.sampled / (duration / 1000) : 0;
  text(context, "current step", middleX, y0 - 24, DIM);
  font(context, 40);
  text(context, current.stepClass, middleX, y0, CLASS_COLORS[current.stepClass]);
  font(context, 28);
  text(context, `${rate.toFixed(1)} tok/s`, middleX + 210, y0 + 10, CLASS_COLORS[current.stepClass]);
  font(context, 20);
  text(context, `${duration.toFixed(1)} ms   ${current.sampled}/${current.rowsTotal} accepted`, middleX, y0 + 52, FG);
  for (let row = 0; row < Math.min(current.rowsTotal, 12); row++) {
    context.fillStyle = row < current.sampled ? CLASS_COLORS.FAST : "#464954";
    context.fillRect(middleX + row * 26, y0 + 80, 20, 18);
  }
  font(context, 16);
  text(context, "rows: green = accepted, grey = rejected", middleX, y0 + 102, DIM);

  const coverageX = 1300;
  const possible = (state.layers || current.layers) * EXPERTS;
  const used = state.ever.reduce((sum, value) => sum + value, 0);
  const touchedNow = touched(current);
  text(context, "experts", coverageX, y0 - 24, DIM);
  font(context, 20);
  text(context, `touched this step  ${String(touchedNow).padStart(4)} / ${possible}  (${(100 * touchedNow / possible).toFixed(1)} %)`, coverageX, y0, FG);
  text(context, `used so far        ${String(used).padStart(5)} / ${possible}  (${(100 * used / possible).toFixed(1)} %)`, coverageX, y0 + 28, FG);
  context.strokeStyle = "#505660";
  context.strokeRect(coverageX, y0 + 62, 560, 8);
  context.fillStyle = rgb(HI);
  context.fillRect(coverageX, y0 + 62, 560 * used / possible, 8);
  font(context, 16);
  text(context, `${possible} = ${state.layers || current.layers} layers × 256 experts`, coverageX, y0 + 80, DIM);
  text(context, "each (layer, expert) owns distinct weights → counted per pair", coverageX, y0 + 99, DIM);
}

function drawBottom(context: CanvasRenderingContext2D, steps: StepMessage[], state: VisualState) {
  const current = steps.at(-1)?.event || null;
  // Multiple concurrent requests are valid, but concatenating their decoded
  // chunks produces unreadable text. Follow the request that owns the newest
  // routing step, as the offline single-request video does.
  const outputSteps = current ? steps.filter((step) => step.event.req === current.req) : steps;
  const y0 = 888;
  line(context, 96, y0 - 16, WIDTH - 96, y0 - 16, GRID);
  context.save();
  context.beginPath();
  context.rect(96, y0 - 4, 1080, HEIGHT - y0 + 4);
  context.clip();
  const hasTextMode = outputSteps.some((step) => step.event.tokenText != null);
  font(context, 16);
  text(context, hasTextMode
    ? "generated text (colour = class of the engine step that produced it)"
    : "token output (wall-clock arrival; colour = engine-step class)", 96, y0 - 4, DIM);
  if (hasTextMode) {
    font(context, 24);
    const lines = tokenStreamLines(context, outputSteps, 1080);
    lines.forEach((segments, index) => {
      let x = 96;
      for (const segment of segments) {
        text(context, segment.value, x, y0 + 31 + index * 34, segment.color);
        x += context.measureText(segment.value).width;
      }
    });
  } else {
    const recent = outputSteps.slice(-4).reverse();
    font(context, 22);
    recent.forEach((step, index) => {
      const event = step.event;
      const label = `${timecode(event.t)}   +${event.sampled} token${event.sampled === 1 ? "" : "s"}   pos ${event.position}   ${fit(event.req, 28)}`;
      text(context, label, 96, y0 + 31 + index * 34, CLASS_COLORS[event.stepClass]);
    });
  }
  if (!outputSteps.length) text(context, "waiting for the next recorder flush…", 96, y0 + 38, DIM);
  context.restore();

  const x0 = 1224;
  const shared = state.continuity.reduce((sum, value) => sum + value, 0);
  const layers = state.layers || current?.layers || 43;
  const topk = state.topk || current?.topk || 6;
  const newestText = current?.tokenText?.trim().replace(/\s+/g, " ").slice(0, 18);
  text(context, newestText
    ? `routing continuity — newest token “${newestText}”`
    : "routing continuity — newest accepted token", x0, y0 - 4, DIM);
  font(context, 20);
  text(context, `${shared}/${layers * topk} same experts as previous token (random ≈ ${Math.round(layers * topk * topk / EXPERTS)})`, x0, y0 + 20, FG);
  const barY = y0 + 57;
  const barH = 60;
  const barW = 12;
  state.continuity.forEach((value, layer) => {
    const x = x0 + layer * (barW + 1);
    context.fillStyle = "#282f39";
    context.fillRect(x, barY, barW, barH);
    const height = barH * value / Math.max(topk, 1);
    if (height > 0) {
      context.fillStyle = CLASS_COLORS.FAST;
      context.fillRect(x, barY + barH - height, barW, height);
    }
  });
  font(context, 16);
  text(context, "6", x0 - 30, barY - 2, DIM);
  text(context, "0", x0 - 30, barY + barH - 14, DIM);
  text(context, "L00", x0, barY + barH + 6, DIM);
  text(context, `L${String(layers - 1).padStart(2, "0")}`, x0 + (layers - 1) * (barW + 1), barY + barH + 6, DIM, "right");
  text(context, `per layer (0–${topk}): retained experts vs previous token`, x0, barY + barH + 28, DIM);
}

function drawFrame(context: CanvasRenderingContext2D, status: TraceStatus | null, steps: StepMessage[], state: VisualState, now: number) {
  const latest = steps.at(-1)?.event || null;
  context.fillStyle = BG;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  font(context, 30, false, 400);
  text(context, "DeepSeek-V4-Flash · TP=2 over RoCE · MTP-5", 96, 22, FG);
  font(context, 20);
  const mapping = status?.mapping ? `${status.mapping.head.id} + ${status.mapping.worker.id}` : "cluster mapping unavailable";
  const code = latest ? timecode(latest.t) : "--:--:--.--";
  const liveLabel = status?.connected ? "● LIVE" : "○ WAITING FOR RECORDER FLUSH";
  text(context, liveLabel, 96, 60, status?.connected ? "#5bd58c" : DIM);
  const detailX = 96 + context.measureText(liveLabel).width + 28;
  text(context, `2× DGX Spark    token ${code}    recorder step ${latest == null ? "—" : String(latest.step).padStart(6, "0")}    ${mapping}`, detailX, 60, DIM);
  drawExpertMap(context, state, steps.at(-1), now, status?.mapping || null);
  drawMachineRows(context, steps);
  drawGauges(context, steps, state);
  drawBottom(context, steps, state);
}

export function TokenTraceFullscreenCanvas({ containerRef, active, status, steps }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualRef = useRef<VisualState>(initialVisual());
  const statusRef = useRef(status);
  const stepsRef = useRef(steps);
  statusRef.current = status;
  stepsRef.current = steps;

  useEffect(() => {
    const visual = visualRef.current;
    for (const step of steps) applyStep(visual, step);
  }, [steps]);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let previous = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - previous < 33) return;
      previous = now;
      const context = canvasRef.current?.getContext("2d", { alpha: false });
      if (context) drawFrame(context, statusRef.current, stepsRef.current, visualRef.current, now);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div ref={containerRef} className={`tt-fhd-stage ${active ? "is-active" : ""}`} aria-hidden={!active}>
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className="tt-fhd-canvas" aria-label="TokenTrace fullscreen canvas" />
    </div>
  );
}
