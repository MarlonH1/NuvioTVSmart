// Registers the daemon with the TV's own remote API (SSAP, wss://127.0.0.1:3001) and returns the
// client key. The key is requested with remote-control permissions only and handed to paired
// phones, which then talk to the TV API directly. No external dependency: the daemon runs on the
// TV's Node and stays a plain copy of these files.
//
// The signed manifest block (ssap-manifest.json) is the public one shipped by the lgtv2 library
// (MIT, github.com/hobbyquaker/lgtv2); webOS checks it to identify the client app.
"use strict";

var tls = require("tls");
var crypto = require("crypto");
var manifestTemplate = require("./ssap-manifest.json");

// What a phone remote needs, nothing more: no settings, notifications, channels or recordings.
var REMOTE_PERMISSIONS = [
  "LAUNCH",
  "CONTROL_AUDIO",
  "CONTROL_POWER",
  "CONTROL_INPUT_JOYSTICK",
  "CONTROL_INPUT_MEDIA_PLAYBACK",
  "CONTROL_INPUT_TV",
  "CONTROL_MOUSE_AND_KEYBOARD",
  "READ_INSTALLED_APPS",
  "READ_INPUT_DEVICE_LIST",
  "READ_RUNNING_APPS",
  "READ_POWER_STATE"
];
var SSAP_PORT = 3001;
var REGISTER_TIMEOUT_MS = 90000;

function registrationPayload(signed, clientKey) {
  var manifest = {
    manifestVersion: manifestTemplate.manifestVersion,
    appVersion: signed ? manifestTemplate.appVersion : "1.0",
    permissions: REMOTE_PERMISSIONS.slice()
  };
  if (signed) {
    manifest.signed = manifestTemplate.signed;
    manifest.signatures = manifestTemplate.signatures;
  }
  var payload = { forcePairing: false, pairingType: "PROMPT", manifest: manifest };
  if (clientKey) payload["client-key"] = clientKey;
  return payload;
}

/** One masked client text frame (RFC 6455 5.3). */
function clientFrame(text) {
  var payload = Buffer.from(String(text), "utf8");
  var length = payload.length;
  var header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x81;
  var mask = crypto.randomBytes(4);
  var masked = Buffer.alloc(length);
  for (var i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Text messages from unmasked server frames; returns [messages, rest]. */
function readServerFrames(buffer) {
  var messages = [];
  var offset = 0;
  while (buffer.length - offset >= 2) {
    var opcode = buffer[offset] & 0x0f;
    var length = buffer[offset + 1] & 0x7f;
    var header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = buffer.readUInt32BE(offset + 6);
      header = 10;
    }
    if (buffer.length - offset < header + length) break;
    if (opcode === 0x1)
      messages.push(buffer.slice(offset + header, offset + header + length).toString("utf8"));
    offset += header + length;
  }
  return [messages, buffer.slice(offset)];
}

/**
 * Registers with the TV and resolves {ok, key} or {ok: false, error}. Without a known key the TV
 * shows an "allow" prompt and the promise waits for the answer.
 */
function registerRemoteKey(options) {
  options = options || {};
  var connect = options.connect || tls.connect;
  var log = options.log || function () {};
  return attempt(true).then(function (result) {
    // Newer firmware rejects the published signature; the unsigned manifest still works there.
    if (!result.ok && /blacklisted certificate/i.test(result.error || "")) {
      log("ssap: signed manifest rejected, registering unsigned");
      return attempt(false);
    }
    return result;
  });

  function attempt(signed) {
    return new Promise(function (resolve) {
      var done = false;
      var buffer = Buffer.alloc(0);
      var upgraded = false;
      var socket = connect(
        { host: "127.0.0.1", port: SSAP_PORT, rejectUnauthorized: false },
        function () {
          socket.write(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:" +
              SSAP_PORT +
              "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " +
              crypto.randomBytes(16).toString("base64") +
              "\r\n\r\n"
          );
        }
      );
      var timer = setTimeout(function () {
        finish({ ok: false, error: "no answer from the TV prompt" });
      }, options.timeoutMs || REGISTER_TIMEOUT_MS);
      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch (error) {
          // already closed
        }
        resolve(result);
      }
      socket.on("data", function (chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          var end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          if (!/^HTTP\/1\.1 101/.test(buffer.slice(0, end).toString("utf8"))) {
            finish({ ok: false, error: "websocket upgrade refused" });
            return;
          }
          upgraded = true;
          buffer = buffer.slice(end + 4);
          socket.write(
            clientFrame(
              JSON.stringify({
                type: "register",
                id: "register_0",
                payload: registrationPayload(signed, options.clientKey)
              })
            )
          );
        }
        var parsed = readServerFrames(buffer);
        buffer = parsed[1];
        parsed[0].forEach(function (text) {
          var message;
          try {
            message = JSON.parse(text);
          } catch (error) {
            return;
          }
          if (message.type === "registered" && message.payload && message.payload["client-key"]) {
            finish({ ok: true, key: String(message.payload["client-key"]) });
          } else if (message.type === "error") {
            finish({ ok: false, error: String(message.error || "registration failed") });
          } else if (message.payload && message.payload.pairingType === "PROMPT") {
            log("ssap: waiting for the user to allow the remote on the TV");
          }
        });
      });
      socket.on("error", function (error) {
        finish({ ok: false, error: error.message });
      });
      socket.on("close", function () {
        finish({ ok: false, error: "connection closed" });
      });
    });
  }
}

module.exports = {
  registerRemoteKey: registerRemoteKey,
  registrationPayload: registrationPayload,
  clientFrame: clientFrame,
  readServerFrames: readServerFrames,
  REMOTE_PERMISSIONS: REMOTE_PERMISSIONS,
  SSAP_PORT: SSAP_PORT
};
