// Exercise real Node signals and the live listener against local relay/PDS sockets.
// No credentials, model calls, or live chat records are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { encode, toBytes } from "@atcute/cbor";
import { CODEC_DCBOR, create, toCidLink, toString } from "@atcute/cid";
import { writeCarStream } from "@atcute/car";

const BOT = "did:plc:wyvvl5ftfap4225hytnsvpia";
const STREAMER = "did:plc:2zmxikig2sj7gqaezl5gntae";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Integration safety deadlines only: fake timers cannot advance OS sockets/signals
// or the independent Node child. Successful paths await events, never fixed sleeps.
async function within<T>(promise: Promise<T>, ms = 3000, label = "process/socket"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function timerFrame(): Promise<{ frame: Buffer; cid: string }> {
  const bytes = encode({
    $type: "place.stream.chat.message",
    text: "!timer",
    streamer: STREAMER,
    createdAt: new Date().toISOString(),
  });
  const cid = await create(CODEC_DCBOR, bytes);
  const chunks: Uint8Array[] = [];
  for await (const chunk of writeCarStream([toCidLink(cid)], [{ cid: cid.bytes, data: bytes }])) chunks.push(chunk);
  const payload = Buffer.concat([
    encode({ op: 1, t: "#commit" }),
    encode({
      repo: STREAMER,
      seq: 1,
      ops: [{ action: "create", path: "place.stream.chat.message/3mzzzzzzzzzz2", cid: toCidLink(cid) }],
      blocks: toBytes(Buffer.concat(chunks)),
    }),
  ]);
  // Server-to-client WebSocket binary frame, unmasked.
  const header = Buffer.alloc(4);
  header[0] = 0x82;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return { frame: Buffer.concat([header, payload]), cid: toString(cid) };
}

async function listener(t: TestContext, options: { blockWrite?: boolean; rejectRelay?: boolean; timeoutMs?: number } = {}) {
  const connected = deferred<void>();
  const closed = deferred<void>();
  const writeStarted = deferred<void>();
  const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const sockets = new Set<Socket>();
  const message = await timerFrame();
  let send = () => {};
  let releaseWrite = () => {};
  let writes = 0;
  let output = "";
  const token = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify({ sub: BOT, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
    "test-signature",
  ].join(".");
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.url === "/xrpc/com.atproto.server.createSession") {
      response.end(JSON.stringify({ did: BOT, handle: "fairway.cheeky.town", accessJwt: token, refreshJwt: token, active: true }));
    } else if (request.url === "/xrpc/com.atproto.repo.createRecord") {
      writes += 1;
      const finish = () => response.end(JSON.stringify({ uri: `at://${BOT}/place.stream.chat.message/3mzzzzzzzzzz3`, cid: message.cid }));
      if (writes === 1) {
        releaseWrite = finish;
        writeStarted.resolve();
      } else {
        finish();
      }
    } else {
      response.writeHead(404).end(JSON.stringify({ error: "NotFound" }));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.once("close", () => closed.resolve());
    if (options.rejectRelay) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      connected.resolve();
      return;
    }
    const key = request.headers["sec-websocket-key"]!;
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    send = () => { if (!socket.destroyed) socket.write(message.frame); };
    // Respond to the listener's close handshake rather than holding its socket open.
    socket.on("data", (data: Buffer) => { if ((data[0]! & 0x0f) === 8) socket.end(Buffer.from([0x88, 0x00])); });
    connected.resolve();
    if (options.blockWrite) send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { ...process.env };
  for (const key of ["BOT_PASSWORD", "BOT_PASSWORD_FILE", "OPENROUTER_API_KEY", "OPENROUTER_API_KEY_FILE", "NODE_OPTIONS"]) delete env[key];
  Object.assign(env, {
    BOT_IDENTIFIER: BOT,
    BOT_SERVICE: `http://${base}`,
    STREAMER_DID: STREAMER,
    RELAY_URL: `ws://${base}`,
    SHUTDOWN_TIMEOUT_MS: String(options.timeoutMs ?? 2000),
  });
  if (options.blockWrite) env.BOT_PASSWORD = "test-password";
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  child.once("error", exited.reject);
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await within(exited.promise).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await within(connected.promise).catch((error) => { throw new Error(`${error}\n${output}`); });
  return {
    child,
    exited: exited.promise,
    closed: closed.promise,
    writeStarted: writeStarted.promise,
    releaseWrite: () => releaseWrite(),
    send: () => send(),
    writes: () => writes,
    output: () => output,
  };
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} closes an idle relay and exits successfully`, { timeout: 10000 }, async (t) => {
    const running = await listener(t);
    running.child.kill(signal);
    const result = await within(running.exited);
    assert.deepEqual(result, { code: 0, signal: null }, running.output());
    await within(running.closed);
  });
}

test("SIGTERM drains an in-flight write and ignores repeated signals", { timeout: 10000 }, async (t) => {
  const running = await listener(t, { blockWrite: true });
  await within(running.writeStarted, 3000, "pending PDS write").catch((error) => { throw new Error(`${error}\n${running.output()}`); });
  running.send(); // Queue more work while the first write is still pending.
  running.child.kill("SIGTERM");
  await within(running.closed, 3000, "relay close after SIGTERM").catch((error) => { throw new Error(`${error}\n${running.output()}`); });
  running.child.kill("SIGTERM");
  assert.equal(running.child.exitCode, null, running.output());
  assert.equal(running.child.signalCode, null, running.output());
  running.releaseWrite();
  assert.deepEqual(await within(running.exited), { code: 0, signal: null }, running.output());
  assert.equal(running.writes(), 1, "queued relay work was accepted after shutdown began");
});

test("shutdown bounds a write that never completes", { timeout: 10000 }, async (t) => {
  // Deliberately exercise the child process's real shutdown deadline, not the parent clock.
  const running = await listener(t, { blockWrite: true, timeoutMs: 100 });
  await within(running.writeStarted);
  running.child.kill("SIGTERM");
  assert.deepEqual(await within(running.exited), { code: 1, signal: null }, running.output());
});

test("SIGTERM also stops a disconnected relay's reconnect loop", { timeout: 10000 }, async (t) => {
  const running = await listener(t, { rejectRelay: true });
  running.child.kill("SIGTERM");
  assert.deepEqual(await within(running.exited), { code: 0, signal: null }, running.output());
});
