// Watch party friends: a device-local friend list and invites delivered through
// ntfy.sh. Each device listens on a topic derived from its own friend code, so
// sharing the code is what lets someone invite you. Nuvio's backend has no
// friends feature, and these requests deliberately carry no Nuvio credentials.
// Signed-in accounts keep the code and list in the account's user_metadata
// (ACCOUNT_METADATA_KEY, same format as the Android app), so every device of
// one account shares one code.
// Friendship is mutual: adding a code sends a "friend-hello" request; the friend's
// app adds you back and answers with its active profile name (invites carry the
// name as well). Removing someone sends "friend-remove", which drops you there too.
import { LocalStore } from "../storage/localStore.js";
import { AuthManager } from "../auth/authManager.js";
import { AuthState } from "../auth/authState.js";
import { isValidPartyCode, normalizePartyCode } from "./partyModels.js";

const STORAGE_KEY = "partyFriends";
export const ACCOUNT_METADATA_KEY = "nuvio_friends";
const NTFY_BASE_URL = "https://ntfy.sh";
const TOPIC_PREFIX = "nuvio-party-friend-";
export const FRIEND_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const FRIEND_CODE_LENGTH = 12;
const MAX_FRIENDS = 20;
const MAX_NAME_LENGTH = 30;
const MAX_TITLE_LENGTH = 120;
// Invites older than this are stale: party codes are short-lived.
const INVITE_MAX_AGE_SECONDS = 600;
// ntfy.sh keeps messages about this long, so a name request reaches an offline friend later.
const HELLO_MAX_AGE_SECONDS = 12 * 60 * 60;
const SEEN_INVITE_LIMIT = 200;
const DEFAULT_OWN_NAME = "Nuvio";
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const SEND_TIMEOUT_MS = 10000;

const codeListeners = new Set();
let signedInUserId = null;
let ownNameProvider = async () => "";
let syncChain = Promise.resolve();

function cleanFriends(list, ownCode = "") {
  // Names may be empty: they arrive once the friend's app answers a hello.
  return (Array.isArray(list) ? list : [])
    .filter((friend) => isValidFriendCode(friend?.code) && friend.code !== ownCode)
    .map((friend) => ({ code: friend.code, name: cleanName(friend.name) }))
    .slice(0, MAX_FRIENDS);
}

function readState() {
  const stored = LocalStore.get(STORAGE_KEY, null);
  return {
    code: isValidFriendCode(stored?.code) ? stored.code : "",
    friends: cleanFriends(stored?.friends),
    seen: Array.isArray(stored?.seen) ? stored.seen.slice(-SEEN_INVITE_LIMIT) : [],
    // Account this device last synced with; "" when never synced.
    accountUserId: typeof stored?.accountUserId === "string" ? stored.accountUserId : "",
    // Epoch millis of the last change to code or friends.
    updated: Number(stored?.updated) || 0
  };
}

function writeState(state) {
  const previousCode = readState().code;
  LocalStore.set(STORAGE_KEY, state);
  if (state.code !== previousCode) codeListeners.forEach((listener) => listener(state.code));
}

// Serializes account syncs and uploads so they never interleave.
function queueSync(task) {
  const run = syncChain.then(task, task);
  syncChain = run.catch((error) => console.warn("Friend list sync failed", error));
  return syncChain;
}

function pushState(state) {
  return AuthManager.updateUserMetadata({
    [ACCOUNT_METADATA_KEY]: {
      v: 1,
      code: state.code,
      friends: state.friends,
      updated: state.updated
    }
  });
}

function pushChange() {
  const userId = signedInUserId;
  if (!userId) return;
  void queueSync(async () => {
    const state = readState();
    if (state.accountUserId === userId) await pushState(state);
  });
}

// Mirrors mergeAccountFriends() in the Android app: a device syncing an account
// for the first time keeps its own friends (merged in); afterwards the newer copy
// wins, so removals carry over. Switching accounts drops the old account's list.
export function mergeAccountFriends(local, remote, userId, now, newCode = randomFriendCode) {
  const account = isValidFriendCode(remote?.code)
    ? {
        code: remote.code,
        friends: cleanFriends(remote.friends, remote.code),
        updated: Number(remote.updated) || 0
      }
    : null;
  const linked = { ...local, accountUserId: userId };
  if (local.accountUserId === userId) {
    if (!account) return { state: { ...linked, code: local.code || newCode() }, push: true };
    if (account.updated > local.updated) {
      return { state: { ...linked, ...account }, push: false };
    }
    return {
      state: linked,
      push: account.updated < local.updated || account.code !== local.code
    };
  }
  if (!local.accountUserId) {
    if (!account) {
      return { state: { ...linked, code: local.code || newCode(), updated: now }, push: true };
    }
    const extra = local.friends.filter(
      (friend) =>
        friend.code !== account.code && !account.friends.some((entry) => entry.code === friend.code)
    );
    return {
      state: {
        ...linked,
        code: account.code,
        friends: [...account.friends, ...extra].slice(0, MAX_FRIENDS),
        updated: extra.length ? now : account.updated
      },
      push: extra.length > 0
    };
  }
  if (!account) {
    return { state: { ...linked, code: newCode(), friends: [], updated: now }, push: true };
  }
  return { state: { ...linked, ...account }, push: false };
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

// The friend's own name, or the formatted code until their app has answered.
export function friendDisplayName(friend) {
  return friend?.name || formatFriendCode(friend?.code);
}

async function ownName() {
  const name = cleanName(await Promise.resolve(ownNameProvider()).catch(() => ""));
  return name || DEFAULT_OWN_NAME;
}

async function postToFriend(code, payload) {
  if (!isValidFriendCode(code)) return false;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), SEND_TIMEOUT_MS) : null;
  try {
    // A text/plain body keeps this a simple CORS request (no preflight).
    const response = await fetch(`${NTFY_BASE_URL}/${topicFor(code)}`, {
      method: "POST",
      body: JSON.stringify({ v: 1, ...payload }),
      credentials: "omit",
      signal: controller?.signal
    });
    return response.ok;
  } catch (_) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendHello(code, request) {
  return postToFriend(code, {
    type: "friend-hello",
    request: Boolean(request),
    from: { name: await ownName(), code: PartyFriends.getOwnCode() }
  });
}

// Someone added our code: add them back, so the friendship goes both ways.
function addRequester(code, rawName) {
  const state = readState();
  if (state.friends.some((friend) => friend.code === code)) return;
  if (state.friends.length >= MAX_FRIENDS) return;
  state.friends.push({ code, name: cleanName(rawName) });
  state.updated = Date.now();
  writeState(state);
  pushChange();
}

// The friend removed us: drop them here too (without telling them again).
function removeLocally(code) {
  const state = readState();
  if (!state.friends.some((friend) => friend.code === code)) return false;
  state.friends = state.friends.filter((friend) => friend.code !== code);
  state.updated = Date.now();
  writeState(state);
  pushChange();
  return true;
}

// Stores the name a friend sent about themselves.
function learnName(code, rawName) {
  const name = cleanName(rawName);
  if (!name) return;
  const state = readState();
  const friend = state.friends.find((entry) => entry.code === code);
  if (!friend || friend.name === name) return;
  friend.name = name;
  state.updated = Date.now();
  writeState(state);
  pushChange();
}

export const PartyFriends = {
  getOwnCode() {
    const state = readState();
    if (!state.code) {
      state.code = randomFriendCode();
      state.updated = Date.now();
      writeState(state);
    }
    return state.code;
  },

  // Pulls the account copy and reconciles this device with it. A null userId
  // (signed out or anonymous) keeps later changes on this device only.
  syncWithAccount(userId) {
    signedInUserId = userId || null;
    if (!signedInUserId) return Promise.resolve();
    return queueSync(async () => {
      const user = await AuthManager.getAuthUser();
      if (!user?.id || user.id !== userId) return;
      const merge = mergeAccountFriends(
        readState(),
        user.user_metadata?.[ACCOUNT_METADATA_KEY],
        userId,
        Date.now()
      );
      writeState(merge.state);
      if (merge.push) await pushState(merge.state);
    });
  },

  // Supplies the name friends see (the active profile name, as in watch parties).
  setOwnNameProvider(provider) {
    if (typeof provider === "function") ownNameProvider = provider;
  },

  // Keeps the account copy in step with sign-in state for the app's lifetime.
  installAccountSync() {
    AuthManager.subscribe((state) => {
      if (state === AuthState.AUTHENTICATED) {
        void AuthManager.getAuthUser()
          .then((user) => this.syncWithAccount(user?.id || null))
          .catch((error) => console.warn("Friend list sync failed", error));
      } else if (state === AuthState.SIGNED_OUT) {
        void this.syncWithAccount(null);
      }
    });
  },

  list() {
    return readState().friends;
  },

  findByCode(code) {
    return readState().friends.find((friend) => friend.code === code) || null;
  },

  // Adds a friend by code and asks their app for its name. Returns an error
  // key, or null when the friend is in the list.
  add(rawCode) {
    const code = normalizeFriendCode(rawCode);
    if (!isValidFriendCode(code)) return "invalid_code";
    if (code === this.getOwnCode()) return "own_code";
    const state = readState();
    if (!state.friends.some((friend) => friend.code === code)) {
      if (state.friends.length >= MAX_FRIENDS) return "too_many";
      state.friends.push({ code, name: "" });
      state.updated = Date.now();
      writeState(state);
      pushChange();
    }
    void sendHello(code, true);
    return null;
  },

  // Removes the friend here and asks their app to drop us as well.
  remove(code) {
    if (!removeLocally(code)) return;
    void ownName().then((name) =>
      postToFriend(code, { type: "friend-remove", from: { name, code: this.getOwnCode() } })
    );
  },

  async sendInvite(friend, { partyCode, title, fromName }) {
    if (!isValidFriendCode(friend?.code) || !strictPartyCode(partyCode)) return false;
    return postToFriend(friend.code, {
      type: "party-invite",
      party: strictPartyCode(partyCode),
      title: cleanName(title, MAX_TITLE_LENGTH),
      from: { name: cleanName(fromName) || (await ownName()), code: this.getOwnCode() }
    });
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
      const ageSeconds = Date.now() / 1000 - Number(event.time || 0);
      if (ageSeconds > HELLO_MAX_AGE_SECONDS) return;
      const state = readState();
      if (state.seen.includes(event.id)) return;
      state.seen = [...state.seen, event.id].slice(-SEEN_INVITE_LIMIT);
      writeState(state);
      const code = normalizeFriendCode(invite?.from?.code);
      const senderCode = isValidFriendCode(code) && code !== state.code ? code : "";
      if (senderCode) learnName(senderCode, invite.from?.name);
      if (invite?.type === "friend-hello") {
        if (senderCode && invite.request === true) {
          addRequester(senderCode, invite.from?.name);
          void sendHello(senderCode, false);
        }
        return;
      }
      if (invite?.type === "friend-remove") {
        if (senderCode) removeLocally(senderCode);
        return;
      }
      const partyCode = strictPartyCode(invite?.party);
      if (invite?.type !== "party-invite" || !partyCode) return;
      if (ageSeconds > INVITE_MAX_AGE_SECONDS) return;
      const friend = senderCode ? this.findByCode(senderCode) : null;
      onInvite({
        partyCode,
        title: cleanName(invite.title, MAX_TITLE_LENGTH),
        senderName: friend ? friendDisplayName(friend) : cleanName(invite.from?.name),
        senderCode,
        knownFriend: Boolean(friend)
      });
    };

    const connect = () => {
      if (stopped || typeof WebSocket !== "function") return;
      // Resolve the code first: generating it fires onCodeChange, which must not
      // race with the socket opened below.
      const topic = topicFor(this.getOwnCode());
      if (stopped || socket) return;
      // since= replays invites sent while the app was closed; seen ids dedupe them.
      const ws = new WebSocket(
        `${NTFY_BASE_URL.replace(/^http/, "ws")}/${topic}/ws?since=${HELLO_MAX_AGE_SECONDS}s`
      );
      socket = ws;
      ws.onopen = () => {
        retryMs = RECONNECT_MIN_MS;
      };
      ws.onmessage = (message) => handle(message.data);
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        if (stopped) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(RECONNECT_MAX_MS, retryMs * 2);
      };
      ws.onerror = () => ws.close();
    };

    // An account sync can replace the code: reconnect on the new topic now.
    const onCodeChange = () => {
      if (stopped) return;
      clearTimeout(retryTimer);
      retryMs = RECONNECT_MIN_MS;
      if (socket) {
        const previous = socket;
        socket = null;
        previous.onclose = null;
        previous.close();
      }
      connect();
    };
    codeListeners.add(onCodeChange);

    connect();
    // Ask friends whose name is still unknown (once per app start).
    this.list()
      .filter((friend) => !friend.name)
      .forEach((friend) => void sendHello(friend.code, true));
    return () => {
      stopped = true;
      codeListeners.delete(onCodeChange);
      clearTimeout(retryTimer);
      socket?.close();
    };
  }
};
