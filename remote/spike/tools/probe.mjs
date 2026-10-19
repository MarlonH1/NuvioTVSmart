#!/usr/bin/env node
// PC-side probe for the Nuvio Remote spike. Run from a machine in the same LAN:
//   node remote/spike/tools/probe.mjs            # discover via mDNS + beacon, then connect
//   node remote/spike/tools/probe.mjs 192.168.1.50[:47800]   # skip discovery
//   node remote/spike/tools/probe.mjs --volume up|down|get|mute|unmute  [ip]
// Needs Node 22+ (global WebSocket). No npm dependencies.
import dgram from "node:dgram";

const args = process.argv.slice(2);
const volumeIndex = args.indexOf("--volume");
const volumeAction = volumeIndex >= 0 ? args.splice(volumeIndex, 2)[1] : null;
const manualTarget = args[0];
const SERVICE = "_nuvio-remote._tcp.local";

function encodeName(name) {
  const parts = name.split(".").filter(Boolean);
  const bufs = parts.flatMap((p) => [Buffer.from([Buffer.byteLength(p)]), Buffer.from(p)]);
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function decodeName(buf, offset) {
  const labels = [];
  let end = -1;
  for (let guard = 0; guard < 128; guard++) {
    const len = buf[offset];
    if (len === 0) {
      if (end < 0) end = offset + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = offset + 2;
      offset = ((len & 0x3f) << 8) | buf[offset + 1];
      continue;
    }
    labels.push(buf.toString("utf8", offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  return { name: labels.join("."), end };
}

function parseResponse(msg) {
  const records = [];
  const qd = msg.readUInt16BE(4);
  const total = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = decodeName(msg, off).end + 4;
  for (let i = 0; i < total; i++) {
    const { name, end } = decodeName(msg, off);
    const type = msg.readUInt16BE(end);
    const ttl = msg.readUInt32BE(end + 4);
    const len = msg.readUInt16BE(end + 8);
    const rd = end + 10;
    const rec = { name, type, ttl };
    if (type === 12) rec.ptr = decodeName(msg, rd).name;
    if (type === 33) {
      rec.port = msg.readUInt16BE(rd + 4);
      rec.target = decodeName(msg, rd + 6).name;
    }
    if (type === 1) rec.a = [...msg.subarray(rd, rd + 4)].join(".");
    if (type === 16) {
      rec.txt = [];
      for (let p = rd; p < rd + len;) {
        const l = msg[p];
        rec.txt.push(msg.toString("utf8", p + 1, p + 1 + l));
        p += 1 + l;
      }
    }
    records.push(rec);
    off = rd + len;
  }
  return records;
}

function discover(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];

    // mDNS: one-shot query from an ephemeral port (legacy unicast) AND from 5353.
    const query = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      encodeName(SERVICE),
      Buffer.from([0, 12, 0, 1])
    ]);
    const onMdns = (msg, rinfo) => {
      try {
        if (!(msg.readUInt16BE(2) & 0x8000)) return;
        const recs = parseResponse(msg);
        const srv = recs.find((r) => r.type === 33 && r.name.toLowerCase().endsWith(SERVICE));
        if (!srv) return;
        const a = recs.find((r) => r.type === 1)?.a || rinfo.address;
        const txt = recs.find((r) => r.type === 16)?.txt || [];
        const key = `${a}:${srv.port}`;
        if (!found.has(key)) {
          console.log(
            `mDNS  ✓ ${srv.name} → ${key}  txt=${txt.join(" ")}  (from ${rinfo.address}:${rinfo.port})`
          );
          found.set(key, { host: a, port: srv.port, via: "mdns" });
        }
      } catch {
        /* ignore foreign packets */
      }
    };
    const legacy = dgram.createSocket("udp4");
    legacy.on("message", onMdns);
    legacy.bind(0, () => {
      legacy.send(query, 5353, "224.0.0.251");
      setTimeout(() => legacy.send(query, 5353, "224.0.0.251"), 1500);
    });
    sockets.push(legacy);
    const shared = dgram.createSocket({ type: "udp4", reuseAddr: true });
    shared.on("error", (e) =>
      console.log(`mDNS  (could not bind 5353: ${e.message}; legacy query only)`)
    );
    shared.on("message", onMdns);
    shared.bind(5353, () => {
      try {
        shared.addMembership("224.0.0.251");
      } catch {}
      shared.send(query, 5353, "224.0.0.251");
    });
    sockets.push(shared);

    // Beacon fallback.
    const beacon = dgram.createSocket({ type: "udp4", reuseAddr: true });
    beacon.on("error", (e) => console.log(`beacon (bind failed: ${e.message})`));
    beacon.on("message", (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.svc !== "nuvio-remote") return;
        const key = `${rinfo.address}:${data.port}`;
        if (![...found.values()].some((f) => f.via === "beacon" && `${f.host}:${f.port}` === key)) {
          console.log(`beacon ✓ ${data.name} → ${key}`);
          if (!found.has(key))
            found.set(key, { host: rinfo.address, port: data.port, via: "beacon" });
          else found.set(`${key}#beacon`, { host: rinfo.address, port: data.port, via: "beacon" });
        }
      } catch {}
    });
    beacon.bind(47810);
    sockets.push(beacon);

    setTimeout(() => {
      sockets.forEach((s) => {
        try {
          s.close();
        } catch {}
      });
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

async function connect(host, port) {
  console.log(`\nHTTP  GET http://${host}:${port}/`);
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(4000) });
    const status = await res.json();
    console.log(
      `HTTP  ✓ ${res.status}  mdns=${status.mdns?.mode}  uid=${status.uid}  node=${status.nodeVersion}`
    );
  } catch (e) {
    console.log(`HTTP  ✗ ${e.message}`);
  }

  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${port}/ws`);
    const timer = setTimeout(() => {
      console.log("WS    ✗ timeout");
      ws.close();
      resolve();
    }, 8000);
    ws.onopen = () => {
      console.log("WS    ✓ connected");
      ws.send(JSON.stringify({ v: 1, type: "ping", t: Date.now() }));
      if (volumeAction) ws.send(JSON.stringify({ v: 1, type: "volume", action: volumeAction }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "pong") console.log(`WS    ✓ pong, RTT ${Date.now() - msg.t} ms`);
      else console.log(`WS    ← ${JSON.stringify(msg).slice(0, 600)}`);
      if (msg.type === "pong" && !volumeAction) finish();
      if (msg.type === "volumeResult") finish();
    };
    ws.onerror = (e) => console.log(`WS    ✗ ${e.message || "error"}`);
    function finish() {
      clearTimeout(timer);
      ws.close();
      resolve();
    }
  });
}

if (manualTarget) {
  const [host, port = "47800"] = manualTarget.split(":");
  await connect(host, Number(port));
} else {
  console.log("Discovering for 6 s (mDNS _nuvio-remote._tcp + UDP beacon :47810)…");
  const found = await discover();
  if (!found.length) {
    console.log("\nNothing found. Try: node probe.mjs <tv-ip>");
    process.exit(1);
  }
  const target = found[0];
  await connect(target.host, target.port);
}
