// Minimal RFC 6455 WebSocket server for the webOS service runtime (Node 8+).
// No external dependency on purpose: the webOS service bundle targets Node 8
// and should stay small. Supports text frames, fragmentation, ping/pong and
// close. Binary frames are accepted but delivered as Buffers.
"use strict";

var crypto = require("crypto");
var EventEmitter = require("events").EventEmitter;
var util = require("util");

var GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var MAX_MESSAGE_BYTES = 1024 * 1024;

function WsConnection(socket, request) {
  EventEmitter.call(this);
  this.socket = socket;
  this.request = request;
  this.remoteAddress = String(socket.remoteAddress || "").replace(/^::ffff:/, "");
  this.open = true;
  this._buffer = Buffer.alloc(0);
  this._fragments = [];
  this._fragmentOpcode = 0;
  this._fragmentBytes = 0;
  this.lastSeenAt = Date.now();

  var self = this;
  socket.setNoDelay(true);
  socket.on("data", function (chunk) {
    self.lastSeenAt = Date.now();
    self._buffer = Buffer.concat([self._buffer, chunk]);
    try {
      self._drain();
    } catch (error) {
      self.close(1002, String(error.message || error));
    }
  });
  socket.on("close", function () {
    if (!self.open) return;
    self.open = false;
    self.emit("close");
  });
  socket.on("error", function (error) {
    self.emit("socketError", error);
  });
}
util.inherits(WsConnection, EventEmitter);

WsConnection.prototype._drain = function () {
  while (this.open) {
    var buf = this._buffer;
    if (buf.length < 2) return;
    var fin = (buf[0] & 0x80) !== 0;
    var opcode = buf[0] & 0x0f;
    var masked = (buf[1] & 0x80) !== 0;
    var length = buf[1] & 0x7f;
    var offset = 2;
    if (length === 126) {
      if (buf.length < 4) return;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return;
      if (buf.readUInt32BE(2) !== 0) throw new Error("frame too large");
      length = buf.readUInt32BE(6);
      offset = 10;
    }
    if (length > MAX_MESSAGE_BYTES) throw new Error("frame too large");
    // Clients must mask every frame (RFC 6455 5.1).
    if (!masked) throw new Error("unmasked client frame");
    if (buf.length < offset + 4 + length) return;
    var mask = buf.slice(offset, offset + 4);
    offset += 4;
    var payload = Buffer.alloc(length);
    for (var i = 0; i < length; i += 1) {
      payload[i] = buf[offset + i] ^ mask[i & 3];
    }
    this._buffer = buf.slice(offset + length);
    this._handleFrame(fin, opcode, payload);
  }
};

WsConnection.prototype._handleFrame = function (fin, opcode, payload) {
  if (opcode === 0x8) {
    var code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
    this.close(code);
    return;
  }
  if (opcode === 0x9) {
    this._send(0xa, payload);
    return;
  }
  if (opcode === 0xa) {
    this.emit("pong");
    return;
  }
  if (opcode === 0x1 || opcode === 0x2) {
    this._fragments = [payload];
    this._fragmentOpcode = opcode;
    this._fragmentBytes = payload.length;
  } else if (opcode === 0x0) {
    if (!this._fragmentOpcode) throw new Error("unexpected continuation frame");
    this._fragments.push(payload);
    this._fragmentBytes += payload.length;
    if (this._fragmentBytes > MAX_MESSAGE_BYTES) throw new Error("message too large");
  } else {
    throw new Error("unsupported opcode " + opcode);
  }
  if (!fin) return;
  var message = Buffer.concat(this._fragments);
  var isText = this._fragmentOpcode === 0x1;
  this._fragments = [];
  this._fragmentOpcode = 0;
  this._fragmentBytes = 0;
  this.emit("message", isText ? message.toString("utf8") : message, isText);
};

WsConnection.prototype._send = function (opcode, payload) {
  if (!this.open) return false;
  var length = payload.length;
  var header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode;
  try {
    this.socket.write(Buffer.concat([header, payload]));
    return true;
  } catch (error) {
    return false;
  }
};

WsConnection.prototype.send = function (text) {
  return this._send(0x1, Buffer.from(String(text), "utf8"));
};

WsConnection.prototype.sendJson = function (value) {
  return this.send(JSON.stringify(value));
};

WsConnection.prototype.ping = function () {
  return this._send(0x9, Buffer.alloc(0));
};

WsConnection.prototype.close = function (code, reason) {
  if (!this.open) return;
  var reasonBuf = Buffer.from(String(reason || "").slice(0, 120), "utf8");
  var payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code || 1000, 0);
  reasonBuf.copy(payload, 2);
  this._send(0x8, payload);
  this.open = false;
  var socket = this.socket;
  setTimeout(function () {
    socket.destroy();
  }, 200);
  this.emit("close");
};

// Attaches WebSocket handling to an existing http.Server. `onConnection`
// receives a WsConnection; `acceptPath` restricts the upgrade path.
function attachWebSocketServer(httpServer, options, onConnection) {
  var acceptPaths = (options && options.paths) || [(options && options.path) || "/ws"];
  var heartbeatMs = (options && options.heartbeatMs) || 15000;
  var connections = [];

  httpServer.on("upgrade", function (request, socket) {
    var pathname = String(request.url || "").split("?")[0];
    var key = request.headers["sec-websocket-key"];
    var upgrade = String(request.headers.upgrade || "").toLowerCase();
    if (acceptPaths.indexOf(pathname) < 0 || upgrade !== "websocket" || !key) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    var accept = crypto
      .createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n"
    );
    var connection = new WsConnection(socket, request);
    connection.path = pathname;
    connections.push(connection);
    connection.on("close", function () {
      var index = connections.indexOf(connection);
      if (index >= 0) connections.splice(index, 1);
    });
    onConnection(connection);
  });

  // Ping idle clients; drop the ones that stopped answering (phone left the
  // WLAN, app killed without a close frame, ...).
  var timer = setInterval(function () {
    var now = Date.now();
    connections.slice().forEach(function (connection) {
      if (now - connection.lastSeenAt > heartbeatMs * 2 + 2000) {
        connection.close(1001, "heartbeat timeout");
        return;
      }
      connection.ping();
    });
  }, heartbeatMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    connections: connections,
    broadcast: function (value) {
      var text = JSON.stringify(value);
      connections.forEach(function (connection) {
        connection.send(text);
      });
    },
    stop: function () {
      clearInterval(timer);
      connections.slice().forEach(function (connection) {
        connection.close(1001, "server stopping");
      });
    }
  };
}

module.exports = {
  attachWebSocketServer: attachWebSocketServer,
  WsConnection: WsConnection
};
