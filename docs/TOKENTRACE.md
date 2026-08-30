# TokenTrace Live add-on

TokenTrace Live is sparkDash's optional real-time view for the
DeepSeek-V4-Flash DSpark recorder. Open `/tokentrace` (or the **TokenTrace**
button in the dashboard header) to see the metadata-sized routed-expert map
(43 × 256 in the current DeepSeek V4 recorder stream),
accepted/rejected work, engine-step timing, per-node GPU/RoCE/NVMe/paging
state and token output timecodes or generated text.

Use **FULL SCREEN** in the page header for the presentation view. It enters a
single 1920 × 1080 Canvas2D surface modelled after the offline video generator:
the full expert matrix, per-node sparklines, step-time gauge, coverage, token
arrival log and routing continuity remain visible together. The browser scales
that fixed 16:9 surface without upscaling past FHD, so it stays pixel-correct
on FHD output and letterboxes cleanly on other display sizes. Press Escape to
leave it.

The trace-data path has no SSH, Grafana, Prometheus or InfluxDB dependency:

```text
vLLM V2 runner
  └─ experts-*.idx.jsonl + .u8 on the head's SSD
          │ read-only, latest file/flush, bounded catch-up
          └─ same-host sparkDash
                  └─ existing /ws → subscribed browser
```

sparkDash resolves the Head/Worker ids from its registry rather than
hard-coding names or addresses. The Head must be marked **Local** and be the
machine running sparkDash. Docker reads its recorder through the existing
`/host/root:ro` mount; bare-metal sparkDash reads the current user's home. The
automatic Docker path assumes `/home/<Head SSH user>/.cache/huggingface/tokentrace`
on the host (`/root/...` for root). Set `TOKENTRACE_DIR` when the host uses a
different home layout or recorder location.

The routed-expert log itself is local. Metrics for a remote Worker still use
sparkDash's normal SSH collector, so key/passwordless SSH is required when
those per-node GPU/RoCE/NVMe/paging rows are wanted.

## Demand-driven flush

The tailer opens the active `.idx.jsonl` and matching `.u8` read-only, skips
old history, emits the latest complete step, then follows appended index
lines. It holds a shared advisory lock on its read-only index descriptor while at least one browser
is subscribed. The recorder detects that lock without changing file data and
shortens its buffered flush interval from 2 seconds to 50 ms. Closing the last
browser releases the lock and restores the normal interval. Binary data is
flushed before its index line, and the reader retries a step if its declared
byte range is not visible yet.

Large prefill/concurrent steps are bounded to eight rows per request in the
live view. The authoritative SSD log remains complete.

## Setup

1. Register the two Sparks as a **Local Head** and its linked Worker in
   sparkDash.
2. Run sparkDash on the Head. The production Compose host-root mount is
   already sufficient and remains read-only.
3. Start DeepSeek with `DSPARK_TOKENTRACE_EXPERTS=1`.
4. Open `http://<sparkdash>:5555/tokentrace`. File handles and the subscriber
   lock exist only while at least one page is subscribed.

When using Compose, put the `TOKENTRACE_*` settings in `.env`; the provided
production and development Compose files explicitly forward them into the
container.

Routing, accepted/rejected counts, and accepted token IDs come from the runner
files. `TOKENTRACE_TOKEN_OUTPUT=detokenize` converts those IDs back to text via
the local OpenAI-compatible server's `/detokenize` endpoint; set
`TOKENTRACE_MODEL` to the served model name and optionally override
`TOKENTRACE_DETOKENIZE_URL`. The default `metadata` mode never decodes or sends
generated text. GPU, temperature, power, RoCE, NVMe, swap-in and major-fault
rates come from sparkDash's existing snapshots. GB10 does not expose a usable
NVML memory-controller utilization counter, so that metric is omitted when it
reports the unsupported constant zero.
The header is wall-clock `HH:MM:SS.ss`, for example `23:18:25.28`.

For laptop/CI layout work, `TOKENTRACE_DEMO=1` generates a deterministic
route stream. It is independent of `SPARKDASH_DEMO=1`, which supplies the two
machine snapshots.
