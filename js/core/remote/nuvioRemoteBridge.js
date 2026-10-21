// Nuvio Remote: connects the TV app to the root daemon (remote/daemon) on the same TV.
// The daemon talks to phones; this bridge turns its play/cmd messages into player actions and
// reports PlaybackState back (protocol: NuvioMobile docs/remote-protocol.md).
//
// Off by default (LocalStore "nuvioRemoteEnabled"). Without the daemon the socket simply never
// connects and the bridge retries quietly in the background.
import { LocalStore } from "../storage/localStore.js";
import { Router } from "../../ui/navigation/routerState.js";
import { PlayerController } from "../player/playerController.js";
import { findFollowingPostCreditsScene } from "../player/skipIntervalRules.js";
import { showRemotePairingCode, hideRemotePairingCode } from "./nuvioRemotePairingOverlay.js";

export const NUVIO_REMOTE_ENABLED_KEY = "nuvioRemoteEnabled";
// Overridable for tests (scripts/test-nuvio-remote-bridge.mjs).
const DAEMON_URL = globalThis.__NUVIO_REMOTE_DAEMON_URL__ || "ws://127.0.0.1:47800/app";
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const STATE_POLL_MS = 1000;
// Drift corrections go out immediately, so the periodic refresh can be slow (phone battery).
const STATE_HEARTBEAT_MS = 30000;
const READY_WAIT_MS = 30000;
const FOREGROUND_GUARD_MS = 8000;
const REMOTE_STREAM_ID = "nuvio-remote";
// Routes where the user is not "in" the app yet (sign-in, profile picker, onboarding).
const NOT_READY_ROUTES = new Set([
  "profileSelection",
  "authQrSignIn",
  "authSignIn",
  "serverConnection",
  "syncCode",
  "experienceModeSelection",
  "essentialAddonSetup"
]);

let socket = null;
let started = false;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let pollTimer = null;
let lastStateJson = "";
let lastStateSentAt = 0;
let lastSentPlayback = null;
let pendingPlayToken = 0;
let foregroundGuardUntil = 0;
let lastError = null;
let lifecycleBound = false;
// Watch party hooks, installed by the party UI (setRemotePartySource) so this module does not
// pull in the party repository: getParty() -> active party or null, subscribe(listener),
// invite(friendCode) -> {ok, code?}.
let partySource = null;
let lastPartyJson = "";

export function isNuvioRemoteEnabled() {
  return LocalStore.get(NUVIO_REMOTE_ENABLED_KEY, false) === true;
}

export function setNuvioRemoteEnabled(enabled) {
  LocalStore.set(NUVIO_REMOTE_ENABLED_KEY, Boolean(enabled));
  if (enabled) startNuvioRemoteBridge();
  else stopNuvioRemoteBridge();
}

export function isNuvioRemoteConnected() {
  return Boolean(socket && socket.readyState === 1);
}

/**
 * True for a few seconds after a remote play request. The webOS relaunch handler would
 * otherwise send the user home because "player" is not a restorable route.
 */
export function isNuvioRemoteForegroundRequest() {
  return Date.now() < foregroundGuardUntil;
}

export function setRemotePartySource(source) {
  partySource = source || null;
  partySource?.subscribe?.(() => pushParty());
  pushParty(true);
}

/** Party as the phone sees it (protocol: party.state), or null outside a party. */
export function remotePartyPayload(party) {
  if (!party?.code) return null;
  const media = party.media || {};
  return {
    code: party.code,
    title: media.title || "",
    season: media.season ?? null,
    episode: media.episode ?? null,
    poster: media.poster || null,
    maxMembers: Number(party.maxMembers) || 0,
    isHost: Boolean(party.memberId) && party.memberId === party.hostMemberId,
    members: (party.members || []).map((member) => ({
      name: member.display_name || "",
      host: member.id === party.hostMemberId,
      self: member.id === party.memberId
    }))
  };
}

function pushParty(force = false) {
  if (!isNuvioRemoteConnected()) return;
  let party = null;
  try {
    party = remotePartyPayload(partySource?.getParty?.());
  } catch (_) {}
  const json = JSON.stringify(party);
  if (!force && json === lastPartyJson) return;
  if (send({ type: "party.state", party })) lastPartyJson = json;
}

async function partyInvite(message) {
  let result = { ok: false, code: "no_party" };
  try {
    if (partySource?.invite) result = (await partySource.invite(message.friendCode)) || result;
  } catch (_) {
    result = { ok: false, code: "failed" };
  }
  send({
    type: "party.invite.result",
    requestId: message.requestId,
    ok: result.ok === true,
    code: result.ok === true ? undefined : result.code || "failed"
  });
}

export function startNuvioRemoteBridge() {
  if (started || !isNuvioRemoteEnabled() || typeof WebSocket !== "function") return;
  started = true;
  bindLifecycle();
  connect();
  pollTimer = setInterval(pushStateIfChanged, STATE_POLL_MS);
}

export function stopNuvioRemoteBridge() {
  started = false;
  clearTimeout(reconnectTimer);
  clearInterval(pollTimer);
  reconnectTimer = null;
  pollTimer = null;
  hideRemotePairingCode();
  if (socket) {
    const closing = socket;
    socket = null;
    try {
      closing.close();
    } catch (_) {}
  }
}

function connect() {
  if (!started) return;
  let ws;
  try {
    ws = new WebSocket(DAEMON_URL);
  } catch (_) {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    lastStateJson = "";
    send({
      type: "app.hello",
      version: globalThis.__NUVIO_APP_VERSION__ || null,
      appId: readAppId()
    });
    pushStateIfChanged(true);
    pushParty(true);
  };
  ws.onmessage = (event) => {
    let message = null;
    try {
      message = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (message) handleMessage(message);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    hideRemotePairingCode();
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

// The daemon compares this with the foreground app to see whether Nuvio is on screen.
function readAppId() {
  const identifier = String(
    globalThis.webOSSystem?.identifier || globalThis.PalmSystem?.identifier || ""
  );
  return identifier.split(" ")[0] || null;
}

// webOS freezes the app when the TV is switched off or another app/input comes to the front.
// Pause first and report it while the socket still works, so the phone does not keep showing
// "playing" for a player nobody watches.
function onHidden() {
  const player = currentPlayer();
  if (player && !player.paused) safe(() => player.applyMediaAction("pause"));
  pushStateIfChanged(true);
}

function onVisible() {
  pushStateIfChanged(true);
}

function bindLifecycle() {
  if (lifecycleBound || typeof document === "undefined") return;
  lifecycleBound = true;
  const isHidden = () => document.visibilityState === "hidden" || document.webkitHidden === true;
  const sync = () => (isHidden() ? onHidden() : onVisible());
  document.addEventListener("visibilitychange", sync);
  document.addEventListener("webkitvisibilitychange", sync);
  globalThis.addEventListener?.("pagehide", onHidden);
}

function scheduleReconnect() {
  if (!started || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function send(message) {
  if (!isNuvioRemoteConnected()) return false;
  socket.send(JSON.stringify({ v: 1, ...message }));
  return true;
}

function handleMessage(message) {
  switch (message.type) {
    case "play":
      void playRequest(message.request);
      break;
    case "cmd":
      void runCommand(message);
      break;
    case "pair.show":
      showRemotePairingCode(message.code, message.clientName);
      break;
    case "pair.hide":
      hideRemotePairingCode();
      break;
    case "state.get":
      pushStateIfChanged(true);
      pushParty(true);
      break;
    case "party.invite":
      void partyInvite(message);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ play

function currentPlayer() {
  return Router.getCurrent() === "player" ? Router.getCurrentScreen() : null;
}

async function waitUntilReady(token) {
  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline) {
    if (token !== pendingPlayToken) return false;
    const route = Router.getCurrent();
    if (route && !NOT_READY_ROUTES.has(route)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

export function buildRemotePlayerParams(request) {
  const media = request?.media || {};
  const stream = request?.stream || {};
  const itemType =
    media.type === "series" || media.metaType === "series" ? "series" : media.type || "movie";
  const metaId = media.metaId ? String(media.metaId) : null;
  const headers = stream.headers && typeof stream.headers === "object" ? stream.headers : {};
  const responseHeaders =
    stream.responseHeaders && typeof stream.responseHeaders === "object"
      ? stream.responseHeaders
      : {};
  const subtitles = Array.isArray(stream.subtitles)
    ? stream.subtitles
        .filter((subtitle) => subtitle && subtitle.url)
        .map((subtitle, index) => ({
          id: subtitle.id || `remote-sub-${index}`,
          url: subtitle.url,
          lang: subtitle.lang || "und",
          label: subtitle.label || undefined,
          addonName: "Nuvio Remote",
          ...(subtitle.headers
            ? { behaviorHints: { proxyHeaders: { request: subtitle.headers } } }
            : {})
        }))
    : [];
  const startPositionMs = Math.max(0, Number(request?.startPositionMs) || 0);
  const name = stream.name || stream.addonName || "Nuvio Remote";
  return {
    streamUrl: stream.url,
    itemId: metaId,
    itemType,
    imdbId: metaId && /^tt\d+$/.test(metaId) ? metaId : null,
    videoId: media.videoId || metaId,
    season:
      Number.isFinite(Number(media.season)) && media.season != null ? Number(media.season) : null,
    episode:
      Number.isFinite(Number(media.episode)) && media.episode != null
        ? Number(media.episode)
        : null,
    // Metadata from the phone: the TV may never have opened this title's detail
    // page, so its own meta cache can be empty (anime speed needs genres).
    remoteMeta: {
      genres: Array.isArray(media.genres) ? media.genres.map(String).slice(0, 20) : [],
      country: media.country ? String(media.country) : "",
      originalLanguage: media.language ? String(media.language) : ""
    },
    itemTitle: media.title || "",
    playerTitle: media.title || "",
    playerSubtitle: media.episodeTitle || "",
    playerEpisodeTitle: media.episodeTitle || "",
    episodeTitle: media.episodeTitle || "",
    poster: media.poster || null,
    backdrop: media.background || null,
    playerBackdropUrl: media.background || null,
    logo: media.logo || null,
    playerLogoUrl: media.logo || null,
    resumePositionMs: startPositionMs,
    startFromBeginning: startPositionMs === 0,
    episodes: [],
    streamCandidates: [
      {
        id: REMOTE_STREAM_ID,
        url: stream.url,
        name,
        title: name,
        description: stream.description || "",
        addonName: stream.addonName || "Nuvio Remote",
        addonId: stream.addonId || "",
        subtitles,
        behaviorHints: {
          filename: stream.filename || undefined,
          videoSize: stream.videoSize || undefined,
          bingeGroup: stream.bingeGroup || undefined,
          proxyHeaders: { request: headers, response: responseHeaders }
        }
      }
    ],
    preferredStreamId: REMOTE_STREAM_ID,
    returnToStreamOnBack: false,
    returnToHomeOnBack: true
  };
}

async function playRequest(request) {
  if (!request?.stream?.url) return;
  const token = ++pendingPlayToken;
  foregroundGuardUntil = Date.now() + FOREGROUND_GUARD_MS;
  sendState({ ...idleState(), status: "loading", media: request.media || null });
  if (!(await waitUntilReady(token))) {
    if (token === pendingPlayToken)
      reportError("Nuvio is not ready (sign-in or profile selection)", request.media);
    return;
  }
  const replace = Router.getCurrent() === "player";
  try {
    foregroundGuardUntil = Date.now() + FOREGROUND_GUARD_MS;
    await Router.navigate("player", buildRemotePlayerParams(request), { replaceHistory: replace });
    lastError = null;
  } catch (error) {
    console.warn("[nuvio-remote] play failed", error);
    reportError(String(error?.message || error), request.media);
  }
}

function reportError(message, media) {
  lastError = message;
  sendState({ ...idleState(), status: "error", media: media || null, error: message });
}

// ------------------------------------------------------------------ commands

function findSubtitleEntry(player, trackId) {
  for (const tab of ["builtIn", "addons"]) {
    const entries = safe(() => player.getSubtitleEntries(tab), []) || [];
    const entry =
      trackId == null
        ? entries.find((item) => item.trackIndex === -1)
        : entries.find((item) => item.id === trackId);
    if (entry) return entry;
  }
  return null;
}

async function runCommand(message) {
  const player = currentPlayer();
  if (!player) {
    pushStateIfChanged(true);
    return;
  }
  const durationMs = Math.round(safe(() => player.getPlaybackDurationSeconds(), 0) * 1000);
  const clampMs = (ms) => Math.max(0, durationMs > 0 ? Math.min(ms, durationMs - 1000) : ms);
  switch (message.action) {
    case "play":
    case "pause":
    case "toggle":
      player.applyMediaAction(message.action);
      break;
    case "stop":
      safe(() => player.navigateBackToStreamScreen({ forceDetail: false }));
      break;
    case "seek":
      if (Number.isFinite(Number(message.positionMs))) {
        player.seekPlaybackSeconds(clampMs(Number(message.positionMs)) / 1000);
      }
      break;
    case "seekBy": {
      const currentMs = safe(() => player.getPlaybackCurrentSeconds(), 0) * 1000;
      player.seekPlaybackSeconds(clampMs(currentMs + (Number(message.deltaMs) || 0)) / 1000);
      break;
    }
    case "next":
      await safe(() => player.playNextEpisode({ userInitiated: true }));
      break;
    case "audio": {
      const entries = safe(() => player.getAudioEntries(), []) || [];
      const index = entries.findIndex((entry) => entry.id === message.trackId);
      if (index >= 0) player.applyAudioTrack(index, { rememberSelection: true });
      break;
    }
    case "subtitle": {
      const entry = findSubtitleEntry(
        player,
        message.trackId == null ? null : String(message.trackId)
      );
      if (entry) await safe(() => player.applySubtitleEntry(entry));
      break;
    }
    case "subtitleDelay":
      if (Number.isFinite(Number(message.delayMs))) {
        player.setSubtitleDelayValue(Number(message.delayMs), { showOverlay: true });
      }
      break;
    case "skip":
      // Same path as the on-screen "Skip Intro"/"Skip Recap" button.
      safe(() => player.skipActiveInterval());
      break;
    case "speed": {
      // Same path as the speed dialog, so party rules and the label stay in sync.
      const rate = Number(message.rate);
      const supported = safe(() => player.getPlaybackSpeedOptions(), []) || [];
      if (supported.some((option) => Math.abs(option - rate) < 0.01)) {
        await safe(() => player.applyPlaybackSpeed(rate));
      }
      break;
    }
    default:
      break;
  }
  // Track lists are cached per dialog; drop the cache so the next state reflects the change.
  if (player.trackDialogCache) player.trackDialogCache = null;
  setTimeout(() => pushStateIfChanged(true), 250);
}

// ------------------------------------------------------------------ state

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch (_) {
    return fallback;
  }
}

function idleState() {
  return {
    status: "idle",
    positionMs: 0,
    durationMs: 0,
    at: Date.now(),
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

function playerMedia(player) {
  const params = player.params || {};
  const itemType = String(params.itemType || "movie");
  return {
    type: itemType === "series" || itemType === "tv" ? "series" : "movie",
    metaId: String(params.itemId || ""),
    metaType: itemType,
    videoId: params.videoId || null,
    season: params.season ?? null,
    episode: params.episode ?? null,
    title: params.playerTitle || params.itemTitle || params.itemId || "",
    episodeTitle: params.playerEpisodeTitle || params.episodeTitle || null,
    poster: params.poster || null,
    background: params.playerBackdropUrl || params.backdrop || null,
    logo: params.playerLogoUrl || params.logo || null
  };
}

function playerStatus(player) {
  if (safe(() => player.isStartupErrorVisible(), false)) return "error";
  if (PlayerController.video?.ended || player.postPlayPlaybackEnded) return "ended";
  if (!player.hasPresentedPlaybackFrame) return "loading";
  if (player.bufferingActive || player.loadingVisible || player.seekLoading) return "buffering";
  return player.paused ? "paused" : "playing";
}

// The segment the on-screen skip button would skip right now. Stays set for the whole interval,
// even after the TV button auto-hides, so the phone can still offer it.
function readSkip(player) {
  const interval = player.activeSkipInterval;
  if (!interval || !safe(() => player.isSkipIntroPlaybackReady(), false)) return null;
  const type = String(interval.type || "")
    .trim()
    .toLowerCase();
  const kind =
    type === "recap"
      ? "recap"
      : type === "outro" || type === "ed" || type === "mixed-ed"
        ? "outro"
        : type === "movie-credits"
          ? "credits"
          : "intro";
  const postCredits =
    (kind === "outro" || kind === "credits") &&
    Boolean(
      safe(() =>
        findFollowingPostCreditsScene(
          interval,
          player.skipIntervals,
          player.getPlaybackDurationSeconds()
        )
      )
    );
  return {
    kind,
    postCredits,
    endMs: Math.round((Number(interval.endTime) || 0) * 1000)
  };
}

function trackLang(entry) {
  return entry.languageKey || entry.language || entry.track?.lang || entry.track?.language || null;
}

function subtitleSource(entry) {
  if (entry.fallbackAddonSubtitle)
    return entry.track?.addonName === "Nuvio Remote" ? "external" : "addon";
  return "embedded";
}

export function readPlaybackState(player) {
  if (!player) return { ...idleState(), error: lastError };
  const audioTracks = (safe(() => player.getAudioEntries(), []) || [])
    .filter((entry) => entry && entry.supported !== false)
    .map((entry) => ({
      id: entry.id,
      label: [entry.label, entry.secondary].filter(Boolean).join(" · "),
      lang: trackLang(entry),
      selected: Boolean(entry.selected)
    }));
  const subtitleTracks = ["builtIn", "addons"]
    .flatMap((tab) => safe(() => player.getSubtitleEntries(tab), []) || [])
    .filter((entry) => entry && !entry.disabled && entry.trackIndex !== -1 && entry.id)
    .map((entry) => ({
      id: entry.id,
      label: entry.label || entry.id,
      lang: trackLang(entry),
      source: subtitleSource(entry),
      selected: Boolean(entry.selected)
    }));
  const status = playerStatus(player);
  return {
    status,
    positionMs: Math.round(safe(() => player.getPlaybackCurrentSeconds(), 0) * 1000),
    durationMs: Math.round(safe(() => player.getPlaybackDurationSeconds(), 0) * 1000),
    at: Date.now(),
    rate: Number(safe(() => player.getPlaybackSpeed(), 1)) || 1,
    media: playerMedia(player),
    audioTracks,
    subtitleTracks,
    subtitleDelayMs: Number(player.subtitleDelayMs) || 0,
    hasNext: Boolean(safe(() => player.resolveNextEpisodeInfo(), null)),
    skip: readSkip(player),
    error: status === "error" ? "Playback failed" : null
  };
}

function sendState(playback) {
  if (send({ type: "state", playback })) {
    lastStateSentAt = Date.now();
    lastSentPlayback = playback;
    lastStateJson = JSON.stringify({ ...playback, at: 0, positionMs: 0 });
  }
}

// A seek on the TV itself (or a stall) moves the position away from what the phone predicts.
function drifted(playback) {
  if (!lastSentPlayback) return true;
  const elapsed =
    lastSentPlayback.status === "playing"
      ? (playback.at - lastSentPlayback.at) * (lastSentPlayback.rate || 1)
      : 0;
  return Math.abs(playback.positionMs - (lastSentPlayback.positionMs + elapsed)) > 2000;
}

function pushStateIfChanged(force = false) {
  if (!isNuvioRemoteConnected()) return;
  const player = currentPlayer();
  // A pending remote play owns the "loading" state until the player route opens.
  if (!player && Date.now() < foregroundGuardUntil && !force) return;
  const playback = readPlaybackState(player);
  // Position moves every tick; the phone interpolates it, so only structural changes and a
  // periodic heartbeat (to correct drift) are sent.
  const key = JSON.stringify({ ...playback, at: 0, positionMs: 0 });
  if (
    force ||
    key !== lastStateJson ||
    drifted(playback) ||
    Date.now() - lastStateSentAt >= STATE_HEARTBEAT_MS
  ) {
    sendState(playback);
  }
}
