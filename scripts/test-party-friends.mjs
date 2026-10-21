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

const {
  PartyFriends,
  formatFriendCode,
  isValidFriendCode,
  mergeAccountFriends,
  normalizeFriendCode,
  friendDisplayName
} = await import("../js/core/party/partyFriends.js");

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
PartyFriends.setOwnNameProvider(async () => "Marlon\u0007");
assert.equal(PartyFriends.add("abcd-2345-efgh"), null);
assert.deepEqual(
  PartyFriends.list(),
  [{ code: friendCode, name: "" }],
  "no name until they answer"
);
assert.equal(friendDisplayName(PartyFriends.list()[0]), "ABCD-2345-EFGH");
await new Promise((resolve) => setTimeout(resolve, 0));
const hello = JSON.parse(sent.at(-1).options.body);
assert.equal(sent.at(-1).url, `https://ntfy.sh/nuvio-party-friend-${friendCode}`);
assert.deepEqual(
  { type: hello.type, request: hello.request, from: hello.from },
  { type: "friend-hello", request: true, from: { name: "Marlon", code: own } },
  "adding asks the friend for their name"
);
assert.equal(PartyFriends.add(friendCode), null, "re-adding is a no-op");
assert.equal(PartyFriends.list().length, 1);
assert.equal(PartyFriends.add("SHORT"), "invalid_code");
assert.equal(PartyFriends.add(own), "own_code");
await new Promise((resolve) => setTimeout(resolve, 0));

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
assert.equal(socket.url, `wss://ntfy.sh/nuvio-party-friend-${own}/ws?since=43200s`);
const now = Math.floor(Date.now() / 1000);
const deliver = (id, invite, time = now) =>
  socket.onmessage({
    data: JSON.stringify({ event: "message", id, time, message: JSON.stringify(invite) })
  });

await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  JSON.parse(sent.at(-1).options.body).request,
  true,
  "listening asks unnamed friends for their name"
);
const sentBeforeHello = sent.length;
deliver("h1", { type: "friend-hello", request: true, from: { name: "Sam", code: friendCode } });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(PartyFriends.list()[0].name, "Sam", "a hello names the friend");
assert.equal(received.length, 0, "hellos are not invites");
const reply = JSON.parse(sent.at(-1).options.body);
assert.equal(sent.length, sentBeforeHello + 1);
assert.deepEqual(
  { type: reply.type, request: reply.request, to: sent.at(-1).url },
  { type: "friend-hello", request: false, to: `https://ntfy.sh/nuvio-party-friend-${friendCode}` },
  "a hello request is answered with our name"
);
deliver("h2", { type: "friend-hello", request: false, from: { name: "Sam", code: friendCode } });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(sent.length, sentBeforeHello + 1, "answers are not answered again");
deliver("h3", { type: "friend-hello", request: true, from: { name: "Me", code: own } });
assert.equal(sent.length, sentBeforeHello + 1, "our own hellos are ignored");

const newcomer = "RRRRSSSSTTTT";
deliver("h4", { type: "friend-hello", request: true, from: { name: "Kim", code: newcomer } });
assert.deepEqual(
  PartyFriends.findByCode(newcomer),
  { code: newcomer, name: "Kim" },
  "whoever adds us is added back"
);
deliver("h5", {
  type: "friend-hello",
  request: false,
  from: { name: "Lee", code: "UUUUVVVVWWWW" }
});
assert.equal(PartyFriends.findByCode("UUUUVVVVWWWW"), null, "plain answers add nobody");
deliver("r1", { type: "friend-remove", from: { name: "Kim", code: newcomer } });
assert.equal(PartyFriends.findByCode(newcomer), null, "a removal drops them here too");
await new Promise((resolve) => setTimeout(resolve, 0));

deliver("1", {
  type: "party-invite",
  party: "abc234",
  title: "Frieren",
  from: { name: "Sammy", code: friendCode }
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
  "invites carry the friend's current name"
);
assert.equal(PartyFriends.list()[0].name, "Sammy");

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
await new Promise((resolve) => setTimeout(resolve, 0));
const removal = JSON.parse(sent.at(-1).options.body);
assert.deepEqual(
  { type: removal.type, to: sent.at(-1).url },
  { type: "friend-remove", to: `https://ntfy.sh/nuvio-party-friend-${friendCode}` },
  "removing tells the friend"
);

console.log("Party friends: all checks passed.");

// Account sync: same cases as PartyFriendsSyncTest in the Android app.
{
  const localCode = "AAAABBBBCCCC";
  const accountCode = "DDDDEEEEFFFF";
  const alice = { code: "GGGGHHHHJJJJ", name: "Alice" };
  const bob = { code: "KKKKLLLLMMMM", name: "Bob" };
  const fresh = "NNNNPPPPQQQQ";
  const base = { code: "", friends: [], seen: [], accountUserId: "", updated: 0 };
  const merge = (local, remote) =>
    mergeAccountFriends({ ...base, ...local }, remote, "u1", 500, () => fresh);

  let result = merge({ code: localCode, friends: [alice] }, null);
  assert.equal(result.push, true, "first sync uploads to an empty account");
  assert.equal(result.state.code, localCode);
  assert.equal(result.state.accountUserId, "u1");

  result = merge(
    { code: localCode, friends: [alice, bob] },
    { code: accountCode, friends: [alice], updated: 100 }
  );
  assert.equal(result.state.code, accountCode, "first sync adopts the account code");
  assert.deepEqual(result.state.friends, [alice, bob], "and keeps local friends");
  assert.equal(result.push, true);

  result = merge(
    { code: accountCode, friends: [alice, bob], accountUserId: "u1", updated: 100 },
    { code: accountCode, friends: [alice], updated: 200 }
  );
  assert.deepEqual(result.state.friends, [alice], "newer account copy wins, removals carry over");
  assert.equal(result.push, false);

  result = merge(
    { code: accountCode, friends: [alice, bob], accountUserId: "u1", updated: 300 },
    { code: accountCode, friends: [alice], updated: 200 }
  );
  assert.deepEqual(result.state.friends, [alice, bob], "newer local changes are kept");
  assert.equal(result.push, true);

  result = merge({ code: localCode, friends: [alice], accountUserId: "other", updated: 300 }, null);
  assert.equal(result.state.code, fresh, "switching accounts starts a new code");
  assert.deepEqual(result.state.friends, []);

  result = merge(
    {},
    {
      code: accountCode,
      friends: [{ code: accountCode, name: "Me" }, { code: "bad", name: "X" }, alice],
      updated: 1
    }
  );
  assert.deepEqual(result.state.friends, [alice], "own and invalid codes are dropped");
}

console.log("party friends account sync ok");
