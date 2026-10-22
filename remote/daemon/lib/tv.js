// TV adapter: everything the hub needs from webOS, done through `luna-send` (the daemon runs
// as root, so no dev-mode sandbox applies). Each call resolves, never rejects.
"use strict";

var childProcess = require("child_process");
var execFile = childProcess.execFile;
var fs = require("fs");
var os = require("os");

// Remote buttons as Linux key codes for LG's own remote input device ("LGE RCU"). Writing key
// events to that device makes webOS treat them exactly like presses on the physical remote.
// Codes verified on webOS 10 (OLED C4): e.g. OK is KEY_ENTER and Back is KEY_PREVIOUS.
var REMOTE_KEYS = {
  up: 103,
  down: 108,
  left: 105,
  right: 106,
  ok: 28,
  back: 412,
  play: 207,
  pause: 119,
  rewind: 168,
  fastForward: 208,
  channelUp: 402,
  channelDown: 403,
  info: 358,
  power: 116,
  red: 398,
  green: 399,
  yellow: 400,
  blue: 401,
  0: 11,
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
  6: 7,
  7: 8,
  8: 9,
  9: 10
};
var REMOTE_DEVICE_NAME = "LGE RCU";
var KEY_PRESS_MS = 40;

// System screens the remote can open directly (the Home and Settings keys do not inject
// reliably, launching the apps does).
var LAUNCH_TARGETS = {
  home: "com.webos.app.home",
  settings: "com.palm.app.settings",
  hdmi1: "com.webos.app.hdmi1",
  hdmi2: "com.webos.app.hdmi2",
  hdmi3: "com.webos.app.hdmi3",
  hdmi4: "com.webos.app.hdmi4"
};
var APP_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Event node of the remote input device, from /proc/bus/input/devices text. */
function remoteDevicePath(devicesText) {
  var blocks = String(devicesText || "").split(/\n\s*\n/);
  for (var i = 0; i < blocks.length; i += 1) {
    if (blocks[i].indexOf('Name="' + REMOTE_DEVICE_NAME + '"') < 0) continue;
    var match = blocks[i].match(/Handlers=.*?\b(event\d+)\b/);
    if (match) return "/dev/input/" + match[1];
  }
  return null;
}

/** One `struct input_event`; the timeval fields are 64-bit on arm64/x64. */
function inputEvent(type, code, value, wide) {
  var size = wide ? 24 : 16;
  var buffer = Buffer.alloc(size);
  var nowMs = Date.now();
  var seconds = Math.floor(nowMs / 1000);
  var micros = (nowMs % 1000) * 1000;
  if (wide) {
    buffer.writeBigInt64LE(BigInt(seconds), 0);
    buffer.writeBigInt64LE(BigInt(micros), 8);
  } else {
    buffer.writeInt32LE(seconds, 0);
    buffer.writeInt32LE(micros, 4);
  }
  buffer.writeUInt16LE(type, size - 8);
  buffer.writeUInt16LE(code, size - 6);
  buffer.writeInt32LE(value, size - 4);
  return buffer;
}

var LUNA_TIMEOUT_MS = 5000;
var SUBSCRIPTION_RETRY_MS = 5000;

function createLunaCaller(options) {
  var binary = options.lunaSend || "luna-send";
  var callerId = options.appId;

  return function call(uri, params) {
    return new Promise(function (resolve) {
      var args = ["-n", "1"];
      if (callerId) args.push("-a", callerId);
      args.push(uri, JSON.stringify(params || {}));
      execFile(binary, args, { timeout: LUNA_TIMEOUT_MS }, function (error, stdout) {
        var text = String(stdout || "");
        var start = text.indexOf("{");
        if (start >= 0) {
          try {
            resolve(JSON.parse(text.slice(start)));
            return;
          } catch (parseError) {
            // fall through to the error below
          }
        }
        resolve({
          returnValue: false,
          errorText: error ? error.message : "no reply: " + text.trim()
        });
      });
    });
  };
}

/**
 * Keeps `luna-send -i <uri> {"subscribe":true}` running and calls onReply for every JSON line.
 * Restarts the process when it exits. No caller id (-a): as root, system services answer.
 */
function createLunaSubscriber(options) {
  var binary = options.lunaSend || "luna-send";
  var spawn = options.spawn || childProcess.spawn;

  return function subscribe(uri, onReply) {
    var child = null;
    var stopped = false;
    var retryTimer = null;

    function start() {
      if (stopped) return;
      var buffer = "";
      try {
        child = spawn(binary, ["-i", uri, JSON.stringify({ subscribe: true })]);
      } catch (error) {
        retry();
        return;
      }
      child.stdout.on("data", function (chunk) {
        buffer += String(chunk);
        var index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          var line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.charAt(0) !== "{") continue;
          try {
            onReply(JSON.parse(line));
          } catch (parseError) {
            // ignore lines that are not complete JSON
          }
        }
      });
      child.on("error", function () {});
      child.on("exit", function () {
        child = null;
        retry();
      });
    }

    function retry() {
      if (stopped || retryTimer) return;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        start();
      }, SUBSCRIPTION_RETRY_MS);
      if (typeof retryTimer.unref === "function") retryTimer.unref();
    }

    start();
    return function stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (child) child.kill();
    };
  };
}

// Power states in which nothing is shown or heard. "Screen Off" keeps the sound running, so
// playback continues there.
function isPoweredOn(reply) {
  var state = String(reply.state || "");
  var processing = String(reply.processing || "");
  if (/power off|suspend|standby/i.test(processing)) return false;
  return state === "Active" || state === "Screen Off" || state === "Screen Saver";
}

/** Tries the calls in order and resolves with the first successful payload. */
function firstOk(call, calls) {
  var errors = [];
  return calls
    .reduce(function (chain, entry) {
      return chain.then(function (found) {
        if (found) return found;
        return call(entry[0], entry[1]).then(function (result) {
          if (result && result.returnValue) return result;
          errors.push(entry[0] + ": " + ((result && result.errorText) || "failed"));
          return null;
        });
      });
    }, Promise.resolve(null))
    .then(function (found) {
      return { result: found, error: errors.join("; ") };
    });
}

// webOS 5+ uses com.webos.service.audio/master/*, older firmware com.webos.audio/*.
// On webOS 23 (tested) master/getVolume is denied for apps, so read via com.webos.audio first.
var VOLUME_CALLS = {
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
var VOLUME_GET = [
  ["luna://com.webos.audio/getVolume", {}],
  ["luna://com.webos.service.audio/master/getVolume", {}]
];

function readVolume(result) {
  if (!result) return { level: null, muted: null };
  var muted = result.muteStatus != null ? result.muteStatus : result.muted;
  if (muted == null && result.volumeStatus) muted = result.volumeStatus.muteStatus;
  var level =
    result.volume != null ? result.volume : result.volumeStatus && result.volumeStatus.volume;
  return { level: level == null ? null : Number(level), muted: muted == null ? null : !!muted };
}

// MAC of the LAN interface (Ethernet before Wi-Fi), for Wake-on-LAN from the phone.
function lanMac(interfaces) {
  var names = Object.keys(interfaces).sort(function (a, b) {
    return (/^eth/.test(b) ? 1 : 0) - (/^eth/.test(a) ? 1 : 0);
  });
  for (var i = 0; i < names.length; i++) {
    var entries = interfaces[names[i]] || [];
    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (
        !entry.internal &&
        entry.family === "IPv4" &&
        entry.mac &&
        entry.mac !== "00:00:00:00:00:00"
      )
        return entry.mac;
    }
  }
  return null;
}

function createTv(options) {
  var call = options.call || createLunaCaller(options);
  var subscribe = options.subscribe || createLunaSubscriber(options);
  var appId = options.appId;
  var alertId = null;

  function volume(action, level) {
    var calls = VOLUME_CALLS[action];
    if (action === "set") {
      var target = Math.max(0, Math.min(100, Math.round(Number(level))));
      calls = isFinite(target)
        ? [
            ["luna://com.webos.service.audio/master/setVolume", { volume: target }],
            ["luna://com.webos.audio/setVolume", { volume: target }]
          ]
        : null;
    }
    var change = calls ? firstOk(call, calls) : Promise.resolve(null);
    return change.then(function (changed) {
      return firstOk(call, VOLUME_GET).then(function (read) {
        var state = readVolume(read.result);
        var failed = changed && !changed.result;
        return {
          ok: !failed && !!read.result,
          level: state.level,
          muted: state.muted,
          error: failed ? changed.error : read.result ? null : read.error
        };
      });
    });
  }

  function info() {
    return Promise.all([
      call("luna://com.webos.service.settings/getSystemSettings", {
        category: "network",
        keys: ["deviceName"]
      }),
      call("luna://com.webos.service.tv.systemproperty/getSystemInfo", { keys: ["modelName"] })
    ]).then(function (results) {
      var settings = (results[0] && results[0].settings) || {};
      return {
        name: settings.deviceName || null,
        model: results[1] && results[1].modelName ? results[1].modelName : null,
        mac: lanMac(os.networkInterfaces())
      };
    });
  }

  function launchApp() {
    return call("luna://com.webos.applicationManager/launch", {
      id: appId,
      params: { source: "nuvio-remote" }
    }).then(function (result) {
      return { ok: !!result.returnValue, error: result.errorText || null };
    });
  }

  var keyDevice = null;
  function keyDevicePath() {
    if (keyDevice) return keyDevice;
    var text = "";
    try {
      text = fs.readFileSync("/proc/bus/input/devices", "utf8");
    } catch (error) {
      text = "";
    }
    keyDevice = remoteDevicePath(text) || "/dev/input/event0";
    return keyDevice;
  }

  /** Presses one remote button (see REMOTE_KEYS). */
  function pressKey(name) {
    var code = REMOTE_KEYS[name];
    if (code == null) return Promise.resolve({ ok: false, error: "unknown key " + name });
    var wide = os.arch() === "arm64" || os.arch() === "x64";
    var write = options.writeKey;
    return new Promise(function (resolve) {
      var fd;
      try {
        fd = write ? null : fs.openSync(keyDevicePath(), "w");
        var emit = function (type, eventCode, value) {
          var event = inputEvent(type, eventCode, value, wide);
          if (write) write(event);
          else fs.writeSync(fd, event);
        };
        emit(1, code, 1);
        emit(0, 0, 0);
        setTimeout(function () {
          try {
            emit(1, code, 0);
            emit(0, 0, 0);
            resolve({ ok: true });
          } catch (error) {
            resolve({ ok: false, error: error.message });
          } finally {
            if (fd != null) fs.closeSync(fd);
          }
        }, KEY_PRESS_MS);
      } catch (error) {
        if (fd != null) fs.closeSync(fd);
        resolve({ ok: false, error: error.message });
      }
    });
  }

  /** Opens Home, Settings, an HDMI input or any app id. */
  function launchTarget(target) {
    var id = LAUNCH_TARGETS[target] || target;
    if (!APP_ID_PATTERN.test(String(id || ""))) {
      return Promise.resolve({ ok: false, error: "bad target" });
    }
    return call("luna://com.webos.applicationManager/launch", { id: id }).then(function (result) {
      return { ok: !!result.returnValue, error: result.errorText || null };
    });
  }

  /** Apps a user would open from the home screen. */
  function listApps() {
    return call("luna://com.webos.applicationManager/listApps", {}).then(function (result) {
      var apps = Array.isArray(result.apps) ? result.apps : [];
      return apps
        .filter(function (app) {
          return app && app.id && app.visible !== false && app.title;
        })
        .map(function (app) {
          return { id: String(app.id), title: String(app.title) };
        })
        .sort(function (a, b) {
          return a.title.localeCompare(b.title);
        });
    });
  }

  function hideCode() {
    if (!alertId) return Promise.resolve();
    var id = alertId;
    alertId = null;
    return call("luna://com.webos.notification/closeAlert", { alertId: id });
  }

  // A system alert stays on screen until the code is entered, on top of whatever app is open.
  // Toasts vanish after a few seconds, so they are only the fallback.
  function showCode(code, clientName) {
    var spaced = code.slice(0, 3) + " " + code.slice(3);
    // Language-neutral on purpose: the daemon has no access to the app's locale.
    var text = clientName + " · Code: " + spaced;
    return hideCode()
      .then(function () {
        return call("luna://com.webos.notification/createAlert", {
          sourceId: appId,
          title: "Nuvio Remote",
          message: text,
          modal: false,
          buttons: [{ label: "OK" }]
        });
      })
      .then(function (result) {
        if (result.returnValue && result.alertId) {
          alertId = result.alertId;
          return;
        }
        return call("luna://com.webos.notification/createToast", {
          sourceId: appId,
          message: text
        });
      });
  }

  /**
   * Reports whether the TV is on and which app is in front: onChange({poweredOn, foregroundAppId}).
   * Either value stays null until webOS has answered. Returns a stop function.
   */
  function watchPresence(onChange) {
    var presence = { poweredOn: null, foregroundAppId: null };
    function update(key, value) {
      if (presence[key] === value) return;
      presence[key] = value;
      onChange({ poweredOn: presence.poweredOn, foregroundAppId: presence.foregroundAppId });
    }
    var stops = [
      subscribe("luna://com.webos.service.tvpower/power/getPowerState", function (reply) {
        if (reply.returnValue === false || reply.state == null) return;
        update("poweredOn", isPoweredOn(reply));
      }),
      subscribe("luna://com.webos.applicationManager/getForegroundAppInfo", function (reply) {
        // An empty id shows up briefly while apps switch; wait for the real one.
        if (reply.returnValue === false || !reply.appId) return;
        update("foregroundAppId", String(reply.appId));
      })
    ];
    return function stop() {
      stops.forEach(function (stopOne) {
        stopOne();
      });
    };
  }

  return {
    watchPresence: watchPresence,
    volume: volume,
    info: info,
    launchApp: launchApp,
    pressKey: pressKey,
    launchTarget: launchTarget,
    listApps: listApps,
    showCode: showCode,
    hideCode: hideCode
  };
}

module.exports = {
  createTv: createTv,
  createLunaCaller: createLunaCaller,
  createLunaSubscriber: createLunaSubscriber,
  remoteDevicePath: remoteDevicePath,
  inputEvent: inputEvent,
  REMOTE_KEYS: REMOTE_KEYS,
  isPoweredOn: isPoweredOn,
  lanMac: lanMac,
  readVolume: readVolume
};
