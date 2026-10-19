// Nuvio Remote – feasibility spike service (webOS JS service, Node 8+).
//
// Answers three questions on a real TV in Developer Mode:
//  1. Can a dev-mode service listen on a LAN TCP port (WebSocket)?
//  2. Can it take part in mDNS on UDP 5353 (or only announce)?
//  3. Can it call the Luna audio API (volume up/down/mute)?
// Plus: does the service stay alive while the app holds a subscription,
// and what happens when the app goes to the background?
"use strict";

var http = require("http");
var os = require("os");
var dgram = require("dgram");
var crypto = require("crypto");
var attachWebSocketServer = require("./lib/ws").attachWebSocketServer;
var mdns = require("./lib/mdns");

var SERVICE_ID = "space.nuvio.remotespike.service";
var PORT_CANDIDATES = [47800, 47801, 47802, 47803, 47804];
var BEACON_PORT = 47810;
var PROTOCOL_VERSION = 1;

var logLines = [];
function log(line) {
  var entry = new Date().toISOString().slice(11, 23) + " " + line;
  logLines.push(entry);
  if (logLines.length > 200) logLines.shift();
  console.log("[" + SERVICE_ID + "] " + line);
  notifySubscribers();
}

function createService() {
  try {
    var Service = require("webos-service");
    return new Service(SERVICE_ID);
  } catch (error) {
    // Outside webOS (local test with plain node): mock the bus.
    console.warn("webos-service unavailable, running standalone:", error.message);
    return {
      standalone: true,
      register: function () {
        return null;
      },
      call: function (uri, params, cb) {
        cb({ payload: { returnValue: false, errorText: "standalone (no luna bus)" } });
      },
      activityManager: null
    };
  }
}

var service = createService();
var startedAt = Date.now();
var shortId = crypto.randomBytes(2).toString("hex");
var state = {
  port: null,
  listenError: null,
  clients: [],
  messagesReceived: 0,
  beacon: { ok: false, error: null, sent: 0 },
  luna: {}
};
var responder = null;
var wsServer = null;
var subscribers = {};

function statusPayload() {
  return {
    returnValue: true,
    serviceId: SERVICE_ID,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    nodeVersion: process.version,
    pid: process.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    interfaces: mdns.listIpv4Interfaces(),
    port: state.port,
    listenError: state.listenError,
    mdns: responder ? responder.getStatus() : null,
    beacon: state.beacon,
    clients: wsServer
      ? wsServer.connections.map(function (c) {
          return c.remoteAddress;
        })
      : [],
    messagesReceived: state.messagesReceived,
    luna: state.luna,
    subscribers: Object.keys(subscribers).length,
    log: logLines.slice(-25)
  };
}

var notifyPending = false;
function notifySubscribers() {
  if (notifyPending) return;
  notifyPending = true;
  setTimeout(function () {
    notifyPending = false;
    var payload = statusPayload();
    Object.keys(subscribers).forEach(function (key) {
      try {
        subscribers[key].respond(payload);
      } catch (error) {
        delete subscribers[key];
      }
    });
  }, 250);
}

// ---------------------------------------------------------------- luna audio

function lunaCall(uri, params, callback) {
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    callback({ returnValue: false, errorText: "timeout" });
  }, 4000);
  try {
    service.call(uri, params || {}, function (message) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      callback((message && message.payload) || {});
    });
  } catch (error) {
    clearTimeout(timer);
    done = true;
    callback({ returnValue: false, errorText: "throw: " + error.message });
  }
}

// webOS 5+ exposes com.webos.service.audio/master/*, older firmware
// com.webos.audio/*. The spike tries both and records what works.
var AUDIO_CALLS = {
  get: [
    ["luna://com.webos.service.audio/master/getVolume", {}],
    ["luna://com.webos.audio/getVolume", {}]
  ],
  up: [
    ["luna://com.webos.service.audio/master/volumeUp", {}],
    ["luna://com.webos.audio/volumeUp", {}]
  ],
  down: [
    ["luna://com.webos.service.audio/master/volumeDown", {}],
    ["luna://com.webos.audio/volumeDown", {}]
  ],
  mute: [
    ["luna://com.webos.service.audio/master/muteVolume", { muteVolume: true }],
    ["luna://com.webos.audio/setMuted", { muted: true }]
  ],
  unmute: [
    ["luna://com.webos.service.audio/master/muteVolume", { muteVolume: false }],
    ["luna://com.webos.audio/setMuted", { muted: false }]
  ]
};

function audioAction(action, callback) {
  var calls = AUDIO_CALLS[action];
  if (!calls) {
    callback({ returnValue: false, errorText: "unknown action " + action });
    return;
  }
  var attempts = [];
  (function next(index) {
    if (index >= calls.length) {
      state.luna[action] = attempts;
      callback({ returnValue: false, attempts: attempts });
      return;
    }
    lunaCall(calls[index][0], calls[index][1], function (result) {
      attempts.push({ uri: calls[index][0], result: result });
      if (result && result.returnValue) {
        state.luna[action] = attempts;
        log("luna " + action + " ok via " + calls[index][0]);
        callback({ returnValue: true, uri: calls[index][0], result: result, attempts: attempts });
        return;
      }
      log("luna " + action + " failed via " + calls[index][0] + ": " + JSON.stringify(result));
      next(index + 1);
    });
  })(0);
}

// ---------------------------------------------------------------- websocket

function handleClientMessage(connection, text) {
  state.messagesReceived += 1;
  var msg;
  try {
    msg = JSON.parse(text);
  } catch (error) {
    connection.sendJson({ v: PROTOCOL_VERSION, type: "error", code: "bad_json" });
    return;
  }
  var type = String((msg && msg.type) || "");
  if (type === "ping") {
    connection.sendJson({ v: PROTOCOL_VERSION, type: "pong", t: msg.t, serverTime: Date.now() });
  } else if (type === "status") {
    connection.sendJson({ v: PROTOCOL_VERSION, type: "status", status: statusPayload() });
  } else if (type === "volume") {
    audioAction(String(msg.action || "get"), function (result) {
      connection.sendJson({
        v: PROTOCOL_VERSION,
        type: "volumeResult",
        action: msg.action,
        result: result
      });
    });
  } else {
    connection.sendJson({ v: PROTOCOL_VERSION, type: "echo", received: msg });
  }
  notifySubscribers();
}

function hostLabel() {
  return "nuvio-tv-" + shortId;
}

function startHttpServer(index) {
  if (index >= PORT_CANDIDATES.length) {
    state.listenError = "no free port in " + PORT_CANDIDATES.join(",");
    log(state.listenError);
    return;
  }
  var port = PORT_CANDIDATES[index];
  var server = http.createServer(function (req, res) {
    // Plain HTTP GET / lets you test reachability from any browser.
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(statusPayload(), null, 2));
  });
  server.on("error", function (error) {
    log("listen " + port + " failed: " + error.code + " " + error.message);
    state.listenError = error.code + " " + error.message;
    startHttpServer(index + 1);
  });
  server.listen(port, "0.0.0.0", function () {
    state.port = port;
    state.listenError = null;
    log("http/ws listening on 0.0.0.0:" + port);
    wsServer = attachWebSocketServer(server, { path: "/ws" }, function (connection) {
      log("ws client connected: " + connection.remoteAddress);
      connection.sendJson({
        v: PROTOCOL_VERSION,
        type: "hello",
        spike: true,
        name: "Nuvio TV (" + shortId + ")",
        serviceId: SERVICE_ID
      });
      connection.on("message", function (text) {
        handleClientMessage(connection, text);
      });
      connection.on("close", function () {
        log("ws client closed: " + connection.remoteAddress);
      });
    });
    startDiscovery(port);
  });
}

// ---------------------------------------------------------------- discovery

function startDiscovery(port) {
  responder = mdns.createResponder({
    serviceType: "_nuvio-remote._tcp",
    instanceName: "Nuvio TV " + shortId,
    hostName: hostLabel(),
    port: port,
    txt: { v: PROTOCOL_VERSION, id: shortId, name: "Nuvio TV", spike: 1 },
    log: log
  });
  responder.start();
  setTimeout(function () {
    log("mdns mode: " + responder.getStatus().mode);
  }, 1500);

  // Fallback discovery: UDP broadcast beacon every 3 s on BEACON_PORT.
  var beacon = dgram.createSocket({ type: "udp4", reuseAddr: true });
  beacon.on("error", function (error) {
    state.beacon.error = error.message;
    log("beacon error: " + error.message);
  });
  beacon.bind(0, function () {
    try {
      beacon.setBroadcast(true);
    } catch (error) {
      state.beacon.error = "setBroadcast: " + error.message;
    }
    setInterval(function () {
      var payload = Buffer.from(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          svc: "nuvio-remote",
          id: shortId,
          name: "Nuvio TV (" + shortId + ")",
          port: port
        })
      );
      beacon.send(payload, 0, payload.length, BEACON_PORT, "255.255.255.255", function (error) {
        if (error) {
          state.beacon.ok = false;
          state.beacon.error = error.message;
        } else {
          state.beacon.ok = true;
          state.beacon.sent += 1;
        }
      });
    }, 3000);
  });
}

// ---------------------------------------------------------------- luna API

function register(name, handler) {
  var method = service.register(name, handler);
  return method;
}

// Subscription held by the app: keeps the service process alive and pushes
// status updates to the on-screen diagnostics.
var statusMethod = service.register("status");
if (statusMethod && typeof statusMethod.on === "function") {
  statusMethod.on("request", function (message) {
    if (message.isSubscription) {
      subscribers[message.uniqueToken] = message;
      log("app subscribed (" + Object.keys(subscribers).length + ")");
    }
    message.respond(statusPayload());
  });
  statusMethod.on("cancel", function (message) {
    delete subscribers[message.uniqueToken];
    log("app subscription cancelled (" + Object.keys(subscribers).length + ")");
  });
}

register("volume", function (message) {
  var action = String((message.payload && message.payload.action) || "get");
  audioAction(action, function (result) {
    message.respond(result);
  });
});

process.on("uncaughtException", function (error) {
  log("uncaught: " + (error && error.stack ? error.stack : error));
});

process.on("exit", function () {
  if (responder) responder.stop();
});

log("service starting, node " + process.version + " on " + os.platform());
startHttpServer(0);
