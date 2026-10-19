// Minimal mDNS / DNS-SD responder (RFC 6762 / 6763) for Node 8+.
// Announces exactly one service instance and answers PTR/SRV/TXT/A queries.
//
// Two operating modes, reported via getStatus().mode:
//  - "shared-5353": bound to UDP 5353 with SO_REUSEADDR next to the system's
//    own mDNS daemon. This is the only mode Android NSD / Apple Bonjour
//    reliably accept answers from.
//  - "announce-only": 5353 could not be bound (sandbox / daemon without
//    SO_REUSEADDR). We still multicast unsolicited announcements from an
//    ephemeral port; some resolvers accept these, many do not. The UDP
//    beacon + manual IP entry are the fallback in that case.
"use strict";

var dgram = require("dgram");
var os = require("os");

var MDNS_ADDRESS = "224.0.0.251";
var MDNS_PORT = 5353;
var TYPE_A = 1;
var TYPE_PTR = 12;
var TYPE_TXT = 16;
var TYPE_SRV = 33;
var TYPE_ANY = 255;
var CLASS_IN = 1;
var CACHE_FLUSH = 0x8000;

function listIpv4Interfaces() {
  var result = [];
  var interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach(function (name) {
    (interfaces[name] || []).forEach(function (entry) {
      if (entry && (entry.family === "IPv4" || entry.family === 4) && !entry.internal) {
        result.push({ name: name, address: entry.address, netmask: entry.netmask });
      }
    });
  });
  return result;
}

function encodeName(name) {
  var parts = String(name).replace(/\.$/, "").split(".");
  var buffers = [];
  parts.forEach(function (label) {
    var bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) bytes = bytes.slice(0, 63);
    buffers.push(Buffer.from([bytes.length]), bytes);
  });
  buffers.push(Buffer.from([0]));
  return Buffer.concat(buffers);
}

function decodeName(buf, offset) {
  var labels = [];
  var jumped = false;
  var end = offset;
  var guard = 0;
  while (guard < 128) {
    guard += 1;
    if (offset >= buf.length) throw new Error("name out of range");
    var length = buf[offset];
    if (length === 0) {
      if (!jumped) end = offset + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) throw new Error("bad pointer");
      if (!jumped) end = offset + 2;
      offset = ((length & 0x3f) << 8) | buf[offset + 1];
      jumped = true;
      continue;
    }
    labels.push(buf.toString("utf8", offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return { name: labels.join("."), end: end };
}

function encodeRecord(name, type, cls, ttl, rdata) {
  var nameBuf = encodeName(name);
  var header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(cls, 2);
  header.writeUInt32BE(ttl, 4);
  header.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, header, rdata]);
}

function encodeTxt(entries) {
  var buffers = [];
  Object.keys(entries).forEach(function (key) {
    var bytes = Buffer.from(key + "=" + String(entries[key]), "utf8").slice(0, 255);
    buffers.push(Buffer.from([bytes.length]), bytes);
  });
  if (!buffers.length) buffers.push(Buffer.from([0]));
  return Buffer.concat(buffers);
}

function encodeSrv(port, target) {
  var head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(target)]);
}

function encodeA(address) {
  return Buffer.from(
    String(address)
      .split(".")
      .map(function (part) {
        return Number(part) & 0xff;
      })
  );
}

function sameName(a, b) {
  return String(a).toLowerCase().replace(/\.$/, "") === String(b).toLowerCase().replace(/\.$/, "");
}

// options: { serviceType: "_nuvio-remote._tcp", instanceName, hostName, port, txt, log }
function createResponder(options) {
  var serviceType = options.serviceType + ".local";
  var instance = options.instanceName + "." + serviceType;
  var host = options.hostName + ".local";
  var log = options.log || function () {};
  var socket = null;
  var announceTimer = null;
  var status = {
    mode: "stopped",
    error: null,
    queriesSeen: 0,
    answersSent: 0,
    announcementsSent: 0,
    interfaces: [],
    lastQueryFrom: null
  };

  // ttlOverride: undefined = normal TTLs, 0 = goodbye, n = fixed TTL (legacy unicast).
  function buildRecords(ttlOverride) {
    function ttl(normal) {
      return typeof ttlOverride === "number" ? ttlOverride : normal;
    }
    var ifaces = listIpv4Interfaces();
    status.interfaces = ifaces.map(function (iface) {
      return iface.name + "=" + iface.address;
    });
    var answers = [
      encodeRecord(serviceType, TYPE_PTR, CLASS_IN, ttl(4500), encodeName(instance)),
      encodeRecord(
        instance,
        TYPE_SRV,
        CLASS_IN | CACHE_FLUSH,
        ttl(120),
        encodeSrv(options.port, host)
      ),
      encodeRecord(
        instance,
        TYPE_TXT,
        CLASS_IN | CACHE_FLUSH,
        ttl(4500),
        encodeTxt(options.txt || {})
      )
    ];
    var additionals = ifaces.map(function (iface) {
      return encodeRecord(host, TYPE_A, CLASS_IN | CACHE_FLUSH, ttl(120), encodeA(iface.address));
    });
    additionals.push(
      encodeRecord(
        "_services._dns-sd._udp.local",
        TYPE_PTR,
        CLASS_IN,
        ttl(4500),
        encodeName(serviceType)
      )
    );
    return { answers: answers, additionals: additionals };
  }

  function buildPacket(id, questionsRaw, questionCount, records) {
    var header = Buffer.alloc(12);
    header.writeUInt16BE(id || 0, 0);
    header.writeUInt16BE(0x8400, 2);
    header.writeUInt16BE(questionCount || 0, 4);
    header.writeUInt16BE(records.answers.length, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(records.additionals.length, 10);
    return Buffer.concat(
      [header, questionsRaw || Buffer.alloc(0)].concat(records.answers, records.additionals)
    );
  }

  function sendMulticast(packet) {
    if (!socket) return;
    var ifaces = listIpv4Interfaces();
    var targets = ifaces.length ? ifaces : [{ address: null }];
    targets.forEach(function (iface) {
      try {
        if (iface.address && typeof socket.setMulticastInterface === "function") {
          socket.setMulticastInterface(iface.address);
        }
        socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDRESS);
      } catch (error) {
        log("mdns send failed on " + iface.address + ": " + error.message);
      }
    });
  }

  function announce(ttlOverride) {
    sendMulticast(buildPacket(0, null, 0, buildRecords(ttlOverride)));
    status.announcementsSent += 1;
  }

  function onQuery(msg, rinfo) {
    if (msg.length < 12) return;
    var flags = msg.readUInt16BE(2);
    if (flags & 0x8000) return; // a response, not a query
    var qdcount = msg.readUInt16BE(4);
    var offset = 12;
    var matched = false;
    var unicastRequested = false;
    for (var i = 0; i < qdcount; i += 1) {
      var decoded = decodeName(msg, offset);
      offset = decoded.end;
      if (offset + 4 > msg.length) return;
      var qtype = msg.readUInt16BE(offset);
      var qclass = msg.readUInt16BE(offset + 2);
      offset += 4;
      if (qclass & 0x8000) unicastRequested = true;
      var name = decoded.name;
      if (
        (sameName(name, serviceType) && (qtype === TYPE_PTR || qtype === TYPE_ANY)) ||
        (sameName(name, instance) &&
          (qtype === TYPE_SRV || qtype === TYPE_TXT || qtype === TYPE_ANY)) ||
        (sameName(name, host) && (qtype === TYPE_A || qtype === TYPE_ANY)) ||
        (sameName(name, "_services._dns-sd._udp.local") && qtype === TYPE_PTR)
      ) {
        matched = true;
      }
    }
    status.queriesSeen += 1;
    if (!matched) return;
    status.lastQueryFrom = rinfo.address + ":" + rinfo.port;

    if (rinfo.port !== MDNS_PORT) {
      // Legacy unicast query (RFC 6762 6.7): echo id + questions, short TTL.
      var questionsRaw = msg.slice(12, offset);
      var packet = buildPacket(msg.readUInt16BE(0), questionsRaw, qdcount, buildRecords(10));
      socket.send(packet, 0, packet.length, rinfo.port, rinfo.address);
    } else if (unicastRequested) {
      var direct = buildPacket(0, null, 0, buildRecords());
      socket.send(direct, 0, direct.length, rinfo.port, rinfo.address);
    } else {
      announce();
    }
    status.answersSent += 1;
  }

  function joinGroups() {
    listIpv4Interfaces().forEach(function (iface) {
      try {
        socket.addMembership(MDNS_ADDRESS, iface.address);
      } catch (error) {
        // EADDRINUSE: already joined on this interface.
        if (!/EADDRINUSE/.test(String(error.code || error.message))) {
          log("mdns addMembership " + iface.address + " failed: " + error.message);
        }
      }
    });
  }

  function startAnnounceOnly(reason) {
    status.mode = "announce-only";
    status.error = reason;
    socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", function (error) {
      status.error = "announce socket: " + error.message;
      log(status.error);
    });
    socket.bind(0, function () {
      try {
        socket.setMulticastTTL(255);
      } catch (error) {
        // ignore
      }
      announceBurst();
    });
  }

  function announceBurst() {
    // RFC 6762 8.3: at least two announcements one second apart.
    announce();
    setTimeout(function () {
      announce();
    }, 1000);
    setTimeout(function () {
      announce();
    }, 3000);
  }

  function start() {
    socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    var bound = false;
    socket.on("error", function (error) {
      log("mdns socket error: " + error.message);
      if (!bound) {
        try {
          socket.close();
        } catch (closeError) {
          // ignore
        }
        startAnnounceOnly(error.code + " " + error.message);
      } else {
        status.error = error.message;
      }
    });
    socket.on("message", function (msg, rinfo) {
      try {
        onQuery(msg, rinfo);
      } catch (error) {
        // Malformed packets from other devices must not kill the responder.
      }
    });
    socket.bind(MDNS_PORT, function () {
      bound = true;
      status.mode = "shared-5353";
      try {
        socket.setMulticastTTL(255);
        socket.setMulticastLoopback(true);
      } catch (error) {
        // ignore
      }
      joinGroups();
      announceBurst();
    });
    // Re-announce periodically and re-join groups after WLAN changes.
    announceTimer = setInterval(function () {
      if (status.mode === "shared-5353") joinGroups();
      announce();
    }, 60000);
  }

  function stop() {
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = null;
    if (!socket) return;
    try {
      // Goodbye packet (TTL 0) so browsers drop us immediately.
      announce(0);
    } catch (error) {
      // ignore
    }
    var closing = socket;
    socket = null;
    setTimeout(function () {
      try {
        closing.close();
      } catch (error) {
        // ignore
      }
    }, 100);
    status.mode = "stopped";
  }

  return {
    start: start,
    stop: stop,
    announce: function () {
      announce();
    },
    getStatus: function () {
      return status;
    }
  };
}

module.exports = {
  createResponder: createResponder,
  listIpv4Interfaces: listIpv4Interfaces
};
