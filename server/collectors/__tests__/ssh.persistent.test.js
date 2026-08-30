import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { PersistentSshConnection } from "../ssh.js";

class FakeChild extends EventEmitter {
  constructor(onWrite) {
    super();
    this.exitCode = null;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        onWrite(String(chunk), this);
        callback();
      },
    });
  }

  kill(signal) {
    if (this.killed) return;
    this.killed = true;
    this.exitCode = 137;
    this.emit("close", null, signal);
  }
}

function markers(script) {
  return {
    begin: script.match(/__SPARKDASH_BEGIN_[0-9a-f]+__/)?.[0],
    end: script.match(/__SPARKDASH_END_[0-9a-f]+__/)?.[0],
  };
}

function respond(child, script, output, status = 0) {
  const { begin, end } = markers(script);
  assert.ok(begin && end);
  child.stdout.write(`${begin}\n${output}\n${end}:${status}\n`);
}

test("PersistentSshConnection reuses one remote shell and returns command output", async () => {
  const spawns = [];
  const writes = [];
  const connection = new PersistentSshConnection({
    file: "ssh",
    args: ["host", "bash --noprofile --norc"],
    env: {},
    targetHost: "host",
    spawnImpl: (file, args) => {
      spawns.push({ file, args });
      return new FakeChild((script, child) => {
        writes.push(script);
        respond(child, script, writes.length === 1 ? "first" : "second");
      });
    },
  });

  assert.equal(await connection.run("echo first", 1000), "first");
  assert.equal(await connection.run("echo second", 1000), "second");
  assert.equal(spawns.length, 1);
  assert.equal(writes.length, 2);
  assert.match(writes[0], /\(\necho first\n\)/);
});

test("PersistentSshConnection serializes concurrent collector commands", async () => {
  const writes = [];
  let child;
  const connection = new PersistentSshConnection({
    file: "ssh",
    args: [],
    env: {},
    targetHost: "worker",
    spawnImpl: () => {
      child = new FakeChild((script) => writes.push(script));
      return child;
    },
  });

  const first = connection.run("slow-command", 1000);
  const second = connection.run("next-command", 1000);
  assert.equal(writes.length, 1);
  respond(child, writes[0], "one");
  assert.equal(await first, "one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
  respond(child, writes[1], "two");
  assert.equal(await second, "two");
});

test("PersistentSshConnection rejects a non-zero remote status and keeps the shell", async () => {
  let child;
  let writes = 0;
  const connection = new PersistentSshConnection({
    file: "ssh",
    args: [],
    env: {},
    targetHost: "worker",
    spawnImpl: () => {
      child = new FakeChild((script) => {
        writes += 1;
        respond(child, script, writes === 1 ? "bad" : "ok", writes === 1 ? 7 : 0);
      });
      return child;
    },
  });

  await assert.rejects(connection.run("false", 1000), /remote command exited 7/);
  assert.equal(await connection.run("true", 1000), "ok");
  assert.equal(writes, 2);
});

test("PersistentSshConnection drops a timed-out shell and reconnects on the next poll", async () => {
  let spawns = 0;
  const connection = new PersistentSshConnection({
    file: "ssh",
    args: [],
    env: {},
    targetHost: "worker",
    spawnImpl: () => {
      spawns += 1;
      return new FakeChild((script, child) => {
        if (spawns > 1) respond(child, script, "recovered");
      });
    },
  });

  await assert.rejects(connection.run("hang", 10), /timed out/);
  assert.equal(await connection.run("echo recovered", 1000), "recovered");
  assert.equal(spawns, 2);
});
