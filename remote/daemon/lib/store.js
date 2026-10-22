// Small JSON file store: the TV's stable id, the tokens of paired phones and the apps opened
// most recently (webOS keeps no launch history the daemon can read).
"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

function createStore(file, log) {
  var data = { tvId: null, tokens: {}, recentApps: [] };
  try {
    data = Object.assign(data, JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT")
      (log || console.log)("store: unreadable " + file + ": " + error.message);
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (error) {
      // Node < 10 has no recursive mkdir; the parent usually exists already.
    }
    var temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 384 });
    fs.renameSync(temp, file);
  }

  if (!data.tvId) {
    data.tvId = crypto.randomBytes(6).toString("hex");
    save();
  }

  return {
    tvId: function () {
      return data.tvId;
    },
    addToken: function (token, info) {
      data.tokens[token] = Object.assign({ lastSeenAt: info.createdAt }, info);
      save();
    },
    hasToken: function (token) {
      return Object.prototype.hasOwnProperty.call(data.tokens, token);
    },
    /** Returns true when the token is known; refreshes its lastSeenAt. */
    touchToken: function (token, now) {
      var entry = data.tokens[token];
      if (!entry) return false;
      entry.lastSeenAt = now;
      save();
      return true;
    },
    removeToken: function (token) {
      delete data.tokens[token];
      save();
    },
    /** Remembers that an app came to the front; newest first, at most 30. */
    noteAppOpened: function (appId, now) {
      if (!appId) return;
      var recent = (Array.isArray(data.recentApps) ? data.recentApps : []).filter(function (entry) {
        return entry && entry.id !== appId;
      });
      recent.unshift({ id: appId, at: now });
      data.recentApps = recent.slice(0, 30);
      save();
    },
    /** Remote-only client key for the TV's own API (SSAP), shared with paired phones. */
    ssapKey: function () {
      return data.ssapKey || null;
    },
    setSsapKey: function (key) {
      data.ssapKey = key || null;
      save();
    },
    recentAppIds: function () {
      return (Array.isArray(data.recentApps) ? data.recentApps : []).map(function (entry) {
        return entry.id;
      });
    },
    listTokens: function () {
      return Object.keys(data.tokens).map(function (token) {
        return Object.assign({ token: token.slice(0, 6) + "…" }, data.tokens[token]);
      });
    }
  };
}

module.exports = { createStore: createStore };
