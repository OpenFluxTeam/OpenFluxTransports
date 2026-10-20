// Avito Code (code.avito.ru): packets ride ShareDB text ops in shared code rooms.
// Port of transport/avito (avito.go, stripe.go, register.go, dialgate.go) as of
// core 0.14.5.
//
// Rooms come in pairs: the room list packs the exit's tx rooms first, then its
// rx rooms; the exit writes into the first half and reads the second, the
// client the other way round. A room takes one op at a time (the next one waits
// for the ack) and answers it in a few hundred ms whatever its size, so an op
// carries up to CHUNK_BYTES.
//
//   * striped wire (list v2, every exit since 0.7.1): pair i is lane i of the
//     core's stripe; an op is a run of pieces [len u32][piece]..., base64 in
//     one text insert (replacing the previous one).
//   * old wire (list v1): one packet per op, round-robin over the tx rooms.
//
// Avito limits an address to 10 WebSocket handshakes a minute and keeps the
// limit up for a client that keeps retrying, so every handshake and room
// creation goes through a gate: a budget (a burst of 4, then one per 12 s) and,
// after a 429, a pause for every room that doubles from 30 s to 30 min. The
// gate's state is shared with the other OpenFlux processes on this host
// (shared.read/write), as the native transport shares it through a file.
//
// A room made by the REST call is unknown to the realtime side until it has
// been joined once over Socket.IO, as the web client does (joinRooms).
//
// Unlike the native transport (a socket per room), one ShareDB connection
// carries all the rooms of a side: Avito limits handshakes, not documents, so
// a side comes up after one handshake instead of sixteen (minutes, at 10 a
// minute). The wire is the same.

var BASE_URL = "https://code.avito.ru";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0";
var SHAREDB_TYPE = "http://sharejs.org/types/textv1";
var JOIN_NAME = "OpenFlux";

var NUM_ROOMS = 8; // room PAIRS = stripe lanes
var CHUNK_BYTES = 256 * 1024;
var ROOM_CREATE_PAUSE_MS = 300;
var WS_READ_TIMEOUT_MS = 90000;
var RECONNECT_MIN_MS = 100;
var RECONNECT_MAX_MS = 10000;
var RECONNECT_MULTIPLIER = 1.3;
var ACK_TIMEOUT_MS = 30000;
var LANE_POLL_IDLE_MS = 50;

var STRIPE = {
  pieceBytes: 32 * 1024,
  deadAfterMs: 5000,
  noDups: true,
  initRtoMs: 3000,
  minRtoMs: 2000,
  maxRtoMs: 10000,
};

var running = false;
var isClient = true;
var striped = false;
var cookies = "";
var tx = [], rx = [];
var rr = 0;

// ---- the gate (dialgate.go) ----

var DIAL_SPACING_MS = 250;
var HOLD_FIRST_MS = 30000;
var HOLD_MAX_MS = 30 * 60000;
var HOLD_JITTER = 0.2;
var RETRY_AFTER_MAX_MS = 10 * 60000;
var CALM_AFTER_MS = 2 * 60000;
var BURST = 4;
var REFILL_MS = 12000;

function Gate(key, noBudget) {
  this.key = key;
  this.noBudget = noBudget;
  this.next = 0;
  this.hold = 0;
  this.backoff = 0;
  this.last429 = 0;
  this.tat = 0;
  this.chain = Promise.resolve();
}

Gate.prototype.adopt = function () {
  var raw = shared.read(this.key);
  var f = raw.trim().split(/\s+/).map(Number);
  if (f.length < 3 || f.some(isNaN)) return;
  if (f[0] > this.hold) this.hold = f[0];
  if (f[1] > this.backoff) this.backoff = f[1];
  if (f[2] > this.last429) this.last429 = f[2];
  if (f.length > 3 && f[3] > this.tat) this.tat = f[3];
};

Gate.prototype.persist = function () {
  shared.write(this.key, this.hold + " " + this.backoff + " " + this.last429 + " " + this.tat + "\n");
};

// wait resolves when this dial may start (false once the transport stops).
// The rooms of this process queue in order (the transport asks lane by lane,
// so the first lanes come up first), and a turn is taken from the budget only
// when its dial really starts: a room that waits reserves nothing, so a process
// that dies while its rooms wait leaves no debt behind for the next one. (The
// native gate reserves ahead; a client restarted a few times found the budget
// spent minutes into the future by processes that no longer existed.)
Gate.prototype.wait = function () {
  var g = this;
  var turn = this.chain.then(function () { return g.take(); });
  this.chain = turn.catch(function () {});
  return turn;
};

Gate.prototype.take = async function () {
  for (;;) {
    if (!running) return false;
    this.adopt();
    var now = Date.now();
    // What other processes reserved ahead counts, but not without end: a
    // reservation more than two bursts away is a dead process's.
    if (this.tat > now + 2 * BURST * REFILL_MS) this.tat = now + 2 * BURST * REFILL_MS;
    var at = Math.max(now, this.next, this.hold);
    if (!this.noBudget) at = Math.max(at, this.tat - (BURST - 1) * REFILL_MS);
    if (at <= now) {
      if (!this.noBudget) this.tat = Math.max(this.tat, now) + REFILL_MS;
      this.next = now + DIAL_SPACING_MS;
      this.persist();
      return true;
    }
    await sleep(Math.min(at - now, 2000)); // then look again: another process, a 429
  }
};

Gate.prototype.limited = function (retryMs) {
  var now = Date.now();
  if (now < this.hold) return; // another room already set this pause
  this.backoff = this.backoff ? Math.min(this.backoff * 2, HOLD_MAX_MS) : HOLD_FIRST_MS;
  var d = Math.max(this.backoff, retryMs || 0);
  d += Math.floor(d * HOLD_JITTER * Math.random());
  this.hold = now + d;
  this.last429 = now;
  if (!this.noBudget) this.tat = Math.max(this.tat, this.hold + (BURST - 1) * REFILL_MS);
  this.persist();
  console.log("[AVITO] Avito ограничивает подключения (429): пауза " + Math.round(d / 1000) + "s");
};

Gate.prototype.ok = function () {
  if (Date.now() - this.last429 >= CALM_AFTER_MS && this.backoff) {
    this.backoff = 0;
    this.persist();
  }
};

var dialGate = new Gate("gate", false);
var roomGate = new Gate("gate-rooms", true);

function retryAfterMs(v) {
  if (!v) return 0;
  var n = parseInt(v, 10);
  var ms = isNaN(n) ? Date.parse(v) - Date.now() : n * 1000;
  if (isNaN(ms)) return 0;
  return Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS);
}

// limitedBy reads a dial error for a 429/503 and the Retry-After it carried.
function limitedBy(err) {
  var m = /http (429|503)(?:, retry-after ([^)]*))?/.exec(String((err && err.message) || err));
  return m ? { retry: retryAfterMs(m[2]) } : null;
}

// ---- room list ----

function b64urlDecode(s) {
  var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return base64.decode(b64);
}

function b64urlEncode(bytes) {
  return base64.encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function packRooms(ids, isStriped) {
  return b64urlEncode(text.encode(JSON.stringify(isStriped ? { v: 2, rooms: ids } : ids)));
}

function unpackRooms(s) {
  var v = JSON.parse(text.decode(b64urlDecode(s)));
  if (Array.isArray(v)) return { ids: v, striped: false };
  if (v && v.v === 2 && Array.isArray(v.rooms) && v.rooms.length) return { ids: v.rooms, striped: true };
  throw new Error("room list: unknown format");
}

function parseRooms(raw) {
  raw = (raw || "").trim();
  if (!raw) return { ids: [], striped: false };
  var m = /[?&]rooms=([^&#]+)/.exec(raw);
  try { return unpackRooms(m ? decodeURIComponent(m[1]) : raw); } catch (e) {}
  return { ids: [], striped: false };
}

// ---- REST: create a room; Socket.IO: join it once ----

async function createRoom() {
  if (!(await roomGate.wait())) throw new Error("stopped");
  var res = await http.fetch({
    url: BASE_URL + "/web/1/code/room",
    method: "POST",
    headers: { "User-Agent": UA, Origin: BASE_URL, Cookie: cookies },
    body: "",
  });
  if (res.status === 429 || res.status === 503) roomGate.limited(retryAfterMs(res.headers["Retry-After"]));
  if (res.status !== 200) throw new Error("POST room status " + res.status + ": " + String(res.body).slice(0, 200));
  var id = ((JSON.parse(res.body) || {}).room || {}).id;
  if (!id) throw new Error("empty room id");
  return id;
}

// joinRooms enters rooms the way Avito's web client does (Socket.IO join,
// answered by "initialize"): a room made by the REST call alone is unknown to
// the realtime side ("room is not found in MongoDB") until it has been joined
// once. All of them over one connection: a handshake each would spend the
// address's budget on nothing.
async function joinRooms(ids) {
  if (!ids.length) return [];
  if (!(await dialGate.wait())) throw new Error("stopped");
  var sock;
  try {
    sock = await ws.open(BASE_URL.replace("https://", "wss://") + "/socket.io/?EIO=4&transport=websocket",
      { "User-Agent": UA, Origin: BASE_URL, Cookie: cookies }, { compress: true, readTimeoutMs: 20000 });
  } catch (e) {
    var lim = limitedBy(e);
    if (lim) dialGate.limited(lim.retry);
    throw new Error("join: " + ((e && e.message) || e));
  }
  dialGate.ok();
  var joined = [];
  try {
    var lines = [], waiting = null, closed = false;
    sock.onmessage = function (s) {
      if (s === "2") { try { sock.send("3"); } catch (e) {} return; }
      lines.push(s);
      if (waiting) waiting();
    };
    sock.onclose = function () { closed = true; if (waiting) waiting(); };
    var read = async function (prefix, ms) {
      var deadline = Date.now() + ms;
      while (Date.now() < deadline && !closed) {
        while (lines.length) {
          var s = lines.shift();
          if (s.indexOf(prefix) === 0) return s;
          if (s.indexOf('42["join-error"') === 0) throw new Error("join refused: " + s.slice(0, 120));
        }
        await new Promise(function (resolve) { waiting = resolve; setTimeout(resolve, 300); });
        waiting = null;
      }
      throw new Error("no " + prefix + " from Avito");
    };
    await read("0{", 10000);
    sock.send("40");
    await read("40", 10000);
    for (var i = 0; i < ids.length && running; i++) {
      try {
        sock.send("42" + JSON.stringify(["join", { name: JOIN_NAME, roomId: ids[i] }]));
        await read('42["initialize"', 10000);
        joined.push(ids[i]);
      } catch (e) {
        console.log("[AVITO] join room (" + ids[i].slice(0, 8) + "): " + ((e && e.message) || e));
        if (closed || /RATE_LIMITED/.test(String(e && e.message))) break;
      }
    }
  } finally {
    try { sock.close(); } catch (e) {}
  }
  return joined;
}

// ---- rooms (ShareDB documents) ----

function Room(idx, id, isTx) {
  this.idx = idx;
  this.id = id;
  this.isTx = isTx;
  this.up = false; // subscribed on the live connection
  this.ver = 0;
  this.docLen = 0;
  this.needJoin = false;
  this.ack = null; // the op in flight waits for its reply
  this.busy = false;
  this.queue = []; // old wire: packets waiting for their op
  this.pumpTimer = null;
}

// ---- one ShareDB connection carries every room of this side ----
//
// The native transport opens a socket per room; ShareDB serves any number of
// documents on one connection, and Avito's limit is on handshakes, so one
// socket brings all the rooms up after a single handshake (a reconnect too).
// The wire - documents, ops, versions - is the same.

var conn = null; // { sock, id (src), seq, pending: {key: resolve} }

function roomByID(id) {
  for (var i = 0; i < tx.length; i++) if (tx[i].id === id) return tx[i];
  for (i = 0; i < rx.length; i++) if (rx[i].id === id) return rx[i];
  return null;
}

function connSend(v) {
  if (!conn) throw new Error("ws not connected");
  try {
    conn.sock.send(JSON.stringify(v));
  } catch (e) {
    try { conn.sock.close(); } catch (e2) {}
    throw e;
  }
}

// request sends v and resolves with the reply matched by key (a=s replies by
// doc id, op acks by seq).
function request(v, key, ms) {
  return new Promise(function (resolve, reject) {
    var c = conn;
    if (!c) { reject(new Error("ws not connected")); return; }
    var t = setTimeout(function () { delete c.pending[key]; reject(new Error("no reply in " + ms + " ms")); }, ms);
    c.pending[key] = function (msg) { clearTimeout(t); delete c.pending[key]; resolve(msg); };
    try { connSend(v); } catch (e) { clearTimeout(t); delete c.pending[key]; reject(e); }
  });
}

function onMessage(c, raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.a === "init" && c.init) { c.init(msg); return; }
  if (msg.a === "op" && msg.src && msg.src !== c.id) {
    var r = roomByID(msg.d);
    if (r) peerOp(r, msg);
    return;
  }
  var key = msg.a === "op" ? "op:" + msg.seq : msg.a + ":" + msg.d;
  if (c.pending[key]) c.pending[key](msg);
}

function peerOp(r, msg) {
  var ops = msg.op;
  if (Array.isArray(ops)) {
    for (var i = 0; i < ops.length; i++) {
      if (typeof ops[i] !== "string" || !ops[i].length) continue;
      var decoded;
      try { decoded = new Uint8Array(base64.decode(ops[i])); } catch (e) { continue; }
      if (striped) splitFramed(r.idx, decoded);
      else emit(decoded.buffer);
    }
  }
  if (typeof msg.v === "number" && msg.v + 1 > r.ver) r.ver = msg.v + 1;
}

function splitFramed(lane, blob) {
  var off = 0;
  while (blob.length - off >= 4) {
    var n = ((blob[off] << 24) >>> 0) + (blob[off + 1] << 16) + (blob[off + 2] << 8) + blob[off + 3];
    if (n <= 0 || n > blob.length - off - 4) return; // not ours, or cut short: the stripe resends
    lanes.deliver(lane, blob.slice(off + 4, off + 4 + n).buffer);
    off += 4 + n;
  }
}

// subscribe brings one room up on the connection, creating its document the
// first time.
async function subscribe(r) {
  var sub = await request({ a: "s", c: "docs", d: r.id, v: null }, "s:" + r.id, 20000);
  if (sub.error) throw new Error("subscribe: " + JSON.stringify(sub.error));
  var doc = sub.data || sub;
  r.ver = typeof doc.v === "number" ? doc.v : 0;
  r.docLen = typeof doc.data === "string" ? doc.data.length : 0;
  if (doc.type == null) {
    var seq = ++conn.seq;
    var reply = await request({ a: "op", c: "docs", d: r.id, v: 0, src: conn.id, seq: seq,
      create: { type: SHAREDB_TYPE, data: "" } }, "op:" + seq, 20000);
    if (reply.error) {
      if (reply.error.code === "ERR_ROOM_NOT_FOUND") r.needJoin = true;
      throw new Error("create: " + JSON.stringify(reply.error));
    }
    r.ver = 1;
    r.docLen = 0;
  }
  r.up = true;
  laneState(r.idx);
  updateState();
  r.pump();
}

async function bringUp(rooms) {
  var failed = [];
  // one at a time: lane by lane, the first lanes first
  for (var i = 0; i < rooms.length && conn; i++) {
    try {
      await subscribe(rooms[i]);
    } catch (e) {
      console.log("[AVITO] room " + rooms[i].id.slice(0, 8) + ": " + ((e && e.message) || e));
      failed.push(rooms[i]);
    }
  }
  return failed;
}

// connectAndServe: one socket, every room subscribed on it; the rooms the
// realtime side does not know yet are joined (one Socket.IO connection for all
// of them) and subscribed again.
async function connectAndServe(order) {
  if (!(await dialGate.wait())) throw new Error("stopped");
  var sock;
  try {
    sock = await ws.open(BASE_URL.replace("https://", "wss://") + "/sharedb",
      { "User-Agent": UA, Origin: BASE_URL, Cookie: cookies }, { readTimeoutMs: WS_READ_TIMEOUT_MS });
  } catch (e) {
    var lim = limitedBy(e);
    if (lim) dialGate.limited(lim.retry);
    throw e;
  }
  dialGate.ok();
  var c = { sock: sock, id: "", seq: 0, pending: {}, init: null };
  var closed = new Promise(function (resolve) { sock.onclose = function (reason) { resolve(reason); }; });
  var gotInit = new Promise(function (resolve) { c.init = function (m) { c.init = null; resolve(m); }; });
  sock.onmessage = function (raw) { onMessage(c, raw); };
  var init = await Promise.race([gotInit, closed.then(function (r) { throw new Error("closed: " + r); }),
    sleep(15000).then(function () { throw new Error("no init"); })]);
  c.id = init.id || "";
  conn = c;
  console.log("[AVITO] connected, " + order.length + " rooms to bring up");
  var work = (async function () {
    var failed = await bringUp(order);
    var unknown = failed.filter(function (r) { return r.needJoin; });
    if (unknown.length && conn === c) {
      var joined = await joinRooms(unknown.map(function (r) { return r.id; }));
      console.log("[AVITO] joined " + joined.length + " of " + unknown.length + " new rooms");
      unknown.forEach(function (r) { r.needJoin = false; });
      var again = unknown.filter(function (r) { return joined.indexOf(r.id) >= 0; });
      failed = failed.filter(function (r) { return again.indexOf(r) < 0; }).concat(await bringUp(again));
    }
    // what still failed is retried every 30 s while the socket lives
    while (failed.length && conn === c && running) {
      await sleep(30000);
      if (conn !== c) break;
      failed = await bringUp(failed);
    }
  })();
  work.catch(function () {});
  var reason = await closed;
  conn = null;
  tx.concat(rx).forEach(function (r) {
    r.up = false;
    r.busy = false;
    if (r.ack) r.ack({ error: "socket closed" });
    if (r.pumpTimer) { clearTimeout(r.pumpTimer); r.pumpTimer = null; }
    laneState(r.idx);
  });
  updateState();
  throw new Error("closed: " + reason);
}

async function runConn(order) {
  var delay = RECONNECT_MIN_MS;
  while (running) {
    var up = Date.now();
    try {
      await connectAndServe(order);
    } catch (e) {
      if (!running) return;
      console.log("[AVITO] ws: " + ((e && e.message) || e));
    }
    if (Date.now() - up > 30000) delay = RECONNECT_MIN_MS;
    await sleep(delay);
    delay = Math.min(delay * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);
  }
}

// sendOp replaces the room's text with data and waits for the ack.
Room.prototype.sendOp = function (data) {
  var r = this;
  var encoded = base64.encode(data);
  var op = this.docLen > 0 ? [{ d: this.docLen }, encoded] : [encoded];
  var seq = ++conn.seq;
  return new Promise(function (resolve, reject) {
    r.ack = function (reply) {
      r.ack = null;
      if (reply.error) { reject(new Error("op error: " + JSON.stringify(reply.error))); return; }
      r.ver = typeof reply.v === "number" ? reply.v + 1 : r.ver + 1;
      r.docLen = encoded.length;
      resolve();
    };
    request({ a: "op", c: "docs", d: r.id, v: r.ver, src: conn.id, seq: seq, op: op }, "op:" + seq, ACK_TIMEOUT_MS)
      .then(function (reply) { if (r.ack) r.ack(reply); }, function (e) { if (r.ack) r.ack({ error: String(e && e.message || e) }); });
  });
};

// pump sends the next op when the room is free: pieces from the stripe up to
// CHUNK_BYTES (striped), or the next queued packet (old wire).
Room.prototype.pump = function () {
  if (!this.isTx || !this.up || this.busy || !conn) return;
  var blob;
  if (striped) {
    var parts = [], size = 0;
    while (size < CHUNK_BYTES) {
      var pieces = lanes.pull(this.idx, 1);
      if (!pieces.length) break;
      for (var i = 0; i < pieces.length; i++) {
        var p = new Uint8Array(pieces[i]);
        parts.push(p);
        size += 4 + p.length;
      }
    }
    if (!parts.length) {
      this.idle();
      return;
    }
    blob = new Uint8Array(size);
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      var n = parts[i].length;
      blob[off] = (n >>> 24) & 255; blob[off + 1] = (n >>> 16) & 255; blob[off + 2] = (n >>> 8) & 255; blob[off + 3] = n & 255;
      blob.set(parts[i], off + 4);
      off += 4 + n;
    }
  } else {
    if (!this.queue.length) return;
    blob = this.queue.shift();
  }
  var r = this;
  this.busy = true;
  this.sendOp(blob).then(function () {
    r.busy = false;
    r.pump();
  }, function (e) {
    r.busy = false;
    console.log("[AVITO] op (" + r.id.slice(0, 8) + "): " + ((e && e.message) || e));
    // a version out of step: subscribe again for the document's own
    if (conn && /op error/.test(String(e && e.message))) {
      r.up = false;
      laneState(r.idx);
      subscribe(r).catch(function () {});
    }
  });
};

Room.prototype.idle = function () {
  if (this.pumpTimer) return;
  var r = this;
  this.pumpTimer = setTimeout(function () { r.pumpTimer = null; r.pump(); }, LANE_POLL_IDLE_MS);
};

Room.prototype.wake = function () {
  if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
  this.pump();
};

// ---- transport ----

function laneState(i) {
  if (striped && tx[i] && i < lanes.count()) lanes.state(i, tx[i].up);
}

function updateState() {
  var all = tx.concat(rx);
  for (var i = 0; i < all.length; i++) if (all[i].up) { setState("connected"); return; }
  if (running) setState("reconnecting");
}

async function enterRooms(ids) {
  if (ids.length) return ids;
  if (isClient) throw new Error("avito client: url must contain the room list");
  var out = [];
  for (var i = 0; i < NUM_ROOMS * 2; i++) {
    var id = "", lastErr = null;
    for (var attempt = 0; attempt < 5 && running; attempt++) {
      try { id = await createRoom(); break; } catch (e) {
        lastErr = e;
        await sleep(Math.min(ROOM_CREATE_PAUSE_MS * Math.pow(2, attempt), 15000));
      }
    }
    if (!running) throw new Error("stopped");
    if (!id) { console.log("[AVITO] room " + (i + 1) + " skipped: " + ((lastErr && lastErr.message) || lastErr)); continue; }
    out.push(id);
    if (i < NUM_ROOMS * 2 - 1) await sleep(ROOM_CREATE_PAUSE_MS);
  }
  if (!out.length) throw new Error("could not create any room");
  // An exit joins its new rooms right away, so neither side waits on it later.
  try {
    var joined = await joinRooms(out);
    console.log("[AVITO] joined " + joined.length + " of " + out.length + " new rooms");
  } catch (e) {
    console.log("[AVITO] join new rooms: " + ((e && e.message) || e));
  }
  return out;
}

async function start(ids) {
  try {
    var all = await enterRooms(ids);
    if (!running) return;
    raise("roomList", { rooms: packRooms(all, striped) });
    var half = Math.max(1, Math.floor(all.length / 2));
    var txIDs = isClient ? all.slice(half) : all.slice(0, half);
    var rxIDs = isClient ? all.slice(0, half) : all.slice(half);
    tx = txIDs.map(function (id, i) { return new Room(i, id, true); });
    rx = rxIDs.map(function (id, i) { return new Room(i, id, false); });
    if (striped) lanes.open(Math.min(tx.length, rx.length), STRIPE);
    console.log("[AVITO] " + tx.length + " tx + " + rx.length + " rx rooms, striped=" + striped);
    // lane by lane: a lane works once its tx and rx rooms are up on both sides
    var order = [];
    for (var i = 0; i < Math.max(tx.length, rx.length); i++) {
      if (tx[i]) order.push(tx[i]);
      if (rx[i]) order.push(rx[i]);
    }
    runConn(order);
  } catch (e) {
    setState("dead", String((e && e.message) || e));
  }
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

var Transport = {
  info: function () {
    return {
      name: "avito",
      version: "1.0.0",
      mtu: 0,
      reliable: false,
      ordered: false,
      params: [
        { key: "url", label: "Packed room list from the exit; empty on an exit creates new rooms", type: "text", required: false },
        { key: "cookies", label: "code.avito.ru cookies (optional)", type: "secret", required: false },
      ],
    };
  },

  open: function (cfg) {
    var p = cfg.params || {};
    var list = parseRooms(p.url || cfg.url || "");
    isClient = !(p.exit === true || p.exit === "true");
    cookies = String(p.cookies || "");
    striped = list.ids.length ? list.striped : true;
    running = true;
    setState("connecting");
    start(list.ids);
  },

  write: function (bytes) {
    for (var i = 0; i < tx.length; i++) {
      var r = tx[(rr + i) % tx.length];
      if (r.up) {
        rr = (rr + i + 1) % tx.length;
        if (r.queue.length >= 256) throw new Error("avito: room queue full");
        r.queue.push(new Uint8Array(bytes));
        r.pump();
        return;
      }
    }
    throw new Error("avito: no room connected");
  },

  laneWake: function (i) {
    if (tx[i]) tx[i].wake();
  },

  // a puller lane never gets the stripe's frames out of turn
  laneSend: function (i) {
    if (tx[i]) tx[i].wake();
  },

  close: function () {
    running = false;
    tx.concat(rx).forEach(function (r) { if (r.pumpTimer) clearTimeout(r.pumpTimer); });
    if (conn) { try { conn.sock.close(); } catch (e) {} }
  },
};
