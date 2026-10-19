// Nuvio Remote end to end: phone WebSocket -> root daemon hub (remote/daemon) -> app bridge ->
// player. The player and router are fakes; the hub, the bridge and both sockets are real.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { attachWebSocketServer } = require("../remote/daemon/lib/ws.js");
const { createHub } = require("../remote/daemon/lib/hub.js");
const { createStore } = require("../remote/daemon/lib/store.js");

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
};

// ---------------------------------------------------------------- daemon side
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuvio-remote-bridge-"));
const tvCalls = [];
let shownCode = null;
const hub = createHub({
  store: createStore(path.join(dir, "state.json")),
  tv: {
    info: async () => ({ name: "Test TV", model: "OLED" }),
    volume: async () => ({ ok: true, level: 10, muted: false }),
    launchApp: async () => {
      tvCalls.push("launch");
      return { ok: true };
    },
    showCode: async (code) => {
      shownCode = code;
    },
    hideCode: async () => {}
  }
});
const server = http.createServer();
const wsServer = attachWebSocketServer(server, { paths: ["/ws", "/app"] }, hub.handleConnection);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
globalThis.__NUVIO_REMOTE_DAEMON_URL__ = `ws://127.0.0.1:${port}/app`;

// ---------------------------------------------------------------- app side fakes
const { Router } = await import("../js/ui/navigation/routerState.js");
const bridge = await import("../js/core/remote/nuvioRemoteBridge.js");

const playerCalls = [];
const fakePlayer = {
  params: null,
  paused: false,
  hasPresentedPlaybackFrame: true,
  subtitleDelayMs: 0,
  positionSec: 0,
  audioIndex: 0,
  subtitleId: null,
  getPlaybackCurrentSeconds() {
    return this.positionSec;
  },
  getPlaybackDurationSeconds() {
    return 3600;
  },
  getPlaybackSpeed: () => 1,
  isStartupErrorVisible: () => false,
  resolveNextEpisodeInfo() {
    return this.params?.itemType === "series" ? { videoId: "tt1:1:2" } : null;
  },
  getAudioEntries() {
    return ["English 5.1", "Deutsch"].map((label, index) => ({
      id: `audio-avplay-${index}`,
      label,
      languageKey: index ? "de" : "en",
      selected: index === this.audioIndex,
      supported: true
    }));
  },
  getSubtitleEntries(tab) {
    if (tab === "builtIn") {
      return [
        { id: "subtitle-off", label: "None", trackIndex: -1, selected: this.subtitleId === null },
        {
          id: "subtitle-embedded-0",
          label: "English",
          languageKey: "en",
          trackIndex: 0,
          selected: this.subtitleId === "subtitle-embedded-0"
        }
      ];
    }
    return [
      {
        id: "subtitle-addon-fallback-remote-sub-0",
        label: "Deutsch",
        languageKey: "de",
        fallbackAddonSubtitle: true,
        track: { addonName: "Nuvio Remote" },
        selected: this.subtitleId === "subtitle-addon-fallback-remote-sub-0"
      }
    ];
  },
  applyMediaAction(action) {
    playerCalls.push(["media", action]);
    if (action === "toggle") this.paused = !this.paused;
    if (action === "pause") this.paused = true;
    if (action === "play") this.paused = false;
  },
  seekPlaybackSeconds(seconds) {
    playerCalls.push(["seek", seconds]);
    this.positionSec = seconds;
  },
  applyAudioTrack(index) {
    playerCalls.push(["audio", index]);
    this.audioIndex = index;
  },
  applySubtitleEntry(entry) {
    playerCalls.push(["subtitle", entry.id]);
    this.subtitleId = entry.trackIndex === -1 ? null : entry.id;
  },
  setSubtitleDelayValue(ms) {
    playerCalls.push(["delay", ms]);
    this.subtitleDelayMs = ms;
  },
  async playNextEpisode() {
    playerCalls.push(["next"]);
  },
  navigateBackToStreamScreen() {
    playerCalls.push(["stop"]);
    Router.current = "home";
  }
};

const navigations = [];
Object.assign(Router, {
  current: "profileSelection",
  getCurrent() {
    return this.current;
  },
  getCurrentScreen() {
    return this.current === "player" ? fakePlayer : null;
  },
  async navigate(route, params, options) {
    navigations.push({ route, params, options });
    this.current = route;
    if (route === "player") fakePlayer.params = params;
  }
});

// ---------------------------------------------------------------- phone
class Phone {
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
    this.opened = new Promise((resolve) => (this.socket.onopen = resolve));
  }
  send(message) {
    this.socket.send(JSON.stringify({ v: 1, ...message }));
  }
  next(type, predicate = () => true, timeoutMs = 3000) {
    const match = (m) => m.type === type && predicate(m);
    const index = this.inbox.findIndex(match);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        }
      });
    });
  }
}

const waitFor = async (check, label) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`condition not met: ${label}`);
};

try {
  // Off by default: nothing connects.
  bridge.startNuvioRemoteBridge();
  assert.equal(bridge.isNuvioRemoteConnected(), false);

  const phone = new Phone(`ws://127.0.0.1:${port}/ws`);
  await phone.opened;
  phone.send({ type: "hello", client: { id: "p", name: "Pixel", platform: "android" } });
  await phone.next("welcome");
  phone.send({ type: "pair.begin" });
  await waitFor(() => shownCode, "pairing code");
  phone.send({ type: "pair.confirm", code: shownCode });
  await phone.next("pair.ok");

  // Phone asks to play while Nuvio is "closed": the hub launches the app and holds the request.
  const request = {
    media: {
      type: "series",
      metaId: "tt0944947",
      videoId: "tt0944947:1:9",
      season: 1,
      episode: 9,
      title: "Game of Thrones",
      episodeTitle: "Baelor",
      poster: "https://img/poster.jpg",
      background: "https://img/bg.jpg"
    },
    stream: {
      url: "https://cdn.example/got.mkv",
      headers: { "User-Agent": "Nuvio" },
      name: "1080p",
      addonName: "Torrentio",
      subtitles: [{ url: "https://subs/de.srt", lang: "ger" }]
    },
    startPositionMs: 600000
  };
  phone.send({ type: "play", request });
  await phone.next("state", (m) => m.playback.status === "loading");
  assert.ok(tvCalls.includes("launch"));

  // The user enables the feature on the TV; the app connects and gets the pending request, but
  // only navigates once the profile picker is gone.
  bridge.setNuvioRemoteEnabled(true);
  await waitFor(() => bridge.isNuvioRemoteConnected(), "bridge connected");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(navigations.length, 0, "must not navigate during profile selection");
  assert.equal(bridge.isNuvioRemoteForegroundRequest(), true);
  Router.current = "home";
  await waitFor(() => navigations.length === 1, "player navigation");

  const { params, options } = navigations[0];
  assert.equal(navigations[0].route, "player");
  assert.equal(options.replaceHistory, false);
  assert.equal(params.streamUrl, "https://cdn.example/got.mkv");
  assert.equal(params.itemType, "series");
  assert.equal(params.imdbId, "tt0944947");
  assert.equal(params.season, 1);
  assert.equal(params.episode, 9);
  assert.equal(params.resumePositionMs, 600000);
  assert.equal(params.startFromBeginning, false);
  assert.equal(params.preferredStreamId, "nuvio-remote");
  const candidate = params.streamCandidates[0];
  assert.deepEqual(candidate.behaviorHints.proxyHeaders.request, { "User-Agent": "Nuvio" });
  assert.equal(candidate.subtitles[0].url, "https://subs/de.srt");
  assert.equal(candidate.addonName, "Torrentio");

  fakePlayer.positionSec = 600;
  const playing = await phone.next("state", (m) => m.playback.status === "playing");
  assert.equal(playing.playback.media.title, "Game of Thrones");
  assert.equal(playing.playback.positionMs, 600000);
  assert.equal(playing.playback.durationMs, 3600000);
  assert.equal(playing.playback.hasNext, true);
  assert.deepEqual(
    playing.playback.audioTracks.map((track) => [track.id, track.lang, track.selected]),
    [
      ["audio-avplay-0", "en", true],
      ["audio-avplay-1", "de", false]
    ]
  );
  assert.deepEqual(
    playing.playback.subtitleTracks.map((track) => [track.id, track.source]),
    [
      ["subtitle-embedded-0", "embedded"],
      ["subtitle-addon-fallback-remote-sub-0", "external"]
    ]
  );

  // Commands round-trip into the player and the new state comes back.
  phone.send({ type: "cmd", action: "toggle" });
  await phone.next("state", (m) => m.playback.status === "paused");
  phone.send({ type: "cmd", action: "seekBy", deltaMs: 30000 });
  await waitFor(() => fakePlayer.positionSec === 630, "seekBy");
  phone.send({ type: "cmd", action: "seek", positionMs: 9_999_999 });
  await waitFor(() => fakePlayer.positionSec === 3599, "seek clamped to duration");
  phone.send({ type: "cmd", action: "audio", trackId: "audio-avplay-1" });
  await phone.next("state", (m) => m.playback.audioTracks[1]?.selected === true);
  phone.send({ type: "cmd", action: "subtitle", trackId: "subtitle-addon-fallback-remote-sub-0" });
  await phone.next("state", (m) => m.playback.subtitleTracks[1]?.selected === true);
  phone.send({ type: "cmd", action: "subtitle", trackId: null });
  await phone.next("state", (m) => m.playback.subtitleTracks.every((track) => !track.selected));
  phone.send({ type: "cmd", action: "subtitleDelay", delayMs: -250 });
  await phone.next("state", (m) => m.playback.subtitleDelayMs === -250);
  phone.send({ type: "cmd", action: "next" });
  await waitFor(() => playerCalls.some((call) => call[0] === "next"), "next episode");
  phone.send({ type: "cmd", action: "stop" });
  await phone.next("state", (m) => m.playback.status === "idle");

  assert.deepEqual(
    playerCalls.map((call) => call[0]),
    ["media", "seek", "seek", "audio", "subtitle", "subtitle", "delay", "next", "stop"]
  );

  // A second play while the player is open replaces the route instead of stacking it.
  Router.current = "player";
  phone.send({ type: "play", request: { ...request, startPositionMs: 0 } });
  await waitFor(() => navigations.length === 2, "second navigation");
  assert.equal(navigations[1].options.replaceHistory, true);
  assert.equal(navigations[1].params.startFromBeginning, true);

  // Turning the feature off disconnects; the daemon then reports idle to the phone.
  bridge.setNuvioRemoteEnabled(false);
  await phone.next("state", (m) => m.playback.status === "idle");
  assert.equal(bridge.isNuvioRemoteConnected(), false);
  phone.socket.close();
  console.log("nuvio remote bridge: ok");
} finally {
  bridge.stopNuvioRemoteBridge();
  wsServer.stop();
  hub.stop();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
