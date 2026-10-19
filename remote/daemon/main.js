#!/usr/bin/env node
// Nuvio Remote daemon for rooted webOS TVs. Runs as root from a Homebrew Channel init script,
// so it is reachable while Nuvio itself is closed.
//
//   node main.js [--port 47800] [--state /var/lib/nuvio-remote/state.json]
//                [--app-id space.nuvio.webos] [--luna-send luna-send] [--no-luna]
//
// Phones connect to ws://<tv>:<port>/ws, the Nuvio app to ws://127.0.0.1:<port>/app.
"use strict";

var http = require("http");
var dgram = require("dgram");
var attachWebSocketServer = require("./lib/ws").attachWebSocketServer;
var mdns = require("./lib/mdns");
var createHub = require("./lib/hub").createHub;
var createStore = require("./lib/store").createStore;
var createTv = require("./lib/tv").createTv;

var VERSION = "0.1.0";
var BEACON_PORT = 47810;
var BEACON_INTERVAL_MS = 3000;

function parseArgs(argv) {
  var options = {
    port: Number(process.env.NUVIO_REMOTE_PORT) || 47800,
    state: process.env.NUVIO_REMOTE_STATE || "/var/lib/nuvio-remote/state.json",
    appId: process.env.NUVIO_REMOTE_APP_ID || "space.nuvio.webos",
    lunaSend: process.env.NUVIO_REMOTE_LUNA_SEND || "luna-send",
    luna: true
  };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--state") options.state = argv[++i];
    else if (arg === "--app-id") options.appId = argv[++i];
    else if (arg === "--luna-send") options.lunaSend = argv[++i];
    else if (arg === "--no-luna") options.luna = false;
  }
  return options;
}

function log(line) {
  console.log(new Date().toISOString() + " " + line);
}

var options = parseArgs(process.argv.slice(2));
var store = createStore(options.state, log);
var tv = createTv({
  appId: options.appId,
  lunaSend: options.lunaSend,
  call: options.luna
    ? null
    : function () {
        return Promise.resolve({ returnValue: false, errorText: "luna disabled" });
      }
});
var hub = createHub({ tv: tv, store: store, log: log });
var startedAt = Date.now();
var responder = null;

var server = http.createServer(function (req, res) {
  // GET / is a reachability check that works from any browser on the LAN.
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(
    JSON.stringify(
      Object.assign(
        {
          service: "nuvio-remote",
          version: VERSION,
          protocol: 1,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          node: process.version,
          mdns: responder ? responder.getStatus().mode : null
        },
        hub.status()
      ),
      null,
      2
    )
  );
});

var wsServer = attachWebSocketServer(server, { paths: ["/ws", "/app"] }, hub.handleConnection);

function startDiscovery(port) {
  var id = store.tvId().slice(0, 4);
  responder = mdns.createResponder({
    serviceType: "_nuvio-remote._tcp",
    instanceName: "Nuvio TV " + id,
    hostName: "nuvio-tv-" + id,
    port: port,
    txt: { v: 1, id: store.tvId(), name: "Nuvio TV" },
    log: log
  });
  responder.start();

  // Fallback for networks that drop multicast: a UDP broadcast beacon.
  var beacon = dgram.createSocket({ type: "udp4", reuseAddr: true });
  beacon.on("error", function (error) {
    log("beacon error: " + error.message);
  });
  beacon.bind(0, function () {
    try {
      beacon.setBroadcast(true);
    } catch (error) {
      log("beacon setBroadcast: " + error.message);
      return;
    }
    var timer = setInterval(function () {
      var payload = Buffer.from(
        JSON.stringify({
          v: 1,
          svc: "nuvio-remote",
          id: store.tvId(),
          name: "Nuvio TV",
          port: port
        })
      );
      beacon.send(payload, 0, payload.length, BEACON_PORT, "255.255.255.255", function () {});
    }, BEACON_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
  });
}

server.on("error", function (error) {
  log("listen on " + options.port + " failed: " + error.message);
  process.exit(1);
});

server.listen(options.port, "0.0.0.0", function () {
  log(
    "nuvio-remote " + VERSION + " listening on :" + options.port + " (app " + options.appId + ")"
  );
  startDiscovery(options.port);
});

function shutdown() {
  log("stopping");
  if (responder) responder.stop();
  wsServer.stop();
  hub.stop();
  server.close();
  setTimeout(function () {
    process.exit(0);
  }, 300);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", function (error) {
  log("uncaught: " + (error && error.stack ? error.stack : error));
});
