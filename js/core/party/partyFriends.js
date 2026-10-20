// Watch party friends: a device-local friend list and invites delivered through
// ntfy.sh. Each device listens on a topic derived from its own friend code, so
// sharing the code is what lets someone invite you. Nuvio's backend has no
// friends feature, and these requests deliberately carry no Nuvio credentials.
import { LocalStore } from "../storage/localStore.js";
import { isValidPartyCode, normalizePartyCode } from "./partyModels.js";

const STORAGE_KEY = "partyFriends";
const NTFY_BASE_URL = "https://ntfy.sh";
const TOPIC_PREFIX = "nuvio-party-friend-";
export const FRIEND_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const FRIEND_CODE_LENGTH = 12;
const MAX_FRIENDS = 20;
const MAX_NAME_LENGTH = 30;
const MAX_TITLE_LENGTH = 120;
// Invites older than this are stale: party codes are short-lived.
const INVITE_MAX_AGE_SECONDS = 600;
const SEEN_INVITE_LIMIT = 50;
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const SEND_TIMEOUT_MS = 10000;

function readState() {
  const stored = LocalStore.get(STORAGE_KEY, null);
  return {
    code: isValidFriendCode(stored?.code) ? stored.code : "",
    friends: Array.isArray(stored?.friends)
      ? stored.friends.filter((friend) => isValidFriendCode(friend?.code)).slice(0, MAX_FRIENDS)
      : [],
    seen: Array.isArray(stored?.seen) ? stored.seen.slice(-SEEN_INVITE_LIMIT) : []
  };
}

function writeState(state) {
  LocalStore.set(STORAGE_KEY, state);
}

function randomFriendCode() {
  const bytes = new Uint8Array(FRIEND_CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  // 32 symbols divide 256 evenly, so the modulo keeps the code uniform.
  return Array.from(bytes, (byte) => FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length]).join(
    ""
  );
}

function cleanName(value, limit = MAX_NAME_LENGTH) {
  // Drop control characters (C0 range and DEL) from names and titles.
  return Array.from(String(value ?? ""))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, limit);
}

// isValidPartyCode() drops unknown characters (meant for keypad input), so a
// network invite must already be exactly a code apart from letter case.
function strictPartyCode(value) {
  const code = typeof value === "string" ? value.toUpperCase() : "";
  return isValidPartyCode(code) && normalizePartyCode(code) === code ? code : "";
}

function topicFor(code) {
  return `${TOPIC_PREFIX}${code}`;
}

export function normalizeFriendCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .split("")
    .filter((character) => FRIEND_CODE_ALPHABET.includes(character))
    .join("");
}

export function isValidFriendCode(value) {
  return (
    typeof value === "string" &&
    value.length === FRIEND_CODE_LENGTH &&
    normalizeFriendCode(value) === value
  );
}

export function formatFriendCode(code) {
  return String(code || "").replace(/(.{4})(?=.)/g, "$1-");
}

export const PartyFriends = {
  getOwnCode() {
    const state = readState();
    if (!state.code) {
      state.code = randomFriendCode();
      writeState(state);
    }
    return state.code;
  },

  list() {
    return readState().friends;
  },

  findByCode(code) {
    return readState().friends.find((friend) => friend.code === code) || null;
  },

  // Returns an error key, or null when the friend was added or renamed.
  add(rawCode, rawName) {
    const code = normalizeFriendCode(rawCode);
    const name = cleanName(rawName);
    if (!isValidFriendCode(code)) return "invalid_code";
    if (code === this.getOwnCode()) return "own_code";
    if (!name) return "missing_name";
    const state = readState();
    const existing = state.friends.find((friend) => friend.code === code);
    if (existing) existing.name = name;
    else if (state.friends.length >= MAX_FRIENDS) return "too_many";
    else state.friends.push({ code, name });
    writeState(state);
    return null;
  },

  remove(code) {
    const state = readState();
    state.friends = state.friends.filter((friend) => friend.code !== code);
    writeState(state);
  },

  async sendInvite(friend, { partyCode, title, fromName }) {
    if (!isValidFriendCode(friend?.code) || !strictPartyCode(partyCode)) return false;
    const body = JSON.stringify({
      v: 1,
      type: "party-invite",
      party: strictPartyCode(partyCode),
      title: cleanName(title, MAX_TITLE_LENGTH),
      from: { name: cleanName(fromName), code: this.getOwnCode() }
    });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), SEND_TIMEOUT_MS) : null;
    try {
      // A text/plain body keeps this a simple CORS request (no preflight).
      const response = await fetch(`${NTFY_BASE_URL}/${topicFor(friend.code)}`, {
        method: "POST",
        body,
        credentials: "omit",
        signal: controller?.signal
      });
      return response.ok;
    } catch (_) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  // Calls onInvite({ partyCode, title, senderName, senderCode, knownFriend })
  // for each new invite. Returns a stop function.
  listen(onInvite) {
    let socket = null;
    let stopped = false;
    let retryMs = RECONNECT_MIN_MS;
    let retryTimer = null;

    const handle = (raw) => {
      let event;
      let invite;
      try {
        event = JSON.parse(raw);
        if (event?.event !== "message") return;
        invite = JSON.parse(event.message);
      } catch (_) {
        return;
      }
      const partyCode = strictPartyCode(invite?.party);
      if (invite?.type !== "party-invite" || !partyCode) return;
      if (Date.now() / 1000 - Number(event.time || 0) > INVITE_MAX_AGE_SECONDS) return;
      const state = readState();
      if (state.seen.includes(event.id)) return;
      state.seen = [...state.seen, event.id].slice(-SEEN_INVITE_LIMIT);
      writeState(state);
      const senderCode = normalizeFriendCode(invite.from?.code);
      // Prefer the name you saved: the sender chooses the name in the message.
      const friend = state.friends.find((entry) => entry.code === senderCode) || null;
      onInvite({
        partyCode,
        title: cleanName(invite.title, MAX_TITLE_LENGTH),
        senderName: friend ? friend.name : cleanName(invite.from?.name),
        senderCode: isValidFriendCode(senderCode) ? senderCode : "",
        knownFriend: Boolean(friend)
      });
    };

    const connect = () => {
      if (stopped || typeof WebSocket !== "function") return;
      // since= replays invites sent while the app was closed; seen ids dedupe them.
      socket = new WebSocket(
        `${NTFY_BASE_URL.replace(/^http/, "ws")}/${topicFor(this.getOwnCode())}/ws?since=${INVITE_MAX_AGE_SECONDS}s`
      );
      socket.onopen = () => {
        retryMs = RECONNECT_MIN_MS;
      };
      socket.onmessage = (message) => handle(message.data);
      socket.onclose = () => {
        socket = null;
        if (stopped) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(RECONNECT_MAX_MS, retryMs * 2);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }
};
