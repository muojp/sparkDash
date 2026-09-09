#!/usr/bin/env python3
"""RDMA link probe exporter.

Every INTERVAL seconds (default 30 min), when the link is idle, runs a short
perftest pair against the peer node over the TP RoCE link and exposes the
measured throughput and latency as Prometheus metrics on :PORT/metrics.

  ib_write_bw  -D BW_DURATION   -> available bandwidth (Gb/s)
  ib_write_lat -n LAT_ITERS     -> RDMA write latency percentiles (usec)

Both are measured in BOTH directions (local->peer and peer->local) as separate
series: RDMA write performance has been seen to degrade on one node only, and
a one-way probe cannot tell which side is at fault.

The counter-based dashboard panels average bursts away and beat against the
2 s sysfs poll / 5 s scrape cadence, so they cannot show headroom. This probe
measures it directly. It never runs while the LLM has requests in flight or
while the link is carrying traffic, so it does not disturb inference.

Peer side: the perftest server is started on demand over SSH for each run
(perftest servers exit after one client), so nothing has to stay resident on
the peer.
"""

import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CFG = {
    "PORT": int(os.environ.get("RDMA_PROBE_PORT", "9105")),
    "INTERVAL": float(os.environ.get("RDMA_PROBE_INTERVAL", "1800")),
    "RETRY": float(os.environ.get("RDMA_PROBE_BUSY_RETRY", "30")),
    "HCA": os.environ.get("RDMA_PROBE_HCA", "rocep1s0f0"),
    "IB_PORT": os.environ.get("RDMA_PROBE_IB_PORT", "1"),
    "PEER": os.environ.get("RDMA_PROBE_PEER", "dgx02"),
    "PEER_SSH": os.environ.get("RDMA_PROBE_PEER_SSH", "dgx02"),
    "PEER_IP": os.environ.get("RDMA_PROBE_PEER_IP", "192.168.100.40"),
    "LOCAL": os.environ.get("RDMA_PROBE_LOCAL", os.uname().nodename),
    "LOCAL_IP": os.environ.get("RDMA_PROBE_LOCAL_IP", "192.168.100.30"),
    "PEER_HCA": os.environ.get("RDMA_PROBE_PEER_HCA", os.environ.get("RDMA_PROBE_HCA", "rocep1s0f0")),
    "BW_DURATION": int(os.environ.get("RDMA_PROBE_BW_DURATION", "2")),
    "LAT_ITERS": int(os.environ.get("RDMA_PROBE_LAT_ITERS", "500000")),
    "BW_PORT": int(os.environ.get("RDMA_PROBE_BW_PORT", "18515")),
    "LAT_PORT": int(os.environ.get("RDMA_PROBE_LAT_PORT", "18516")),
    "SPARKDASH": os.environ.get("RDMA_PROBE_SPARKDASH_METRICS", "http://127.0.0.1:5555/metrics"),
    "IDLE_BPS": float(os.environ.get("RDMA_PROBE_IDLE_BPS", "50e6")),
    "CMD_TIMEOUT": float(os.environ.get("RDMA_PROBE_CMD_TIMEOUT", "30")),
}

LABELS = f'hca="{CFG["HCA"]}",peer="{CFG["PEER"]}"'
DIRECTIONS = {  # key -> (src, dst)
    "fwd": (CFG["LOCAL"], CFG["PEER"]),
    "rev": (CFG["PEER"], CFG["LOCAL"]),
}
LAT_FIELDS = ["min", "max", "typical", "avg", "stdev", "p99", "p999"]

state_lock = threading.Lock()
state = {
    "bw": {},   # direction -> (msg_bytes, bps)
    "lat": {},  # direction -> {stat: usec}
    "last_run": 0.0,
    "last_success": 0.0,
    "last_duration": 0.0,
    "success": 0,
    "runs": 0,
    "failures": 0,
    "skipped": 0,
    "skip_reason": "",
    "error": "",
}


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S ") + msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- idle gate

def read_port_bytes():
    base = f"/sys/class/infiniband/{CFG['HCA']}/ports/{CFG['IB_PORT']}/counters"
    total = 0
    for name in ("port_xmit_data", "port_rcv_data"):
        with open(os.path.join(base, name)) as fh:
            total += int(fh.read().strip()) * 4  # counters are in 4-byte lanes
    return total


def link_busy():
    """True if the link is carrying traffic (sampled over one second)."""
    a = read_port_bytes()
    time.sleep(1.0)
    b = read_port_bytes()
    bps = 8 * (b - a)
    return bps > CFG["IDLE_BPS"], bps


def llm_busy():
    """True if sparkDash reports in-flight or queued LLM requests."""
    try:
        with urllib.request.urlopen(CFG["SPARKDASH"], timeout=3) as r:
            body = r.read().decode("utf-8", "replace")
    except Exception as e:  # sparkDash down: fall back to link counters only
        log(f"sparkdash metrics unavailable ({e}); relying on link counters")
        return False, "unavailable"
    n = 0.0
    for line in body.splitlines():
        if line.startswith("sparkdash_llm_requests_running{") or line.startswith("sparkdash_llm_requests_waiting{"):
            try:
                n += float(line.rsplit(" ", 1)[1])
            except ValueError:
                pass
    return n > 0, f"requests={n:g}"


# ---------------------------------------------------------------- perftest

def start_peer_server(tool, port, extra):
    cmd = (
        # '^' anchor: must not match the remote shell that runs this pkill.
        f"pkill -f '^{tool} .*-p {port}( |$)' 2>/dev/null; "
        f"nohup {tool} -d {CFG['PEER_HCA']} -i {CFG['IB_PORT']} -F -p {port} {extra} "
        f">/dev/null 2>&1 </dev/null &"
    )
    subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", CFG["PEER_SSH"], cmd],
        check=True, timeout=15, capture_output=True,
    )


def stop_peer_server(tool, port):
    try:
        subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", CFG["PEER_SSH"],
             f"pkill -f '^{tool} .*-p {port}( |$)' 2>/dev/null; true"],
            timeout=15, capture_output=True,
        )
    except Exception:
        pass


def start_local_server(tool, port, extra):
    cmd = [tool, "-d", CFG["HCA"], "-i", CFG["IB_PORT"], "-F", "-p", str(port)] + extra
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)


def stop_local_server(proc):
    if proc.poll() is None:
        proc.kill()
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def run_client(tool, port, extra, remote=False):
    """Run the perftest client locally (against the peer) or on the peer over SSH (against us)."""
    if remote:
        inner = " ".join([tool, "-d", CFG["PEER_HCA"], "-i", CFG["IB_PORT"], "-F", "-p", str(port)] + extra + [CFG["LOCAL_IP"]])
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", CFG["PEER_SSH"], inner]
    else:
        cmd = [tool, "-d", CFG["HCA"], "-i", CFG["IB_PORT"], "-F", "-p", str(port)] + extra + [CFG["PEER_IP"]]
    last = None
    for attempt in range(4):
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=CFG["CMD_TIMEOUT"])
        if r.returncode == 0:
            return r.stdout
        last = (r.stdout + r.stderr).strip()
        if "Couldn't connect" in last or "Unable to init" in last:
            time.sleep(0.5)  # peer server not listening yet
            continue
        break
    raise RuntimeError(f"{tool} failed: {last[-300:] if last else 'no output'}")


NUM = r"([0-9]+(?:\.[0-9]+)?)"


def parse_bw(out):
    # #bytes  #iterations  BW peak[Gb/sec]  BW average[Gb/sec]  MsgRate[Mpps]
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+" + NUM + r"\s+" + NUM + r"\s+" + NUM + r"\s*$", line)
        if m:
            return int(m.group(1)), float(m.group(4)) * 1e9
    raise RuntimeError("could not parse ib_write_bw output: " + out[-300:])


def parse_lat(out):
    # #bytes #iterations t_min t_max t_typical t_avg t_stdev 99% 99.9%
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+" + r"\s+".join([NUM] * 7) + r"\s*$", line)
        if m:
            return dict(zip(LAT_FIELDS, (float(m.group(i)) for i in range(3, 10))))
    raise RuntimeError("could not parse ib_write_lat output: " + out[-300:])


def measure(tool, port, extra, direction):
    """One perftest run. fwd: server on peer, client here. rev: server here, client on peer."""
    if direction == "fwd":
        try:
            start_peer_server(tool, port, " ".join(extra))
            time.sleep(0.7)
            return run_client(tool, port, extra)
        finally:
            stop_peer_server(tool, port)
    srv = start_local_server(tool, port, extra)
    try:
        time.sleep(0.7)
        return run_client(tool, port, extra, remote=True)
    finally:
        stop_local_server(srv)


def probe_once():
    results = {"bw": {}, "lat": {}}
    bw_extra = ["-D", str(CFG["BW_DURATION"]), "--report_gbits"]
    lat_extra = ["-n", str(CFG["LAT_ITERS"])]
    for direction in DIRECTIONS:
        results["bw"][direction] = parse_bw(measure("ib_write_bw", CFG["BW_PORT"], bw_extra, direction))
        results["lat"][direction] = parse_lat(measure("ib_write_lat", CFG["LAT_PORT"], lat_extra, direction))
    return results


# ---------------------------------------------------------------- scheduler

def probe_loop():
    next_at = time.time() + 5
    while True:
        now = time.time()
        if now < next_at:
            time.sleep(min(next_at - now, 5))
            continue

        busy, why = llm_busy()
        if not busy:
            busy, bps = link_busy()
            why = f"link {bps/1e6:.0f} Mb/s"
        if busy:
            with state_lock:
                state["skipped"] += 1
                state["skip_reason"] = why
            log(f"skip: busy ({why}); retry in {CFG['RETRY']:.0f}s")
            next_at = time.time() + CFG["RETRY"]
            continue

        t0 = time.time()
        try:
            res = probe_once()
            dt = time.time() - t0
            with state_lock:
                state.update(
                    bw=res["bw"], lat=res["lat"],
                    last_run=t0, last_success=t0, last_duration=dt, success=1, error="",
                    skip_reason="",
                )
                state["runs"] += 1
            summary = ", ".join(
                f"{DIRECTIONS[d][0]}->{DIRECTIONS[d][1]} {res['bw'][d][1]/1e9:.1f} Gb/s "
                f"lat typ {res['lat'][d]['typical']:.2f} us p99 {res['lat'][d]['p99']:.2f} us"
                for d in DIRECTIONS)
            log(f"ok: {summary} ({dt:.1f}s)")
        except Exception as e:
            dt = time.time() - t0
            with state_lock:
                state.update(last_run=t0, last_duration=dt, success=0, error=str(e)[:200])
                state["runs"] += 1
                state["failures"] += 1
            log(f"fail: {e}")
        next_at = t0 + CFG["INTERVAL"]


# ---------------------------------------------------------------- exporter

def render():
    with state_lock:
        s = dict(state)
    L = LABELS
    out = []

    def m(name, typ, help_, lines):
        out.append(f"# HELP {name} {help_}")
        out.append(f"# TYPE {name} {typ}")
        out.extend(lines)

    def dl(d):
        src, dst = DIRECTIONS[d]
        return f'{L},src="{src}",dst="{dst}"'

    if s["bw"]:
        m("sparkdash_rdma_probe_bandwidth_bps", "gauge",
          f"ib_write_bw average over {CFG['BW_DURATION']}s, RC, single QP, src writes to dst (bits/s)",
          [f"sparkdash_rdma_probe_bandwidth_bps{{{dl(d)},msg_bytes=\"{v[0]}\"}} {v[1]:.0f}"
           for d, v in s["bw"].items()])
    if s["lat"]:
        m("sparkdash_rdma_probe_latency_seconds", "gauge",
          f"ib_write_lat 2-byte RDMA write latency measured at src, {CFG['LAT_ITERS']} iterations (seconds)",
          [f"sparkdash_rdma_probe_latency_seconds{{{dl(d)},stat=\"{k}\"}} {v*1e-6:.9g}"
           for d, lat in s["lat"].items() for k, v in lat.items()])
    m("sparkdash_rdma_probe_success", "gauge", "1 if the most recent probe run succeeded",
      [f"sparkdash_rdma_probe_success{{{L}}} {s['success']}"])
    m("sparkdash_rdma_probe_last_run_timestamp_seconds", "gauge", "Unix time of the most recent probe attempt",
      [f"sparkdash_rdma_probe_last_run_timestamp_seconds{{{L}}} {s['last_run']:.0f}"])
    m("sparkdash_rdma_probe_last_success_timestamp_seconds", "gauge", "Unix time of the most recent successful probe",
      [f"sparkdash_rdma_probe_last_success_timestamp_seconds{{{L}}} {s['last_success']:.0f}"])
    m("sparkdash_rdma_probe_duration_seconds", "gauge", "Wall time of the most recent probe run",
      [f"sparkdash_rdma_probe_duration_seconds{{{L}}} {s['last_duration']:.2f}"])
    m("sparkdash_rdma_probe_runs_total", "counter", "Probe attempts",
      [f"sparkdash_rdma_probe_runs_total{{{L}}} {s['runs']}"])
    m("sparkdash_rdma_probe_failures_total", "counter", "Probe attempts that failed",
      [f"sparkdash_rdma_probe_failures_total{{{L}}} {s['failures']}"])
    m("sparkdash_rdma_probe_skipped_total", "counter", "Probe slots skipped because the link or LLM was busy",
      [f"sparkdash_rdma_probe_skipped_total{{{L}}} {s['skipped']}"])
    m("sparkdash_rdma_probe_interval_seconds", "gauge", "Configured probe interval",
      [f"sparkdash_rdma_probe_interval_seconds{{{L}}} {CFG['INTERVAL']:.0f}"])
    return "\n".join(out) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] not in ("/metrics", "/"):
            self.send_response(404)
            self.end_headers()
            return
        body = render().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # quiet
        pass


def main():
    log(f"rdma-probe exporter on :{CFG['PORT']} hca={CFG['HCA']} peer={CFG['PEER']} ({CFG['PEER_IP']}) "
        f"interval={CFG['INTERVAL']:.0f}s bw={CFG['BW_DURATION']}s lat_iters={CFG['LAT_ITERS']}")
    threading.Thread(target=probe_loop, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", CFG["PORT"]), Handler).serve_forever()


if __name__ == "__main__":
    main()
