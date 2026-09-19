# vLLM native metrics

Prometheus job `vllm` scrapes the inference server's own `/metrics` through a
small read-only proxy on the head node. It sits alongside the `sparkdash` job,
which keeps covering the hosts (GPU, power, RDMA, storage) and the LLM view the
dashboard already had.

## Why a second path to the same numbers

The two nodes hold one 300B-class checkpoint at a time — 184 GiB of weights on
121 GiB per node — so the pair is switched between DeepSeek-v4-Flash and
GLM-5.3-Flash, both serving on port 8888. That makes per-model attribution the
whole problem, and vLLM solves it for free:

| | `sparkdash_llm_*` | `vllm:*` |
|---|---|---|
| Token totals | accumulated across restarts by sparkDash | raw counters; Prometheus handles the resets |
| Model attribution | series keyed by spark + port + model (fixed 2026-09-18; it was spark + port, so a switch continued the other model's total) | `model_name` label comes from vLLM itself |
| input / cached-input | two counters, one subtracted from the other | `prompt_tokens_by_source_total{source=...}` splits it at the source |
| Latencies | one precomputed p95 | real histograms — any quantile at query time |
| Speculative decoding | one acceptance ratio | drafted / accepted, and accepted per draft position |
| Needs the backend up | no (last value persists) | yes (`vllm_metrics_proxy_upstream_up` says which) |

## Two engines, one set of names

Most deployments on this pair run vLLM; Qwen3.8-27B runs SGLang, which exports the same quantities
as `sglang:*` with labels of its own. A panel written against `vllm:*` therefore goes blank exactly
when SGLang is serving — which is how the 27B came to show no token graphs at all while its
counters were in Prometheus the whole time.

`../prometheus/rules/llm-engines.yml` records both engines under `llm:*`, so the dashboard asks for
a quantity rather than an engine:

| neutral | vLLM | SGLang |
|---|---|---|
| `llm:prompt_tokens_total` | `vllm:prompt_tokens_total` | `sglang:prompt_tokens_total` |
| `llm:generation_tokens_total` | `vllm:generation_tokens_total` | `sglang:generation_tokens_total` |
| `llm:prompt_cached_tokens_total` | `vllm:prompt_tokens_by_source_total{source="local_cache_hit"}` | `sglang:cached_tokens_total` |
| `llm:prompt_uncached_tokens_total` | `source="local_compute"` | total − cached |
| `llm:num_requests_running` / `_waiting` | same names | `sglang:num_running_reqs` / `num_queue_reqs` |
| `llm:kv_cache_usage_ratio` | `vllm:kv_cache_usage_perc` | `sglang:token_usage` |
| `llm:*_seconds_bucket` (TTFT, ITL, e2e) | same names | same names, `sglang:` prefix |

Preemptions, waiting-by-reason, speculative acceptance and the prefix-cache ratio stay vLLM-only:
SGLang either does not export them or exports something that is not the same measurement, and a
neutral name over two different measurements is worse than a blank panel.

## Both nodes, when both nodes serve

A pair deployment runs one model across two nodes and only rank 0 has an API, so one proxy on the
head is the whole story. The 27B is the exception — two independent servers, one per node — and
scraping only the head halved its token counts. `dgx02` therefore runs the same proxy, scraped as
job `vllm-worker` at `10.10.10.22:9106` over WireGuard (it is not reachable on the LAN). While a
pair deployment serves, that target reports `vllm_metrics_proxy_upstream_up 0`, which is correct
and not an outage: the worker is headless and has no metrics of its own.

## The token identity

vLLM splits the prompt side into where each token came from, and the parts sum
to the total:

```promql
vllm:prompt_tokens_total
  == sum(vllm:prompt_tokens_by_source_total)  by model_name
       source="local_compute"        tokens that had to be computed
       source="local_cache_hit"      served from the prefix cache
       source="external_kv_transfer" arrived over a KV connector
```

Verified on this pair on 2026-09-18 (GLM-5.3-Flash, MTP k=3):

```
vllm:prompt_tokens_total - on(model_name) sum by (model_name) (vllm:prompt_tokens_by_source_total)  ->  0
```

So cached-input never has to be derived by subtracting two counters that are
updated independently and can briefly read negative between scrapes. Output is
`vllm:generation_tokens_total`.

**Prefix-cache hits arrive a whole block at a time.** This recipe runs
`--block-size 2304`, which vLLM resolves to a 4608-token scheduler block on
this hybrid checkpoint, so a repeated prompt shorter than that reports no hits
at all. Measured: the same 9,145-token prompt twice in a row produced 0 hits;
the same 31,939-token prompt twice produced 23,040 hits (5 x 4608) and cut the
wall time from 29.6 s to 7.0 s. A cached-input series that sits at zero is
usually prompts below one block, not a broken metric.

## Deploy

On the head node (rank 0 — the worker is `--headless` and has no API server):

```bash
mkdir -p ~/vllm-metrics ~/.config/systemd/user
cp vllm_metrics_proxy.py ~/vllm-metrics/
cp vllm-metrics-proxy.service ~/.config/systemd/user/
loginctl enable-linger $USER
systemctl --user daemon-reload && systemctl --user enable --now vllm-metrics-proxy
curl -s localhost:9106/metrics | grep vllm_metrics_proxy_upstream_up
```

Then add the target to `../prometheus/prometheus.yml` (job `vllm`) and reload
Prometheus (`curl -XPOST localhost:9090/-/reload`).

The proxy serves `GET /metrics` and nothing else — every other path is a 404 —
so the inference API stays bound to 127.0.0.1 with nothing in front of it,
which is what `cluster.env` intends. A backend that is down reports
`vllm_metrics_proxy_upstream_up 0` with a 200 rather than failing the scrape:
switching models is routine here, and a hard failure would make every switch
look like a dead target.

## Queries the dashboard uses

```promql
# tokens over the dashboard range, per model — reset-safe and per-model correct
sum by (model_name) (increase(vllm:prompt_tokens_total[$__range]))
sum by (model_name) (increase(vllm:prompt_tokens_by_source_total{source="local_cache_hit"}[$__range]))
sum by (model_name) (increase(vllm:generation_tokens_total[$__range]))

# decode tok/s from the counter (a burst between scrapes is not lost)
sum by (model_name) (rate(vllm:generation_tokens_total[1m]))

# KV pool occupancy (0-1) and the queue, split by why a request is waiting
vllm:kv_cache_usage_perc
vllm:num_requests_waiting_by_reason

# MTP draft acceptance overall, and per draft position — what says whether
# MTP_NUM_TOKENS should go up or down
sum by (model_name) (increase(vllm:spec_decode_num_accepted_tokens_total[5m]))
  / sum by (model_name) (increase(vllm:spec_decode_num_draft_tokens_total[5m]))
sum by (model_name, position) (increase(vllm:spec_decode_num_accepted_tokens_per_pos_total[5m]))

# any quantile, from the histogram
histogram_quantile(0.95, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[5m])))
```

`vllm:cache_config_info` carries the boot-time facts as labels —
`kv_cache_size_tokens`, `kv_cache_max_concurrency`, the resolved `block_size`,
`cache_dtype` — which is the quickest way to confirm what the engine actually
resolved from `cluster.env`.
