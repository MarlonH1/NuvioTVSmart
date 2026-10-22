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
const { createTv, createLunaSubscriber, isPoweredOn, readVolume } = require("../lib/tv");
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
    volume(action, level) {
      calls.push("volume:" + action + (action === "set" ? ":" + level : ""));
      if (action === "set") {
        // A slow TV: the slider sends faster than luna answers.
        this.level = level;
        return new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, level: this.level, muted: this.muted }), 50)
        );
      }
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
    },
    watchPresence(onChange) {
      this.presence = onChange;
      return () => {};
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

async function setup(hubOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuvio-remote-"));
  const tv = fakeTv();
  const store = createStore(path.join(dir, "state.json"));
  const hub = createHub(Object.assign({ tv, store, appId: "com.marlon.nuvio" }, hubOptions));
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
      media: {
        type: "series",
        title: "Game of Thrones",
        season: 1,
        episode: 9,
        genres: ["Drama"],
        country: "United States"
      },
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

    phone.send({ type: "cmd", action: "speed", rate: 1.5 });
    const speed = await app.next("cmd");
    assert.strictEqual(speed.action, "speed");
    assert.strictEqual(speed.rate, 1.5);

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
    appId: "com.marlon.nuvio",
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

test("slider drags only apply the newest absolute volume", async () => {
  const env = await setup();
  try {
    const { phone } = await pairPhone(env);
    for (const level of [30, 35, 40, 45, 50]) phone.send({ type: "volume", action: "set", level });
    const state = await phone.next("volume.state", (m) => m.level === 50);
    assert.strictEqual(state.level, 50);
    await new Promise((r) => setTimeout(r, 150));
    const sets = env.tv.calls.filter((c) => c.startsWith("volume:set"));
    // The first one runs immediately, the rest collapse into the newest.
    assert.deepStrictEqual(sets, ["volume:set:30", "volume:set:50"]);
    // No intermediate level was broadcast.
    assert.strictEqual(
      phone.inbox.filter((m) => m.type === "volume.state" && m.level !== 50).length,
      0
    );
  } finally {
    env.teardown();
  }
});

test("tv adapter sets absolute volume via luna", async () => {
  const seen = [];
  const tv = createTv({
    appId: "com.marlon.nuvio",
    call: (uri, params) => {
      seen.push([uri, params]);
      if (uri.endsWith("master/setVolume")) return Promise.resolve({ returnValue: true });
      if (uri.endsWith("com.webos.audio/getVolume"))
        return Promise.resolve({ returnValue: true, volume: 42, muteStatus: false });
      return Promise.resolve({ returnValue: false });
    }
  });
  const result = await tv.volume("set", 42.4);
  assert.strictEqual(result.level, 42);
  assert.deepStrictEqual(seen[0], [
    "luna://com.webos.service.audio/master/setVolume",
    { volume: 42 }
  ]);
});

function playingState(positionMs) {
  return {
    status: "playing",
    positionMs,
    durationMs: 3600000,
    at: Date.now(),
    rate: 1,
    media: { type: "series", title: "The Bear" }
  };
}

test("switching the TV off or to another input stops reporting playing", async () => {
  const env = await setup();
  try {
    const { phone } = await pairPhone(env);
    const app = await env.connect("/app");
    // The app reports its own id; the configured one is only the fallback.
    app.send({ type: "app.hello", version: "test", appId: "space.nuvio.webos" });
    env.tv.presence({ poweredOn: true, foregroundAppId: "space.nuvio.webos" });
    app.send({ type: "state", playback: playingState(100000) });
    await phone.next("state", (m) => m.playback.status === "playing");

    // HDMI 1 comes to the front: the player is frozen at its last position.
    env.tv.presence({ poweredOn: true, foregroundAppId: "com.webos.app.hdmi1" });
    const paused = await phone.next("state", (m) => m.playback.status === "paused");
    assert.strictEqual(paused.playback.media.title, "The Bear");
    assert.ok(paused.playback.positionMs >= 100000 && paused.playback.positionMs < 105000);

    // A late "playing" from the frozen app must not bring the old status back.
    app.send({ type: "state", playback: playingState(101000) });
    const late = await phone.next("state");
    assert.strictEqual(late.playback.status, "paused");

    // "play" from the phone brings Nuvio back to the front.
    phone.send({ type: "cmd", action: "toggle" });
    assert.strictEqual((await app.next("cmd")).action, "toggle");
    await waitFor(() => env.tv.calls.includes("launch"));

    // Back in front: the hub asks the app for a fresh state.
    env.tv.presence({ poweredOn: true, foregroundAppId: "space.nuvio.webos" });
    await app.next("state.get");
    app.send({ type: "state", playback: playingState(102000) });
    await phone.next("state", (m) => m.playback.status === "playing");

    // TV off: nothing is playing any more.
    env.tv.presence({ poweredOn: false, foregroundAppId: "space.nuvio.webos" });
    const idle = await phone.next("state", (m) => m.playback.status === "idle");
    assert.strictEqual(idle.playback.media, null);
    app.send({ type: "state", playback: playingState(103000) });
    assert.strictEqual((await phone.next("state")).playback.status, "idle");
    assert.deepStrictEqual(env.hub.status().tvPoweredOn, false);
  } finally {
    env.teardown();
  }
});

test("play while the TV is off waits until it is woken", async () => {
  const env = await setup();
  try {
    const { phone } = await pairPhone(env);
    const app = await env.connect("/app");
    app.send({ type: "app.hello", version: "test" });
    env.tv.presence({ poweredOn: false, foregroundAppId: "com.marlon.nuvio" });
    phone.send({
      type: "play",
      request: { media: { title: "The Bear" }, stream: { url: "https://x/1.mkv" } }
    });
    await phone.next("state", (m) => m.playback.status === "loading");
    assert.ok(!env.tv.calls.includes("launch"));
    assert.strictEqual(env.hub.status().pendingPlay, true);

    env.tv.presence({ poweredOn: true, foregroundAppId: "com.marlon.nuvio" });
    assert.strictEqual((await app.next("play")).request.stream.url, "https://x/1.mkv");
    assert.ok(env.tv.calls.includes("launch"));
  } finally {
    env.teardown();
  }
});

test("an input that takes over right after a play launch brings Nuvio back, twice at most", async () => {
  const env = await setup();
  try {
    const { phone } = await pairPhone(env);
    const app = await env.connect("/app");
    app.send({ type: "app.hello", version: "test" });
    // Fresh boot: the TV resumes its last input before the phone's play arrives.
    env.tv.presence({ poweredOn: true, foregroundAppId: "com.webos.app.hdmi2" });
    phone.send({
      type: "play",
      request: { media: { title: "Frieren" }, stream: { url: "https://x/2.mkv" } }
    });
    await app.next("play");
    const launches = () => env.tv.calls.filter((call) => call === "launch").length;
    assert.strictEqual(launches(), 1);

    env.tv.presence({ poweredOn: true, foregroundAppId: "com.marlon.nuvio" });
    env.tv.presence({ poweredOn: true, foregroundAppId: "com.webos.app.hdmi2" });
    assert.strictEqual(launches(), 2, "input takeover relaunches Nuvio");
    env.tv.presence({ poweredOn: true, foregroundAppId: "com.marlon.nuvio" });
    env.tv.presence({ poweredOn: true, foregroundAppId: "com.webos.app.hdmi2" });
    env.tv.presence({ poweredOn: true, foregroundAppId: "com.marlon.nuvio" });
    env.tv.presence({ poweredOn: true, foregroundAppId: "com.webos.app.hdmi2" });
    assert.strictEqual(launches(), 3, "gives up after two relaunches");
  } finally {
    env.teardown();
  }
});

test("lanMac prefers Ethernet and skips loopback", () => {
  const { lanMac } = require("../lib/tv");
  const v4 = (mac, internal) => [{ family: "IPv4", internal: !!internal, mac }];
  assert.strictEqual(
    lanMac({
      lo: v4("00:00:00:00:00:00", true),
      wlan0: v4("aa:aa:aa:aa:aa:aa"),
      eth0: v4("bb:bb:bb:bb:bb:bb")
    }),
    "bb:bb:bb:bb:bb:bb"
  );
  assert.strictEqual(lanMac({ wlan0: v4("aa:aa:aa:aa:aa:aa") }), "aa:aa:aa:aa:aa:aa");
  assert.strictEqual(lanMac({ lo: v4("00:00:00:00:00:00", true) }), null);
});

test("an app that stops reporting while playing is marked paused", async () => {
  const env = await setup({ staleAppMs: 150, staleCheckMs: 50 });
  try {
    const { phone } = await pairPhone(env);
    const app = await env.connect("/app");
    app.send({ type: "app.hello", version: "test" });
    app.send({ type: "state", playback: playingState(5000) });
    await phone.next("state", (m) => m.playback.status === "playing");
    const paused = await phone.next("state", (m) => m.playback.status === "paused");
    assert.strictEqual(paused.playback.positionMs, 5000);
    await app.next("state.get");
  } finally {
    env.teardown();
  }
});

test("tv adapter turns luna subscriptions into power and foreground changes", async () => {
  const handlers = {};
  const tv = createTv({
    appId: "com.marlon.nuvio",
    call: () => Promise.resolve({ returnValue: true }),
    subscribe: (uri, onReply) => {
      handlers[uri] = onReply;
      return () => {};
    }
  });
  const changes = [];
  tv.watchPresence((presence) => changes.push(presence));
  const power = handlers["luna://com.webos.service.tvpower/power/getPowerState"];
  const foreground = handlers["luna://com.webos.applicationManager/getForegroundAppInfo"];
  power({ returnValue: true, subscribed: true, state: "Active" });
  foreground({ returnValue: true, appId: "com.marlon.nuvio" });
  foreground({ returnValue: true, appId: "" });
  foreground({ returnValue: true, appId: "com.marlon.nuvio" });
  power({ returnValue: true, state: "Active", processing: "Request Power Off" });
  power({ returnValue: true, state: "Active Standby" });
  assert.deepStrictEqual(changes, [
    { poweredOn: true, foregroundAppId: null },
    { poweredOn: true, foregroundAppId: "com.marlon.nuvio" },
    { poweredOn: false, foregroundAppId: "com.marlon.nuvio" }
  ]);
  assert.strictEqual(isPoweredOn({ state: "Screen Off" }), true);
  assert.strictEqual(isPoweredOn({ state: "Suspend" }), false);
});

test("luna subscriber parses line-delimited replies and restarts nothing after stop", async () => {
  const { EventEmitter } = require("node:events");
  const spawned = [];
  const subscribe = createLunaSubscriber({
    spawn: (binary, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => child.emit("exit", 0);
      spawned.push({ binary, args, child });
      return child;
    }
  });
  const replies = [];
  const stop = subscribe("luna://x/y", (reply) => replies.push(reply));
  assert.deepStrictEqual(spawned[0].args, ["-i", "luna://x/y", '{"subscribe":true}']);
  spawned[0].child.stdout.emit("data", '{"a":1}\n{"b"');
  spawned[0].child.stdout.emit("data", ":2}\nnoise\n");
  assert.deepStrictEqual(replies, [{ a: 1 }, { b: 2 }]);
  stop();
  assert.strictEqual(spawned.length, 1);
});

test("party state reaches phones and invites go through the app", async () => {
  const env = await setup();
  try {
    const { phone } = await pairPhone(env);
    const app = await env.connect("/app");
    app.send({ type: "app.hello" });
    const party = {
      code: "ABC234",
      title: "Frieren",
      maxMembers: 3,
      isHost: true,
      members: [{ name: "Marlon", host: true, self: true }]
    };
    app.send({ type: "party.state", party });
    assert.deepStrictEqual((await phone.next("party.state")).party, party);

    phone.send({ type: "party.invite", id: "i1", friendCode: "GGGGHHHHJJJJ" });
    const forwarded = await app.next("party.invite");
    assert.strictEqual(forwarded.friendCode, "GGGGHHHHJJJJ");
    app.send({ type: "party.invite.result", requestId: forwarded.requestId, ok: true });
    const result = await phone.next("party.invite.result");
    assert.deepStrictEqual(
      { id: result.id, ok: result.ok, friendCode: result.friendCode, code: result.code },
      { id: "i1", ok: true, friendCode: "GGGGHHHHJJJJ", code: undefined }
    );

    phone.send({ type: "party.invite", id: "i2", friendCode: "KKKKLLLLMMMM" });
    const second = await app.next("party.invite");
    app.send({
      type: "party.invite.result",
      requestId: second.requestId,
      ok: false,
      code: "party_full"
    });
    const failed = await phone.next("party.invite.result");
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.code, "party_full");

    phone.send({ type: "state.get" });
    assert.deepStrictEqual((await phone.next("party.state")).party, party, "state.get repeats it");

    phone.send({ type: "party.invite", id: "i3", friendCode: "NNNNPPPPQQQQ" });
    await app.next("party.invite");
    app.close();
    const dropped = await phone.next("party.invite.result");
    assert.strictEqual(dropped.code, "no_player", "a closing app fails pending invites");
    assert.strictEqual((await phone.next("party.state")).party, null);

    phone.send({ type: "party.invite", id: "i4", friendCode: "NNNNPPPPQQQQ" });
    assert.strictEqual((await phone.next("error")).code, "no_player");
  } finally {
    env.teardown();
  }
});
