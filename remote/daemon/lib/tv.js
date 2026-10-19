// TV adapter: everything the hub needs from webOS, done through `luna-send` (the daemon runs
// as root, so no dev-mode sandbox applies). Each call resolves, never rejects.
"use strict";

var childProcess = require("child_process");
var execFile = childProcess.execFile;

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
        model: results[1] && results[1].modelName ? results[1].modelName : null
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
    showCode: showCode,
    hideCode: hideCode
  };
}

module.exports = {
  createTv: createTv,
  createLunaCaller: createLunaCaller,
  createLunaSubscriber: createLunaSubscriber,
  isPoweredOn: isPoweredOn,
  readVolume: readVolume
};
