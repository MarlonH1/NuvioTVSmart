// Nuvio Remote hub: speaks protocol v1 (NuvioMobile docs/remote-protocol.md) with phones on
// /ws and a small bridge protocol with the Nuvio TV app on /app (loopback only).
//
// The hub owns everything that must work while Nuvio is closed: pairing, tokens, volume and
// launching the app. Playback commands are forwarded to the app; its state is fanned out to
// every paired phone.
//
// webOS freezes Nuvio instead of closing it when the TV is switched off or another app/input
// comes to the front. The socket stays open (the browser still answers pings), so the hub
// watches power state and the foreground app itself and stops reporting "playing" then.
//
// Bridge protocol (hub <-> Nuvio app), same flat JSON envelope:
//   app -> hub: app.hello {version, appId?}, state {playback}
//   hub -> app: play {request}, cmd {action, ...}, pair.show {code, clientName}, pair.hide,
//               state.get
"use strict";

var crypto = require("crypto");

var PROTOCOL_VERSION = 1;
var PENDING_PLAY_TIMEOUT_MS = 45000;
// The phone interpolates the position itself; the app sends extra updates on drift, so a slow
// heartbeat is enough and saves phone battery during long playback.
var STATE_HEARTBEAT_MS = 30000;
// The app re-sends its state at least every 30 s while playing. Silence well beyond that means
// webOS froze it without the hub noticing (no power or foreground event).
var STALE_APP_MS = 75000;
var STALE_CHECK_MS = 5000;
// /watch: one idle HTTP stream per phone watcher (remote/magisk). Lines only on start/stop of
// playback plus a keepalive, so the phone sleeps in between.
var WATCH_KEEPALIVE_MS = 600000;
var ACTIVE_STATUSES = { loading: true, playing: true, paused: true, buffering: true };
var MAX_CODE_ATTEMPTS = 5;
var UNPAIRED_TYPES = { hello: true, "pair.begin": true, "pair.confirm": true, ping: true };
var COMMANDS = {
  play: true,
  pause: true,
  toggle: true,
  stop: true,
  seek: true,
  seekBy: true,
  next: true,
  audio: true,
  subtitle: true,
  subtitleDelay: true,
  skip: true,
  speed: true
};

function randomCode() {
  return String(crypto.randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, "0");
}

function idlePlayback(now) {
  return {
    status: "idle",
    positionMs: 0,
    durationMs: 0,
    at: now,
    rate: 1,
    media: null,
    audioTracks: [],
    subtitleTracks: [],
    subtitleDelayMs: 0,
    hasNext: false,
    skip: null,
    error: null
  };
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

/**
 * @param deps.tv      TV adapter (lib/tv.js): info(), volume(action), launchApp(), showCode(),
 *                     hideCode(), optional watchPresence(onChange)
 * @param deps.store   persistent store (lib/store.js)
 * @param deps.appId   webOS id of Nuvio; the id the app reports in app.hello takes precedence
 * @param deps.log     function(line)
 * @param deps.now     optional clock, for tests
 * @param deps.staleAppMs, deps.staleCheckMs  optional watchdog timings, for tests
 */
function createHub(deps) {
  var tv = deps.tv;
  var store = deps.store;
  var log = deps.log || function () {};
  var now = deps.now || Date.now;

  var phones = [];
  var watchers = [];
  var app = null;
  var playback = idlePlayback(now());
  var volume = { level: null, muted: false };
  var pendingPlay = null;
  var pendingTimer = null;
  var tvInfo = { id: store.tvId(), name: "LG TV", model: null, platform: "webos" };
  var configuredAppId = deps.appId || null;
  var reportedAppId = null;
  var presence = { poweredOn: null, foregroundAppId: null };
  var lastAppStateAt = 0;
  var staleAppMs = deps.staleAppMs || STALE_APP_MS;

  tv.info().then(function (info) {
    if (info.name) tvInfo.name = info.name;
    if (info.model) tvInfo.model = info.model;
    log("tv: " + tvInfo.name + (tvInfo.model ? " (" + tvInfo.model + ")" : ""));
  });

  function send(connection, message) {
    message.v = PROTOCOL_VERSION;
    connection.sendJson(message);
  }

  function reply(phone, request, message) {
    if (request && request.id != null) message.id = request.id;
    send(phone.connection, message);
  }

  function pairedPhones() {
    return phones.filter(function (phone) {
      return phone.paired;
    });
  }

  function broadcast(message) {
    pairedPhones().forEach(function (phone) {
      send(phone.connection, Object.assign({}, message));
    });
  }

  function isActive(state) {
    return !!(state && state.media && ACTIVE_STATUSES[state.status]);
  }

  function watchLine() {
    var media = playback.media || {};
    return (
      JSON.stringify({
        type: "watch",
        active: isActive(playback),
        status: playback.status,
        title: media.title || null
      }) + "\n"
    );
  }

  function notifyWatchers() {
    var line = watchLine();
    watchers.forEach(function (watcher) {
      watcher.write(line);
    });
  }

  function nuvioAppId() {
    return reportedAppId || configuredAppId;
  }

  // Unknown values count as visible, so a TV without the luna subscriptions behaves as before.
  function appVisible() {
    if (presence.poweredOn === false) return false;
    var id = nuvioAppId();
    return !(presence.foregroundAppId && id && presence.foregroundAppId !== id);
  }

  // The position the player had reached at `at`, as a paused state.
  function frozen(state, at) {
    var next = Object.assign({}, state);
    if (state.status === "playing") {
      var elapsed = Math.max(0, at - (Number(state.at) || at)) * (Number(state.rate) || 1);
      next.positionMs = Math.round((Number(state.positionMs) || 0) + elapsed);
      if (state.durationMs > 0) next.positionMs = Math.min(next.positionMs, state.durationMs);
    }
    next.status = "paused";
    next.at = at;
    return next;
  }

  // What the phones should see for a state while Nuvio is not on screen.
  function hiddenPlayback(state, at) {
    if (presence.poweredOn === false) return isActive(state) ? idlePlayback(at) : state;
    return state.status === "playing" || state.status === "buffering" ? frozen(state, at) : state;
  }

  function setPresence(next) {
    var wasVisible = appVisible();
    presence = { poweredOn: next.poweredOn, foregroundAppId: next.foregroundAppId };
    var visible = appVisible();
    if (wasVisible === visible) return;
    if (visible) {
      log("tv: nuvio in front");
      // The app does not resend an unchanged state, so ask for it explicitly.
      if (app) send(app, { type: "state.get" });
      return;
    }
    log(
      presence.poweredOn === false
        ? "tv: powered off"
        : "tv: nuvio in background (" + presence.foregroundAppId + ")"
    );
    var next = hiddenPlayback(playback, now());
    if (next !== playback) setPlayback(next);
  }

  function setPlayback(next) {
    var wasActive = isActive(playback);
    playback = next;
    broadcast({ type: "state", playback: playback });
    if (wasActive !== isActive(playback)) notifyWatchers();
  }

  function handleWatch(req, res) {
    var query = String(req.url || "").split("?")[1] || "";
    var token = null;
    query.split("&").forEach(function (pair) {
      var parts = pair.split("=");
      if (parts[0] === "token") token = decodeURIComponent(parts[1] || "");
    });
    if (!token || !store.hasToken(token)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("not paired\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
    if (res.socket) res.socket.setKeepAlive(true, WATCH_KEEPALIVE_MS);
    res.write(watchLine());
    watchers.push(res);
    log("watcher connected: " + (req.socket && req.socket.remoteAddress));
    var keepalive = setInterval(function () {
      res.write('{"type":"ka"}\n');
    }, WATCH_KEEPALIVE_MS);
    req.on("close", function () {
      clearInterval(keepalive);
      var index = watchers.indexOf(res);
      if (index >= 0) watchers.splice(index, 1);
    });
  }

  function sendVolume(target) {
    var message = { type: "volume.state", level: volume.level, muted: volume.muted };
    if (target) send(target.connection, message);
    else broadcast(message);
  }

  // ------------------------------------------------------------ pairing

  function activePairing() {
    for (var i = 0; i < phones.length; i++) {
      if (phones[i].pairing) return phones[i];
    }
    return null;
  }

  function showCode(phone) {
    var clientName = (phone.client && phone.client.name) || "Phone";
    if (app) send(app, { type: "pair.show", code: phone.pairing.code, clientName: clientName });
    tv.showCode(phone.pairing.code, clientName);
  }

  function endPairing(phone) {
    if (!phone.pairing) return;
    phone.pairing = null;
    if (!activePairing()) {
      if (app) send(app, { type: "pair.hide" });
      tv.hideCode();
    }
  }

  function beginPairing(phone, request) {
    // One code on screen at a time: a newer request replaces an older one.
    phones.forEach(function (other) {
      if (other !== phone && other.pairing) {
        other.pairing = null;
        reply(other, null, {
          type: "error",
          code: "pairing_replaced",
          message: "Another device started pairing"
        });
      }
    });
    phone.pairing = { code: randomCode(), attempts: 0 };
    log("pairing started by " + phone.connection.remoteAddress);
    showCode(phone);
  }

  function confirmPairing(phone, request) {
    if (!phone.pairing) {
      reply(phone, request, { type: "error", code: "pairing_not_started" });
      return;
    }
    var code = String(request.code || "").trim();
    if (code !== phone.pairing.code) {
      phone.pairing.attempts += 1;
      log("pairing: wrong code (" + phone.pairing.attempts + ")");
      if (phone.pairing.attempts >= MAX_CODE_ATTEMPTS) {
        phone.pairing = { code: randomCode(), attempts: 0 };
        showCode(phone);
      }
      reply(phone, request, { type: "error", code: "bad_code" });
      return;
    }
    var token = crypto.randomBytes(24).toString("hex");
    store.addToken(token, {
      clientId: phone.client ? phone.client.id : null,
      name: phone.client ? phone.client.name : null,
      platform: phone.client ? phone.client.platform : null,
      createdAt: now()
    });
    endPairing(phone);
    phone.paired = true;
    log("paired " + ((phone.client && phone.client.name) || phone.connection.remoteAddress));
    reply(phone, request, { type: "pair.ok", token: token });
  }

  // ------------------------------------------------------------ playback

  function clearPending() {
    pendingPlay = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  function play(request) {
    var media = request.request && request.request.media;
    if (!request.request || !request.request.stream || !request.request.stream.url) {
      return { type: "error", code: "bad_request", message: "play needs request.stream.url" };
    }
    // Launching a running app just brings it to the front (webOSRelaunch).
    tv.launchApp().then(function (result) {
      if (!result.ok) log("launch failed: " + result.error);
    });
    if (app) {
      send(app, { type: "play", request: request.request });
    } else {
      clearPending();
      pendingPlay = request.request;
      pendingTimer = setTimeout(function () {
        if (!pendingPlay) return;
        log("app did not connect in time, dropping play request");
        clearPending();
        var failed = idlePlayback(now());
        failed.status = "error";
        failed.media = media || null;
        failed.error = "Nuvio did not start on the TV";
        setPlayback(failed);
        broadcast({ type: "error", code: "playback_failed", message: failed.error });
      }, PENDING_PLAY_TIMEOUT_MS);
    }
    var loading = idlePlayback(now());
    loading.status = "loading";
    loading.media = media || null;
    setPlayback(loading);
    return null;
  }

  function command(request) {
    if (!COMMANDS[request.action])
      return { type: "error", code: "unknown_action", message: String(request.action) };
    if (!app)
      return { type: "error", code: "no_player", message: "Nuvio is not running on the TV" };
    // A frozen app only handles the command once it is back in front.
    var resumes = request.action === "play" || request.action === "toggle";
    if (resumes && !appVisible() && presence.poweredOn !== false) {
      tv.launchApp().then(function (result) {
        if (!result.ok) log("launch failed: " + result.error);
      });
    }
    send(app, {
      type: "cmd",
      action: request.action,
      positionMs: request.positionMs,
      deltaMs: request.deltaMs,
      trackId: request.trackId,
      delayMs: request.delayMs,
      rate: request.rate
    });
    return null;
  }

  // One volume call at a time. While a slider is dragged, "set" requests pile up; only the
  // newest one matters, so a waiting "set" is replaced instead of queued.
  var volumeBusy = false;
  var volumeQueue = [];

  function changeVolume(phone, request) {
    var action = String(request.action || "get");
    if (action === "set") {
      volumeQueue = volumeQueue.filter(function (item) {
        return item.action !== "set";
      });
    }
    volumeQueue.push({ phone: phone, request: request, action: action });
    runVolumeQueue();
  }

  function runVolumeQueue() {
    if (volumeBusy || !volumeQueue.length) return;
    var item = volumeQueue.shift();
    volumeBusy = true;
    tv.volume(item.action, item.request.level).then(function (result) {
      volumeBusy = false;
      if (result.level != null) volume.level = result.level;
      if (result.muted != null) volume.muted = result.muted;
      if (!result.ok) {
        reply(item.phone, item.request, {
          type: "error",
          code: "volume_failed",
          message: result.error
        });
      }
      // Intermediate levels of a drag are not worth broadcasting.
      if (!volumeQueue.length) sendVolume(null);
      runVolumeQueue();
    });
  }

  // ------------------------------------------------------------ connections

  function handlePhoneMessage(phone, request) {
    var type = String(request.type || "");
    if (!phone.paired && !UNPAIRED_TYPES[type]) {
      reply(phone, request, { type: "error", code: "not_paired" });
      return;
    }
    var response = null;
    switch (type) {
      case "hello":
        phone.client = request.client || null;
        phone.paired = !!(request.token && store.touchToken(request.token, now()));
        reply(phone, request, {
          type: "welcome",
          tv: tvInfo,
          paired: phone.paired,
          protocol: PROTOCOL_VERSION
        });
        if (phone.paired) {
          send(phone.connection, { type: "state", playback: playback });
          sendVolume(phone);
        }
        return;
      case "pair.begin":
        beginPairing(phone, request);
        return;
      case "pair.confirm":
        confirmPairing(phone, request);
        return;
      case "ping":
        reply(phone, request, { type: "pong", t: request.t, serverTime: now() });
        return;
      case "state.get":
        reply(phone, request, { type: "state", playback: playback });
        sendVolume(phone);
        if (app) send(app, { type: "state.get" });
        return;
      case "play":
        response = play(request);
        break;
      case "cmd":
        response = command(request);
        break;
      case "volume":
        changeVolume(phone, request);
        return;
      default:
        response = { type: "error", code: "unknown_type", message: type };
    }
    if (response) reply(phone, request, response);
  }

  function handlePhone(connection) {
    var phone = { connection: connection, client: null, paired: false, pairing: null };
    phones.push(phone);
    log("phone connected: " + connection.remoteAddress);
    connection.on("message", function (text) {
      var request;
      try {
        request = JSON.parse(text);
      } catch (error) {
        send(connection, { type: "error", code: "bad_json" });
        return;
      }
      if (!request || typeof request !== "object") return;
      handlePhoneMessage(phone, request);
    });
    connection.on("close", function () {
      endPairing(phone);
      var index = phones.indexOf(phone);
      if (index >= 0) phones.splice(index, 1);
      log("phone disconnected: " + connection.remoteAddress);
    });
  }

  function handleApp(connection) {
    if (!isLoopback(connection.remoteAddress)) {
      connection.close(1008, "loopback only");
      return;
    }
    if (app) app.close(1000, "replaced");
    app = connection;
    log("nuvio app connected");
    connection.on("message", function (text) {
      var message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        return;
      }
      if (!message) return;
      if (message.type === "app.hello") {
        if (message.appId) reportedAppId = String(message.appId);
        if (pendingPlay) {
          send(connection, { type: "play", request: pendingPlay });
          clearPending();
        }
        var pairing = activePairing();
        if (pairing) showCode(pairing);
      } else if (message.type === "state" && message.playback) {
        lastAppStateAt = now();
        var next = Object.assign(idlePlayback(now()), message.playback);
        setPlayback(appVisible() ? next : hiddenPlayback(next, now()));
      }
    });
    connection.on("close", function () {
      if (app !== connection) return;
      app = null;
      log("nuvio app disconnected");
      if (!pendingPlay) setPlayback(idlePlayback(now()));
    });
  }

  function handleConnection(connection) {
    if (connection.path === "/app") handleApp(connection);
    else handlePhone(connection);
  }

  var heartbeat = setInterval(function () {
    if (playback.status === "playing" || playback.status === "buffering") {
      broadcast({ type: "state", playback: playback });
    }
  }, STATE_HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  var staleCheck = setInterval(function () {
    if (!app || (playback.status !== "playing" && playback.status !== "buffering")) return;
    if (now() - lastAppStateAt < staleAppMs) return;
    log("nuvio app stopped reporting, marking playback paused");
    setPlayback(frozen(playback, Number(playback.at) || now()));
    send(app, { type: "state.get" });
  }, deps.staleCheckMs || STALE_CHECK_MS);
  if (typeof staleCheck.unref === "function") staleCheck.unref();

  var stopPresence =
    typeof tv.watchPresence === "function" ? tv.watchPresence(setPresence) : function () {};

  return {
    handleConnection: handleConnection,
    handleWatch: handleWatch,
    status: function () {
      return {
        tv: tvInfo,
        appConnected: !!app,
        appId: nuvioAppId(),
        tvPoweredOn: presence.poweredOn,
        foregroundAppId: presence.foregroundAppId,
        phones: phones.map(function (phone) {
          return {
            address: phone.connection.remoteAddress,
            paired: phone.paired,
            pairing: !!phone.pairing
          };
        }),
        pairedDevices: store.listTokens().length,
        playback: { status: playback.status, title: playback.media ? playback.media.title : null },
        pendingPlay: !!pendingPlay
      };
    },
    stop: function () {
      clearInterval(heartbeat);
      clearInterval(staleCheck);
      stopPresence();
      watchers.slice().forEach(function (watcher) {
        watcher.end();
      });
      clearPending();
    }
  };
}

module.exports = { createHub: createHub, PROTOCOL_VERSION: PROTOCOL_VERSION };
