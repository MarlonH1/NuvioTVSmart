// End-to-end hub test over real WebSockets: a fake phone, a fake Nuvio app, a fake TV adapter.
// Needs Node 22+ (global WebSocket client).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { attachWebSocketServer } = require("../lib/ws");
const { createHub } = require("../lib/hub");
const { createStore } = require("../lib/store");
const { createTv, readVolume } = require("../lib/tv");
const net = require("node:net");

// Same request the Magisk watcher sends: HTTP/1.0 over a raw socket, read line by line.
function openWatch(port, token) {
  const socket = net.connect(port, "127.0.0.1");
  socket.write(`GET /watch?token=${token} HTTP/1.0\r\n\r\n`);
  let buffer = "";
  let raw = "";
  const lines = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    raw += chunk.toString();
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("{")) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else lines.push(message);
    }
  });
  const ended = new Promise((resolve) => socket.on("close", () => resolve(raw)));
  return {
    socket,
    ended,
    next: () =>
      lines.length
        ? Promise.resolve(lines.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("timeout waiting for watch line")),
              2000
            );
            waiters.push((m) => {
              clearTimeout(timer);
              resolve(m);
            });
          })
  };
}

function fakeTv() {
  const calls = [];
  return {
    calls,
    level: 20,
    muted: false,
    info: () => Promise.resolve({ name: "Wohnzimmer", model: "OLED42C3" }),
    volume(action) {
      calls.push("volume:" + action);
      if (action === "up") this.level += 1;
      if (action === "down") this.level -= 1;
      if (action === "mute") this.muted = true;
      if (action === "unmute") this.muted = false;
      return Promise.resolve({ ok: true, level: this.level, muted: this.muted });
    },
    launchApp() {
      calls.push("launch");
      return Promise.resolve({ ok: true });
    },
    showCode(code) {
      calls.push("showCode");
      this.code = code;
      return Promise.resolve();
    },
    hideCode() {
      calls.push("hideCode");
      return Promise.resolve();
    }
  };
}

class Client {
  constructor(url) {
    this.inbox = [];
    this.waiters = [];
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const index = this.waiters.findIndex((w) => w.match(message));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
      else this.inbox.push(message);
    };
    this.opened = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
  }
  send(message) {
    this.socket.send(JSON.stringify(Object.assign({ v: 1 }, message)));
  }
  next(type, predicate) {
    const match = (m) => m.type === type && (!predicate || predicate(m));
    const index = this.inbox.findIndex(match);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for " + type)), 2000);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        }
      });
    });
  }
  close() {
    this.socket.close();
  }
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuvio-remote-"));
  const tv = fakeTv();
  const store = createStore(path.join(dir, "state.json"));
  const hub = createHub({ tv, store });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/watch")) hub.handleWatch(req, res);
    else res.end();
  });
  const ws = attachWebSocketServer(server, { paths: ["/ws", "/app"] }, hub.handleConnection);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "ws://127.0.0.1:" + server.address().port;
  const clients = [];
  const connect = async (p) => {
    const client = new Client(base + p);
    clients.push(client);
    await client.opened;
    return client;
  };
  const teardown = () => {
    clients.forEach((c) => c.close());
    ws.stop();
    hub.stop();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { tv, hub, store, dir, connect, teardown, port: server.address().port };
}

async function pairPhone(env) {
  const phone = await env.connect("/ws");
  phone.send({ type: "hello", client: { id: "p1", name: "Pixel", platform: "android" } });
  const welcome = await phone.next("welcome");
  assert.strictEqual(welcome.paired, false);
  phone.send({ type: "pair.begin" });
  await waitFor(() => env.tv.code);
  phone.send({ type: "pair.confirm", code: env.tv.code });
  const ok = await phone.next("pair.ok");
  return { phone, token: ok.token, welcome };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met");
}

test("pairing issues a token that survives reconnects; wrong codes are rejected", async () => {
  const env = await setup();
  try {
    const phone = await env.connect("/ws");
    phone.send({ type: "hello", client: { id: "p1", name: "Pixel", platform: "android" } });
    const welcome = await phone.next("welcome");
    assert.strictEqual(welcome.tv.name, "Wohnzimmer");
    assert.strictEqual(welcome.tv.model, "OLED42C3");

    phone.send({ type: "cmd", action: "pause", id: "x" });
    const denied = await phone.next("error");
    assert.strictEqual(denied.code, "not_paired");
    assert.strictEqual(denied.id, "x");

    phone.send({ type: "pair.begin" });
    await waitFor(() => env.tv.code);
    phone.send({ type: "pair.confirm", code: env.tv.code === "000000" ? "111111" : "000000" });
    assert.strictEqual((await phone.next("error")).code, "bad_code");
    phone.send({ type: "pair.confirm", code: env.tv.code });
    const ok = await phone.next("pair.ok");
    assert.match(ok.token, /^[0-9a-f]{48}$/);
    assert.ok(env.tv.calls.includes("hideCode"));

    const again = await env.connect("/ws");
    again.send({
      type: "hello",
      token: ok.token,
      client: { id: "p1", name: "Pixel", platform: "android" }
    });
    assert.strictEqual((await again.next("welcome")).paired, true);
    assert.strictEqual((await again.next("state")).playback.status, "idle");
    assert.strictEqual((await again.next("volume.state")).level, null);

    const stranger = await env.connect("/ws");
    stranger.send({ type: "hello", token: "nope" });
    assert.strictEqual((await stranger.next("welcome")).paired, false);
  } finally {
    env.teardown();
  }
});

test("five wrong codes roll a new code", async () => {
  const env = await setup();
  try {
    const phone = await env.connect("/ws");
    phone.send({ type: "hello" });
    await phone.next("welcome");
    phone.send({ type: "pair.begin" });
    await waitFor(() => env.tv.code);
    const shows = () => env.tv.calls.filter((c) => c === "showCode").length;
    for (let i = 0; i < 5; i++) {
      phone.send({ type: "pair.confirm", code: "wrong" });
      await phone.next("error");
    }
    assert.strictEqual(shows(), 2);
  } finally {
    env.teardown();
  }
});

test("play while Nuvio is closed launches it and delivers the request once the app connects", async () => {
  const env = await setup();
  try {
    const { phone } = await pairPhone(env);
    const request = {
      media: { type: "series", title: "Game of Thrones", season: 1, episode: 9 },
      stream: { url: "https://example.com/v.mkv" },
      startPositionMs: 1000
    };
    phone.send({ type: "play", request });
    const loading = await phone.next("state", (m) => m.playback.status === "loading");
    assert.strictEqual(loading.playback.media.title, "Game of Thrones");
    await waitFor(() => env.tv.calls.includes("launch"));

    const app = await env.connect("/app");
    app.send({ type: "app.hello", version: "test" });
    const delivered = await app.next("play");
    assert.deepStrictEqual(delivered.request, request);

    app.send({
      type: "state",
      playback: {
        status: "playing",
        positionMs: 5000,
        durationMs: 60000,
        at: Date.now(),
        media: request.media
      }
    });
    const playing = await phone.next("state", (m) => m.playback.status === "playing");
    assert.strictEqual(playing.playback.positionMs, 5000);
    assert.deepStrictEqual(playing.playback.audioTracks, []);

    phone.send({ type: "cmd", action: "seek", positionMs: 120000 });
    const cmd = await app.next("cmd");
    assert.strictEqual(cmd.action, "seek");
    assert.strictEqual(cmd.positionMs, 120000);

    app.close();
    await phone.next("state", (m) => m.playback.status === "idle");
    phone.send({ type: "cmd", action: "pause", id: "p" });
    assert.strictEqual((await phone.next("error")).code, "no_player");
  } finally {
    env.teardown();
  }
});

test("pairing code is shown inside the app when it is running", async () => {
  const env = await setup();
  try {
    const app = await env.connect("/app");
    app.send({ type: "app.hello" });
    const phone = await env.connect("/ws");
    phone.send({ type: "hello", client: { id: "p2", name: "iPhone", platform: "ios" } });
    await phone.next("welcome");
    phone.send({ type: "pair.begin" });
    const shown = await app.next("pair.show");
    assert.strictEqual(shown.clientName, "iPhone");
    assert.match(shown.code, /^\d{6}$/);
    phone.close();
    await app.next("pair.hide");
  } finally {
    env.teardown();
  }
});

test("volume changes are broadcast to every paired phone", async () => {
  const env = await setup();
  try {
    const { phone, token } = await pairPhone(env);
    const second = await env.connect("/ws");
    second.send({ type: "hello", token });
    await second.next("welcome");
    await second.next("volume.state");
    phone.send({ type: "volume", action: "up" });
    assert.strictEqual((await second.next("volume.state")).level, 21);
    phone.send({ type: "volume", action: "mute" });
    assert.strictEqual((await phone.next("volume.state", (m) => m.muted)).muted, true);
  } finally {
    env.teardown();
  }
});

test("tv adapter falls back between luna APIs and parses volume replies", async () => {
  const seen = [];
  const tv = createTv({
    appId: "space.nuvio.webos",
    call: (uri, params) => {
      seen.push(uri);
      if (uri.includes("master/volumeUp"))
        return Promise.resolve({ returnValue: false, errorText: "denied" });
      if (uri.endsWith("com.webos.audio/volumeUp")) return Promise.resolve({ returnValue: true });
      if (uri.endsWith("com.webos.audio/getVolume"))
        return Promise.resolve({ returnValue: true, volume: 69, muteStatus: false });
      return Promise.resolve({ returnValue: false });
    }
  });
  const result = await tv.volume("up");
  assert.deepStrictEqual(result, { ok: true, level: 69, muted: false, error: null });
  assert.deepStrictEqual(seen, [
    "luna://com.webos.service.audio/master/volumeUp",
    "luna://com.webos.audio/volumeUp",
    "luna://com.webos.audio/getVolume"
  ]);
  assert.deepStrictEqual(readVolume({ volumeStatus: { volume: 5, muteStatus: true } }), {
    level: 5,
    muted: true
  });
});

test("watch stream reports only playback start/stop and rejects unknown tokens", async () => {
  const env = await setup();
  try {
    const stranger = openWatch(env.port, "nope");
    assert.match(await stranger.ended, /401/);

    const { phone, token } = await pairPhone(env);
    const watch = openWatch(env.port, token);
    assert.deepStrictEqual(await watch.next(), {
      type: "watch",
      active: false,
      status: "idle",
      title: null
    });

    const app = await env.connect("/app");
    app.send({ type: "app.hello" });
    const media = { type: "movie", title: "Dune" };
    app.send({ type: "state", playback: { status: "playing", media } });
    assert.deepStrictEqual(await watch.next(), {
      type: "watch",
      active: true,
      status: "playing",
      title: "Dune"
    });
    // Pause/seek are not interesting for the watcher: no line.
    app.send({ type: "state", playback: { status: "paused", media, positionMs: 10 } });
    app.send({ type: "state", playback: { status: "idle" } });
    assert.deepStrictEqual(await watch.next(), {
      type: "watch",
      active: false,
      status: "idle",
      title: null
    });
    watch.socket.destroy();
    phone.close();
  } finally {
    env.teardown();
  }
});
