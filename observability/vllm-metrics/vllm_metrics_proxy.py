#!/usr/bin/env python3
"""vLLM metrics proxy.

Re-serves the inference server's own Prometheus endpoint on a LAN port so
Prometheus can scrape `vllm:*` directly, without moving the inference API off
loopback. This recipe binds vLLM to 127.0.0.1 on purpose (no auth in front of
it), and `/metrics` is the only path that has to leave the host.

GET /metrics  -> upstream's text exposition verbatim, plus this proxy's own
                three series. Every other path and method is refused: nothing
                here can reach /v1/*, so exposing this port does not expose
                the model.

Why scrape vLLM directly when sparkDash already re-exports the same numbers:

  * vLLM labels every series with `model_name`, so a counter reset caused by
    switching models on the same port lands in a *different* series. Token
    totals therefore stay attributable per model with no bookkeeping. The
    sparkDash lifetime store keys on spark:port only, so a switch continues
    the previous model's totals (see observability/README.md).
  * `vllm:prompt_tokens_by_source_total{source=...}` splits prompt tokens into
    local_compute / local_cache_hit / external_kv_transfer, and the parts sum
    to `vllm:prompt_tokens_total`. That is a closed accounting of
    input / cached-input, with no subtraction of two independently updated
    counters (which can briefly go negative between scrapes).
  * The latency families arrive as real histograms, so any quantile can be
    computed at query time rather than the single p95 the probe precomputes.

Upstream being down is reported as `vllm_metrics_proxy_upstream_up 0` with a
200, not as a scrape failure: the pair is switched between models by design,
and a hard failure would turn every switch into a dead target.

  VLLM_METRICS_PROXY_PORT      listen port                (default 9106)
  VLLM_METRICS_PROXY_BIND      listen address             (default 0.0.0.0)
  VLLM_METRICS_UPSTREAM        upstream metrics URL       (default http://127.0.0.1:8888/metrics)
  VLLM_METRICS_PROXY_TIMEOUT   upstream timeout, seconds  (default 5)
"""

import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CFG = {
    "PORT": int(os.environ.get("VLLM_METRICS_PROXY_PORT", "9106")),
    "BIND": os.environ.get("VLLM_METRICS_PROXY_BIND", "0.0.0.0"),
    "UPSTREAM": os.environ.get("VLLM_METRICS_UPSTREAM", "http://127.0.0.1:8888/metrics"),
    "TIMEOUT": float(os.environ.get("VLLM_METRICS_PROXY_TIMEOUT", "5")),
}

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

SELF_HELP = """\
# HELP vllm_metrics_proxy_upstream_up 1 when the vLLM metrics endpoint answered the last scrape
# TYPE vllm_metrics_proxy_upstream_up gauge
vllm_metrics_proxy_upstream_up {up}
# HELP vllm_metrics_proxy_scrape_duration_seconds Time the proxy spent fetching the upstream endpoint
# TYPE vllm_metrics_proxy_scrape_duration_seconds gauge
vllm_metrics_proxy_scrape_duration_seconds {duration:.6f}
# HELP vllm_metrics_proxy_upstream_bytes Size of the last successful upstream response
# TYPE vllm_metrics_proxy_upstream_bytes gauge
vllm_metrics_proxy_upstream_bytes {size}
"""


def fetch():
    """Return (body, up, duration, size). Never raises: a down backend is data, not an error."""
    started = time.monotonic()
    try:
        with urllib.request.urlopen(CFG["UPSTREAM"], timeout=CFG["TIMEOUT"]) as response:
            body = response.read().decode("utf-8", "replace")
        duration = time.monotonic() - started
        return body, 1, duration, len(body)
    except (urllib.error.URLError, OSError, ValueError):
        return "", 0, time.monotonic() - started, 0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/metrics":
            self.send_error(404, "only /metrics is served")
            return
        body, up, duration, size = fetch()
        payload = (body + SELF_HELP.format(up=up, duration=duration, size=size)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPE)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):  # noqa: N802 - the base class spells it this way
        self.send_error(405, "read-only")

    def log_message(self, fmt, *args):  # keep the journal to real events
        pass


def main():
    print(
        f"vllm-metrics-proxy: {CFG['BIND']}:{CFG['PORT']}/metrics -> {CFG['UPSTREAM']}",
        flush=True,
    )
    ThreadingHTTPServer((CFG["BIND"], CFG["PORT"]), Handler).serve_forever()


if __name__ == "__main__":
    main()
