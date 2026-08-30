/**
 * sshExec — centralized SSH command execution.
 * Supports both key-based and password-based (sshpass) authentication.
 *
 * Keeps one non-interactive shell open per target and serializes commands over
 * its stdin/stdout.  This is important on monitored hosts: opening a fresh SSH
 * connection for every metric domain creates several PAM/systemd-logind/D-Bus
 * sessions per second and can make long-lived system daemons grow without bound.
 * Password auth uses sshpass -e (password via env), not -p on the command line.
 */
import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import fs from "fs";
import { COMFY_PORT, COMFY_PROBE_TIMEOUT_MS, SSH_CONNECT_TIMEOUT } from "../config.js";
import { isAllowedTargetHost, isValidSshUser } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";

// Detect sshpass without shelling out to `which` on every cold call —
// checking PATH entries directly is faster and avoids spawning a shell.
let _sshpassAvailable = null;
const _connections = new Map();
const MAX_COMMAND_OUTPUT = 10 * 1024 * 1024;
function sshpassAvailable() {
  if (_sshpassAvailable !== null) return _sshpassAvailable;
  try {
    const candidates = [
      "/usr/bin/sshpass",
      "/usr/local/bin/sshpass",
      "/bin/sshpass",
      "/opt/homebrew/bin/sshpass",
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          _sshpassAvailable = true;
          return _sshpassAvailable;
        }
      } catch {
        /* ignore */
      }
    }
    // Fall back to a PATH scan in case sshpass lives somewhere unusual.
    const pathDirs = (process.env.PATH || "").split(":");
    for (const dir of pathDirs) {
      if (!dir) continue;
      try {
        const candidate = `${dir}/sshpass`;
        if (fs.existsSync(candidate)) {
          _sshpassAvailable = true;
          return _sshpassAvailable;
        }
      } catch {
        /* ignore */
      }
    }
    _sshpassAvailable = false;
  } catch {
    _sshpassAvailable = false;
  }
  return _sshpassAvailable;
}

/**
 * A single authenticated SSH connection with one remote bash process. Commands
 * run in isolated subshells, preserving the old sshExec semantics while
 * avoiding a new PAM/login session for every collector poll.
 */
export class PersistentSshConnection {
  constructor({ file, args, env, targetHost, spawnImpl = spawn }) {
    this.file = file;
    this.args = args;
    this.env = env;
    this.targetHost = targetHost;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.queue = [];
    this.active = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
  }

  run(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, timeoutMs, resolve, reject });
      this._pump();
    });
  }

  _spawn() {
    const child = this.spawnImpl(this.file, this.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(String(chunk)));
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += String(chunk);
      if (this.stderrBuffer.length > MAX_COMMAND_OUTPUT) {
        this.stderrBuffer = this.stderrBuffer.slice(-MAX_COMMAND_OUTPUT);
      }
    });
    child.on("error", (err) => this._failAll(err));
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      const detail = this.stderrBuffer.trim() || `connection closed (${signal || code})`;
      this._failAll(new Error(detail));
    });
  }

  _pump() {
    if (this.active || this.queue.length === 0) return;
    if (!this.child || this.child.exitCode != null || this.child.killed) this._spawn();

    const job = this.queue.shift();
    const token = randomBytes(12).toString("hex");
    const begin = `__SPARKDASH_BEGIN_${token}__`;
    const end = `__SPARKDASH_END_${token}__`;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.active = { ...job, begin, end, began: false, timer: null };
    this.active.timer = setTimeout(() => {
      this._failAll(new Error(`command timed out after ${job.timeoutMs}ms`));
    }, job.timeoutMs);

    // The subshell prevents `cd`, variable assignments, or `exit` in one
    // collector command from leaking into (or terminating) the shared shell.
    const script = [
      `printf '%s\\n' '${begin}'`,
      "(",
      job.cmd,
      ")",
      "__sparkdash_rc=$?",
      `printf '\\n%s:%s\\n' '${end}' "$__sparkdash_rc"`,
      "",
    ].join("\n");

    const child = this.child;
    child.stdin.write(script, (err) => {
      if (err && this.child === child) this._failAll(err);
    });
  }

  _onStdout(chunk) {
    const active = this.active;
    if (!active) return;
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_COMMAND_OUTPUT) {
      this._failAll(new Error(`command output exceeded ${MAX_COMMAND_OUTPUT} bytes`));
      return;
    }

    if (!active.began) {
      const beginAt = this.stdoutBuffer.indexOf(`${active.begin}\n`);
      if (beginAt < 0) return;
      this.stdoutBuffer = this.stdoutBuffer.slice(beginAt + active.begin.length + 1);
      active.began = true;
    }

    const marker = `\n${active.end}:`;
    const endAt = this.stdoutBuffer.indexOf(marker);
    if (endAt < 0) return;
    const statusStart = endAt + marker.length;
    const statusEnd = this.stdoutBuffer.indexOf("\n", statusStart);
    if (statusEnd < 0) return;

    const output = this.stdoutBuffer.slice(0, endAt).trim();
    const status = Number.parseInt(this.stdoutBuffer.slice(statusStart, statusEnd), 10);
    clearTimeout(active.timer);
    this.active = null;
    this.stdoutBuffer = this.stdoutBuffer.slice(statusEnd + 1);
    const stderr = this.stderrBuffer.trim();
    this.stderrBuffer = "";

    if (status === 0) active.resolve(output);
    else active.reject(new Error(`SSH to ${this.targetHost} failed: ${stderr || `remote command exited ${status}`}`));
    queueMicrotask(() => this._pump());
  }

  _failAll(reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const wrapped = new Error(`SSH to ${this.targetHost} failed: ${this.stderrBuffer.trim() || error.message}`);
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGKILL");
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(wrapped);
      this.active = null;
    }
    for (const job of this.queue.splice(0)) job.reject(wrapped);
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
  }
}

function connectionKey({ targetHost, user, auth, password, identityFile }) {
  const secretFingerprint = createHash("sha256").update(password || "").digest("hex").slice(0, 16);
  return [targetHost, user, auth || "key", identityFile || "", secretFingerprint].join("\0");
}

/**
 * Execute a command on a remote Spark via SSH.
 *
 * @param {Object} spark - Spark config object
 * @param {string} cmd - Command to execute (passed as a single remote argv via bash -c)
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>} - Trimmed stdout
 */
export async function sshExec(spark, cmd, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const { host, user, auth, password } = spark.ssh || {};
  const targetHost = host || spark.lanIp;

  if (!targetHost || !user) {
    throw new Error(`SSH config missing for ${spark.id}: host=${targetHost}, user=${user}`);
  }

  if (!isAllowedTargetHost(targetHost)) {
    throw new Error(`SSH host not allowed: ${targetHost}`);
  }
  if (!isValidSshUser(user)) {
    throw new Error(`SSH user not allowed: ${user}`);
  }

  if (typeof cmd !== "string" || !cmd) {
    throw new Error("SSH command must be a non-empty string");
  }

  // Base SSH options (no shell metacharacters in argv). One remote bash stays
  // alive and carries every command, so keepalives detect a dead path quickly.
  // accept-new: trust first-seen host key (LAN ops); pin known_hosts for stricter envs
  const baseOpts = [
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-T",
  ];

  const remote = `${user}@${targetHost}`;
  // Remote command as a single argument — ssh does not invoke a local shell for it
  // when using execFile without a shell. `--` stops option parsing before destination.
  let file;
  let args;
  // Minimal child env — only what ssh/sshpass actually need. Spreading the full
  // `process.env` would leak every host var (AWS_*, GITHUB_TOKEN, etc.) into the
  // child; this whitelist scopes to PATH, HOME, USER/LOGNAME (ssh logging +
  // known_hosts mixing), TERM, and SSH_AUTH_SOCK so agent-forwarded key auth
  // still works. SSHPASS is added below only for password auth.
  const env = {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME || "/root",
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TERM: process.env.TERM || "xterm",
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  };

  if (auth === "pass") {
    if (!password) {
      throw new Error(
        `SSH password auth selected for ${spark.id} but no password is set (Edit Spark once — passwords are stored encrypted and survive restarts)`
      );
    }
    if (!sshpassAvailable()) {
      throw new Error(`sshpass is not installed. Install it with: sudo apt-get install sshpass`);
    }
    // Password via env (sshpass -e) — never on argv or in process list as -p
    env.SSHPASS = password;
    file = "sshpass";
    args = ["-e", "ssh", ...baseOpts, "--", remote, "bash --noprofile --norc"];
  } else {
    // Key-based SSH (default) — BatchMode prevents hanging on missing keys
    file = "ssh";
    args = [...baseOpts, "-o", "BatchMode=yes"];
    const identityFile = process.env.SSH_IDENTITY_FILE;
    if (identityFile) {
      args.push("-i", identityFile);
    }
    args.push("--", remote, "bash --noprofile --norc");
  }

  const key = connectionKey({ targetHost, user, auth, password, identityFile: process.env.SSH_IDENTITY_FILE });
  let connection = _connections.get(key);
  if (!connection) {
    connection = new PersistentSshConnection({ file, args, env, targetHost });
    _connections.set(key, connection);
  }
  return connection.run(cmd, timeoutMs);
}

/**
 * Test SSH connectivity to a Spark.
 * Returns { ok: boolean, message: string }
 */
export async function sshTest(spark) {
  try {
    const result = await sshExec(spark, "echo ok");
    return { ok: result === "ok", message: result };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/**
 * Test LLM server connectivity on a single port.
 * Returns { ok: boolean, message: string }
 *
 * `port` is required at call sites today (both pass `resolveLlmPort(spark)`).
 * We accept `null`/`undefined` defensively and resolve from `spark.llmPort`
 * so any future caller that forgets the arg can't silently hit port 8888.
 */
export async function llmTest(spark, port) {
  try {
    const host = llmProbeHost(spark);
    if (!isAllowedTargetHost(host)) {
      return { ok: false, message: `Invalid or disallowed LLM host: ${host}` };
    }
    const resolvedPort =
      Number.isInteger(port) && port >= 1 && port <= 65535
        ? port
        : Number(spark?.llmPorts?.[0] || spark?.llmPort) || 8888;
    const url = `http://${host}:${resolvedPort}/v1/models`;
    /** @type {Record<string, string>} */
    const headers = {};
    const apiKey =
      spark?.llmApiKeys?.[String(resolvedPort)] ||
      spark?.llmApiKeys?.[resolvedPort] ||
      null;
    if (apiKey) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "Auth required (set API key in LLM Settings)" };
    }
    return { ok: res.ok, message: `Model: ${data?.data?.[0]?.id || "unknown"}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/**
 * Test LLM connectivity on all configured ports.
 * Returns { ok: boolean, ports: { port, ok, message }[] }
 */
export async function llmTestAll(spark) {
  const ports = spark.llmPorts || (spark.llmPort ? [spark.llmPort] : [8888]);
  const results = await Promise.all(
    ports.map(async (port) => {
      const result = await llmTest(spark, port);
      return { port, ...result };
    })
  );
  const allOk = results.every((r) => r.ok);
  return { ok: allOk, ports: results };
}

/**
 * Test ComfyUI connectivity on a single port (GET /system_stats).
 * Returns { ok: boolean, message: string, skipped?: boolean }
 */
export async function comfyTest(spark, port) {
  try {
    const host = llmProbeHost(spark);
    if (!isAllowedTargetHost(host)) {
      return { ok: false, message: `Invalid or disallowed ComfyUI host: ${host}` };
    }
    const resolvedPort =
      Number.isInteger(port) && port >= 1 && port <= 65535
        ? port
        : Number(spark?.comfyPort) || COMFY_PORT;
    const url = `http://${host}:${resolvedPort}/system_stats`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}` };
    }
    const ver = data?.system?.comfyui_version;
    return {
      ok: true,
      message: ver ? `ComfyUI ${ver}` : "reachable",
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
