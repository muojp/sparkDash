# Exporting sparkDash metrics to Grafana (Prometheus / InfluxDB)

sparkDash keeps no metric history of its own (only in-browser sparklines and
the LLM daily rollup). This document describes the two built-in exporters
that put every value the dashboard shows into a time-series database, and a
ready-made local mini-stack for trying it out. This entire integration is an
optional add-on: stock DGX Spark environments do not include Prometheus or
Grafana, and sparkDash's normal UI (including TokenTrace Live) does not need
either service.

```txt
                       pull (scrape)                       ┌──────────┐
   ┌────────────┐  GET /metrics  ┌────────────┐            │          │
   │  sparkDash │ ◄───────────── │ Prometheus │ ◄───────── │          │
   │   :5555    │                └────────────┘   PromQL   │ Grafana  │
   │            │  POST /api/v2/write   ┌──────────┐       │  :3000   │
   │            │ ────────────────────► │ InfluxDB │ ◄──── │          │
   └────────────┘   push, every N s     └──────────┘  Flux └──────────┘
```

| Path | Model | Enabled by | What you get |
|------|-------|------------|--------------|
| **Prometheus** | pull — Prometheus scrapes `GET /metrics` | opt in with `PROMETHEUS_METRICS=true` | text exposition 0.0.4, one family per metric, `sparkdash_` prefix |
| **InfluxDB** | push — sparkDash POSTs line protocol on a timer | `INFLUX_URL` + `INFLUX_BUCKET` | one measurement per domain (`sparkdash_gpu`, `sparkdash_llm`, …), unit + device labels as tags |

Both are fed by the same snapshot the WebSocket UI uses (`orderedSnapshots()`
in `server/index.js`), converted once in `server/exporters/flatten.js`. The
push timer is independent of the WebSocket broadcast — an idle GPU keeps
producing points even though the UI broadcast dedupes unchanged snapshots.
No browser needs to be open; the SparkMonitor poll loops always run.

## 1. Enable on a real deployment

### Prometheus (pull, optional)

1. Set `PROMETHEUS_METRICS=true`, then make sure the listener is reachable
   from Prometheus: `BIND_HOST=0.0.0.0`
   (already set in `docker-compose.yml`). `/metrics` is read-only but, like the
   rest of the API, unauthenticated — keep it on the trusted LAN.
2. Add a scrape job:

   ```yaml
   scrape_configs:
     - job_name: sparkdash
       scrape_interval: 5s          # SparkMonitor polls every 2 s; 5 s is plenty
       static_configs:
         - targets: ["sparkdash.example.lan:5555"] # sparkDash, NOT each monitored unit
   ```

   One sparkDash instance exposes **all** its units; label `spark` (the id,
   e.g. `dgx01`) and `name` distinguish them.
3. Check: `curl -s http://<sparkdash>:5555/metrics | head` and
   `promtool check metrics < <(curl -s http://<sparkdash>:5555/metrics)`.

### InfluxDB (push)

Set the env (in `.env`, or under `environment:` in `docker-compose.yml`):

```bash
INFLUX_URL=http://influxdb.lan:8086
INFLUX_ORG=sparkdash
INFLUX_BUCKET=sparkdash
INFLUX_TOKEN=<write token>
INFLUX_INTERVAL_MS=5000        # default 10000
```

InfluxDB 1.8 works too through its v2-compatible write API:
`INFLUX_ORG=""`, `INFLUX_BUCKET="dbname/rp"`, `INFLUX_TOKEN="user:password"`.

Check: `curl -s http://<sparkdash>:5555/api/exporters` → `influx.last.ok`
should be `true` with `status: 204`. Write failures are logged once and then
every 30th attempt so a down Influx does not flood the log.

### Environment reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PROMETHEUS_METRICS` | `false` | Opt in to Prometheus text format |
| `PROMETHEUS_METRICS_PATH` | `/metrics` | Path of the scrape endpoint |
| `METRICS_PREFIX` | `sparkdash_` | Metric name / measurement prefix (both exporters) |
| `INFLUX_URL` | _(unset = off)_ | InfluxDB base URL |
| `INFLUX_ORG` | `""` | Org (v2) |
| `INFLUX_BUCKET` | `""` | Bucket (v2) or `db/rp` (1.8) — required |
| `INFLUX_TOKEN` | `""` | API token (v2) or `user:pass` (1.8) |
| `INFLUX_INTERVAL_MS` | `10000` | Push cadence (min 1000) |
| `INFLUX_TIMEOUT_MS` | `5000` | Per-write HTTP timeout |
| `CLOCK_CAP_MONITORING` | `false` | Poll the [gb10-clock-cap](https://github.com/agjs/gb10-clock-cap) unit state over SSH (read-only `systemctl is-enabled/is-active` + SM clock) and export `gpu_clock_cap_*` |
| `POLL_INTERVAL_CLOCK_CAP` | `60000` | Clock-cap poll cadence (one SSH round-trip per unit) |
| `CLOCK_CAP_PROBE_TIMEOUT_MS` | `10000` | Timeout for that SSH call |
| `SPARKDASH_DEMO` | `false` | Synthetic metrics for every unit (no SSH / nvidia-smi) |

## 2. Metric catalog

All names below carry the `sparkdash_` prefix in Prometheus. In InfluxDB the
first token is the measurement and the rest is the field
(`gpu_temperature_celsius` → `sparkdash_gpu` / `temperature_celsius`;
`unified_memory_*` and `system_power_*` are kept whole; `up` and
`uptime_seconds` live in `sparkdash_unit`). `*_info` metrics are Prometheus-only;
in InfluxDB the same facts are tags on the regular points.

Labels / tags on every series: `spark` (id), `name`, `kind` (`spark`|`host`).

| Family | Metrics | Extra labels |
|--------|---------|--------------|
| unit | `up`, `uptime_seconds`, `unit_info` (labels `role`, `lan_ip`, `device`, `gpu_chip`, `cpu_model`, `cuda_driver`, `worker_label`, `worker_head`) | |
| gpu | `gpu_temperature_celsius`, `gpu_usage_percent`, `gpu_power_draw_watts`, `gpu_power_limit_watts`, `system_power_draw_watts`, `gpu_vram_{used,total,available}_bytes`, `gpu_vram_usage_percent`, `gpu_throttle_active`, `gpu_throttle_reason` (0 ok/1 thermal/2 power/3 hw/4 unknown), `gpu_sm_clock_mhz`, `gpu_sm_clock_max_mhz`, `gpu_sm_clock_percent` | |
| gpu processes | `gpu_process_vram_bytes` | `pid`, `process` |
| gpu clock cap (opt-in) | `gpu_clock_cap_installed`, `gpu_clock_cap_enabled`, `gpu_clock_cap_active`, `gpu_clock_cap_sm_clock_mhz` — from `SparkMonitor.snapshot().clockCap`, polled every `POLL_INTERVAL_CLOCK_CAP` | |
| cpu | `cpu_usage_percent`, `cpu_temperature_celsius`, `cpu_power_draw_watts`, `cpu_tdp_watts` | |
| ram | `ram_{used,total}_bytes`, `ram_usage_percent` | |
| unified memory | `unified_memory_{total,gpu_used,cpu_used,used,available}_bytes`, `unified_memory_usage_percent`, `unified_memory_oom_risk` (0/1/2), `unified_memory_bandwidth_gbps`, `unified_memory_bandwidth_peak_gbps` | |
| storage | `storage_{used,total,available}_bytes`, `storage_usage_percent`, `storage_{read,write}_bytes_per_second`, `storage_{read,write}_bytes_total` (counter, local units) | `device`, `label` |
| rdma | `rdma_{receive,transmit}_bytes_total` (counter, IB `port_*_data` × 4), `rdma_{receive,transmit}_packets_total` (counter), `rdma_{receive,transmit}_bytes_per_second`, `rdma_link_speed_mbps`, `rdma_port_active` — from `/sys/class/infiniband/<hca>/ports/<n>`. NCCL over RoCE is RDMA and **bypasses the kernel network stack**, so TP traffic may not appear in `/proc/net/dev` / `network_*`; use this family for the fabric path. Empty on hosts without an IB subsystem | `hca`, `port` |
| network | `network_primary_interface_info`, `network_link_speed_mbps`, `network_{receive,transmit}_bytes_per_second`, `network_{receive,transmit}_bytes_total` (counter), `network_interface_up` | `interface` |
| llm (per port) | `llm_available`, `llm_slots_active`, `llm_slots_max`, `llm_generation_tokens_per_second`, `llm_prefill_tokens_per_second`, `llm_{cached,uncached}_prefill_tokens_per_second`, `llm_{decode,prefill,output}_tokens_total` (counters), `llm_context_length`, `llm_gpu_memory_utilization_ratio`, `llm_kv_cache_usage_ratio`, `llm_requests_{running,waiting}`, `llm_{ttft,e2e,itl}_p95_seconds`, `llm_preemptions_total` (counter), `llm_prefix_cache_hit_ratio`, `llm_mtp_acceptance_ratio`, `llm_posture_level` (+ `auth`, `scope`) | `port`, `backend`, `model` |
| comfy | `comfy_available`, `comfy_queue_{running,pending}`, `comfy_progress_percent`, `comfy_queue_eta_seconds` | `port` |
| tailscale | `tailscale_available`, `tailscale_online`, `tailscale_key_expired` | |
| hermes | `hermes_installed`, `hermes_update_available`, `hermes_behind_commits` | |

Conventions: MB values from the collectors are converted to bytes (×1024²);
devices in `disabledDevices` / interfaces in `disabledInterfaces` are not
exported (same filter as the UI main view); optional backend fields (vLLM-only
p95s etc.) are omitted rather than exported as 0; non-finite values are dropped.
The `llm_{decode,prefill,output}_tokens_total` series are built only from
backend-owned cumulative counters; sparkDash never integrates the live tok/s
gauges to synthesize one. sparkDash persists each raw counter and accumulated
total in `config/llm-lifetime.json`, then adds only its increment. When a
backend restart makes a counter decrease, the new value is treated as the
increment since reset, so the exported counter remains monotonic across both
inference-backend and sparkDash restarts. (A reset and complete catch-up
past the old value between two polls cannot be detected.)

Each stored series is keyed by **spark, port and model** — the same tuple that
labels the exported series — so a total can never be credited to a series
other than the one it was measured on. This matters wherever one port serves
different models at different times: a 2x DGX Spark pair holds one 300B-class
checkpoint at a time, so switching between, say, DeepSeek-v4-Flash and
GLM-5.3-Flash on port 8888 is the normal way to run them. Keyed on spark and
port alone (before 2026-09-18) such a switch read as one backend that kept
resetting, and the incoming model inherited the outgoing model's lifetime
total under its own `model` label. An entry written before the split is
adopted by the running model when its input counter has not gone backwards
(same process, so those totals are its own) and otherwise parked under a
`…:__pre_model_split__` key, since nothing in the file says which model earned
it. For per-model token accounting straight from the backend — including the
`local_compute` / `local_cache_hit` split of the prompt side — scrape vLLM's
own endpoint as well; see `../observability/vllm-metrics/README.md`.
For example, llama.cpp's per-request `/slots` values reset when slots are
reused, so no lifetime token series is emitted for that path. Decode and output
intentionally share the generation-token source, but both names are exported
so Grafana queries can match the corresponding live panels.
`llm_output_tokens_total` can therefore be used as before:
`rate(sparkdash_llm_output_tokens_total[5m])` gives a low-noise tok/s average independent of the
probe's own rate estimate.

**Rates vs counters — which to graph.** The `*_bytes_per_second` gauges are
what the dashboard shows: the collector's rate over its last ~2 s poll
window, sampled whenever Prometheus scrapes. An interface burst that
starts and ends between two scrapes is simply not in that series. The
`*_bytes_total` counters come straight from `/proc/net/dev` /
`/sys/block/*/stat`, so `rate(sparkdash_network_receive_bytes_total[1m])`
(or `increase(...[1h])` for "how much moved") reconstructs throughput with
no lost bytes — only the time resolution is bounded by the scrape interval.
Use the counters for anything you'll look at after the fact; the gauges for
"what is it doing right now". In InfluxDB the same fields are
`sparkdash_network` / `receive_bytes_total` etc. — use `derivative(nonNegative: true)`.

## 3. Local mini-stack (Prometheus + InfluxDB 2 + Grafana)

`observability/` contains a compose file plus provisioning so Grafana comes
up with both datasources and a fleet dashboard already wired.

```bash
# 1. Start the stack
cd observability && docker compose up -d && cd ..

# 2. Run sparkDash in demo mode (synthetic metrics for 3 fake units,
#    binds 0.0.0.0 so Prometheus can reach host.docker.internal:5555)
set -a; . observability/.env.demo; set +a
npm start            # or: node server/index.js

# 3. Look
open http://localhost:3000/d/sparkdash-overview   # admin / sparkdash
open http://localhost:9090/targets                # sparkdash target should be UP
open http://localhost:5555                        # the normal dashboard, demo data
```

Verification one-liners:

```bash
curl -s localhost:5555/metrics | promtool check metrics          # lint
curl -s localhost:5555/api/exporters                              # push status
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sparkdash_gpu_usage_percent'
curl -s -XPOST 'localhost:8086/api/v2/query?org=sparkdash' \
  -H 'Authorization: Token sparkdash-dev-token' -H 'Content-Type: application/vnd.flux' \
  --data 'from(bucket:"sparkdash") |> range(start:-2m) |> filter(fn:(r)=> r._measurement=="sparkdash_gpu") |> last()'
```

The shipped `prometheus.yml` targets `host.docker.internal:5555`, with a Linux
`host-gateway` mapping supplied by Compose. Edit that target when sparkDash
runs on another host. The mini-stack ports bind to `127.0.0.1` by default;
change the port mappings and all development credentials before intentionally
exposing it on a network.

Demo mode details: `SPARKDASH_DEMO=1` makes every `SparkMonitor` use
`server/collectors/DemoCollector.js` (random walks seeded per unit id) instead
of `SystemCollector` / `LlmProbe`. `observability/.env.demo` also redirects
`sparks.json` / `settings.json` / `llm-daily.json` into `observability/demo/`
so your real `config/` is untouched. Demo addresses and SSH users are inert
fixtures: demo collectors never connect to them. The Grafana login and Influx
token in the compose file are development defaults — change them before
exposing the stack.

### Retention and long-term dashboards

Both stores keep **180 days** (`--storage.tsdb.retention.time=180d`,
`DOCKER_INFLUXDB_INIT_RETENTION: 180d`). Prometheus picks the flag up on
restart; the InfluxDB env only applies at first setup, so change an existing
bucket via the API:

```bash
BID=$(curl -s 'http://localhost:8086/api/v2/buckets?name=sparkdash' -H "Authorization: Token $INFLUX_TOKEN" | jq -r '.buckets[0].id')
curl -X PATCH "http://localhost:8086/api/v2/buckets/$BID" -H "Authorization: Token $INFLUX_TOKEN" \
  -H 'Content-Type: application/json' -d '{"retentionRules":[{"type":"expire","everySeconds":15552000}]}'
```

Rough footprint at the current cadence (2 units, ~130 samples every 5 s):
Prometheus ≈ 1–2 GB / 180 d, InfluxDB of the same order.

Prometheus samples, InfluxDB points, and Grafana's database live in the named
volumes `prom-data`, `influx-data`, and `grafana-data`. A normal
`docker compose down` preserves them; `docker compose down -v` deletes them.
Back up the volumes when the history must survive host or disk loss. Dashboard
definitions under `observability/grafana/provisioning/` are source-controlled,
but provisioning alone does not back up historical metrics.

The periodic clock-cap probe and both exporters are observation only. The
existing per-unit sparkDash action can start or stop `gb10-clock-cap.service`
through its on-demand API when the host has the narrowly scoped passwordless
sudo rule; it never changes boot enablement. The service itself must be
installed and enabled separately on every applicable host. Neither Grafana nor
Prometheus is needed to apply or toggle the cap.

### RDMA link probe (headroom on the TP link)

The RoCE throughput panel is `rate()` over sparkDash's byte counters. sparkDash
polls sysfs every 2 s and Prometheus scrapes every 5 s, so successive scrape
deltas alternate between ~6 s and ~4 s worth of traffic: any "instantaneous"
rate derived from the counters is off by ±20 % even under steady load, and a
1 m average hides bursts entirely. Neither can tell you how much of the link is
still available.

`observability/rdma-probe/` measures that directly. A small exporter on the
head node runs `ib_write_bw -D 2` and `ib_write_lat -n 500000` against the
worker over the TP HCA every 30 minutes, in **both directions** (RDMA write
performance has been seen to degrade on one node only), **only when** sparkDash reports no
running or queued LLM requests and the link has been idle for a second, and
serves the result on `:9105/metrics`:

| Metric | Meaning |
|---|---|
| `sparkdash_rdma_probe_bandwidth_bps{hca,src,dst,msg_bytes}` | 2 s `ib_write_bw` average, single RC QP, `src` writes to `dst` |
| `sparkdash_rdma_probe_latency_seconds{hca,src,dst,stat}` | `ib_write_lat` 2-byte write measured at `src`: `min` `max` `typical` `avg` `stdev` `p99` `p999` |
| `sparkdash_rdma_probe_success`, `..._last_success_timestamp_seconds` | freshness of the value above |
| `sparkdash_rdma_probe_runs_total`, `..._failures_total`, `..._skipped_total` | attempts, failures, slots skipped because busy |

For each run the perftest server (forward direction) or client (reverse
direction) is started on the peer over SSH, so only the head node needs a
service. Install (per-user systemd, no root):

```bash
scp observability/rdma-probe/rdma_probe_exporter.py dgx01:~/rdma-probe/
scp observability/rdma-probe/rdma-probe.service   dgx01:~/.config/systemd/user/
ssh dgx01 'loginctl enable-linger $USER && systemctl --user daemon-reload && systemctl --user enable --now rdma-probe'
```

HCA, peer, interval and durations are `Environment=` lines in the unit. The
`rdma-probe` scrape job in `prometheus/prometheus.yml` points at the head node;
the dashboard's *RDMA link probe* panels plot the probe next to the 1 m
counter average so utilisation vs. headroom is visible at a glance. A single
QP tops out around 109 Gb/s on DGX Spark (PCIe-bound, not the 200 G link);
raise `-q` in the exporter if you want the wire limit instead.

## 4. Design notes

* **Why not `prom-client`?** The metric set is fixed and described in one
  table (`METRICS` in `flatten.js`); a 60-line renderer keeps the runtime image
  dependency-free, matching how sparkDash already parses vLLM's `/metrics` with
  its own regexes.
* **Why env, not `settings.json` / the UI?** The Influx token is a secret and
  `PUT /api/settings` is unauthenticated. Targets are infrastructure config,
  like `BIND_HOST`.
* **Why an independent push timer?** `startBroadcast()` skips byte-identical
  snapshots; piggy-backing on it would leave holes in the series while values
  are stable. `SparkMonitor.snapshot()` deliberately has no timestamp for the
  same reason — the exporters stamp `Date.now()` at export time.
* **Hot config** is honoured automatically: units added / removed / edited in
  the UI show up in the next scrape or push because both read
  `orderedSnapshots()` live.
