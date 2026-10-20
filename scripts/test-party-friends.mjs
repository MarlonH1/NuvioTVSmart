import assert from "node:assert/strict";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};

const sent = [];
globalThis.fetch = async (url, options) => {
  sent.push({ url, options });
  return { ok: true };
};

const sockets = [];
globalThis.WebSocket = class {
  constructor(url) {
    this.url = url;
    sockets.push(this);
  }
  close() {}
};

const { PartyFriends, formatFriendCode, isValidFriendCode, normalizeFriendCode } =
  await import("../js/core/party/partyFriends.js");

const own = PartyFriends.getOwnCode();
assert.ok(isValidFriendCode(own), "own code is valid");
assert.equal(PartyFriends.getOwnCode(), own, "own code is stable");
assert.match(formatFriendCode(own), /^.{4}-.{4}-.{4}$/);
assert.equal(
  normalizeFriendCode(formatFriendCode(own).toLowerCase()),
  own,
  "dashes and case are ignored"
);

const friendCode = "ABCD2345EFGH";
assert.equal(PartyFriends.add("abcd-2345-efgh", "  Sam  "), null);
assert.deepEqual(PartyFriends.list(), [{ code: friendCode, name: "Sam" }]);
assert.equal(PartyFriends.add(friendCode, "Sammy"), null, "re-adding renames");
assert.equal(PartyFriends.list().length, 1);
assert.equal(PartyFriends.add("SHORT", "X"), "invalid_code");
assert.equal(PartyFriends.add(own, "Me"), "own_code");
assert.equal(PartyFriends.add("ZZZZ2345EFGH", "   "), "missing_name");

assert.equal(
  await PartyFriends.sendInvite(PartyFriends.list()[0], {
    partyCode: "bad",
    title: "x",
    fromName: "Me"
  }),
  false
);
assert.equal(
  await PartyFriends.sendInvite(PartyFriends.list()[0], {
    partyCode: "ABC234",
    title: "Frieren",
    fromName: "Me"
  }),
  true
);
const request = sent.at(-1);
assert.equal(request.url, `https://ntfy.sh/nuvio-party-friend-${friendCode}`);
assert.equal(request.options.credentials, "omit");
assert.equal(request.options.headers, undefined, "no auth or custom headers are sent");
const payload = JSON.parse(request.options.body);
assert.deepEqual(
  { type: payload.type, party: payload.party, title: payload.title, from: payload.from },
  { type: "party-invite", party: "ABC234", title: "Frieren", from: { name: "Me", code: own } }
);

const received = [];
const stop = PartyFriends.listen((invite) => received.push(invite));
const socket = sockets.at(-1);
assert.equal(socket.url, `wss://ntfy.sh/nuvio-party-friend-${own}/ws?since=600s`);
const now = Math.floor(Date.now() / 1000);
const deliver = (id, invite, time = now) =>
  socket.onmessage({
    data: JSON.stringify({ event: "message", id, time, message: JSON.stringify(invite) })
  });

deliver("1", {
  type: "party-invite",
  party: "abc234",
  title: "Frieren",
  from: { name: "Imposter", code: friendCode }
});
assert.deepEqual(
  received.at(-1),
  {
    partyCode: "ABC234",
    title: "Frieren",
    senderName: "Sammy",
    senderCode: friendCode,
    knownFriend: true
  },
  "known senders show the saved name, not the claimed one"
);

deliver("1", { type: "party-invite", party: "ABC234", from: { name: "Dup", code: friendCode } });
assert.equal(received.length, 1, "duplicate ids are ignored");
deliver("2", { type: "party-invite", party: "ABC234", from: { name: "Old" } }, now - 3600);
assert.equal(received.length, 1, "stale invites are ignored");
deliver("3", { type: "party-invite", party: "not a code" });
socket.onmessage({ data: "{not json" });
socket.onmessage({ data: JSON.stringify({ event: "keepalive", id: "4" }) });
assert.equal(received.length, 1, "malformed and non-invite events are ignored");
deliver("5", {
  type: "party-invite",
  party: "XYZ789",
  title: "Movie",
  from: { name: "Stranger\u0007", code: "nope" }
});
assert.deepEqual(received.at(-1), {
  partyCode: "XYZ789",
  title: "Movie",
  senderName: "Stranger",
  senderCode: "",
  knownFriend: false
});
stop();

PartyFriends.remove(friendCode);
assert.deepEqual(PartyFriends.list(), []);

console.log("Party friends: all checks passed.");
