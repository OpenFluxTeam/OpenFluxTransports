// PRUFFME whiteboard transport - packets ride notify-position broadcasts (the
// moving cursor) on a shared PRUFFME landing dashboard. A cursor move is
// relayed to the others and never stored, so nothing is left on the board.
// The packet is base64 in position.x; the server relays it as an array,
// data = [sender, session, name, 0, "<base64>", ...]. The sender's own echo
// is skipped (data[0] is its participant hash).
//
// Several boards = several independent relay paths. The url may list more than
// one board (comma / whitespace / '|' separated): each becomes a lane of the
// core's stripe (lanes.open), so N boards carry N times a single board's ~6
// Mbit. One board is one lane - the same wire, no stripe gain. Each board is
// its own Socket.IO session with its own participant, so lane i only hears
// lane i: no cross-delivery between boards. Both ends must list the same
// boards, in the same order.

var PRUFFME_BASE = "pruffme.com";
var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
var SOCKET_PORT_DEFAULT = 443;
var READ_DEADLINE_MS = 90000;
var HANDSHAKE_WAIT_MS = 15000;
var BOOTSTRAP_ATTEMPTS = 6;

// The stripe over the boards: Socket.IO loses nothing while up (no spare
// copies), answers in tens of ms, a lane is dead only after seconds of
// silence. A piece ~ one notify-position's base64 payload.
var STRIPE = {
  pieceBytes: 8192,
  deadAfterMs: 6000,
  noDups: true,
  initRtoMs: 2000,
  minRtoMs: 1000,
  maxRtoMs: 8000,
  noPacing: true,
  ackIntervalMs: 100,
  holeDeadlineMs: 10000,
  laneWindow: true,
};

var running = false;
var lanes_ = [];
var striped = false;

function randHex(n) {
  var s = "";
  for (var i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

function fatal(msg) { var e = new Error(msg); e.fatal = true; return e; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function reconnectBackoff(n) {
  if (n < 1) n = 1;
  var d = Math.min(500 * Math.pow(2, Math.min(n - 1, 4)), 15000);
  return d + Math.floor(Math.random() * (d / 2 + 1));
}

function parseBoards(raw) {
  raw = (raw || "").trim();
  if (!raw) return [];
  return raw.split(/[\s,|]+/).filter(function (x) { return x; });
}

// ---- one board = one lane ----

function Lane(idx, url) {
  this.idx = idx;
  this.url = url;
  this.boardHash = "";
  this.slideHash = "";
  this.participant = null;
  this.participantHash = "";
  this.socketServers = [];
  this.serverIdx = 0;
  this.sessionId = "";
  this.sock = null;
  this.ready = false;
  this.ack = 0;
  this.pendingWaiters = [];
  this.reconnectAttempt = 0;
  this.reconnectTimer = null;
  this.connectGen = 0;
  this.bootGen = 0;
  this.connectedSince = 0;
  this.session = http.newSession(); // its own cookie jar
}

function extractEmbedded(html) {
  var idx = html.indexOf("embedded_media_content");
  if (idx === -1) throw new Error("pruffme: embedded_media_content not found");
  var openIdx = html.indexOf("/*", idx);
  if (openIdx === -1) throw new Error("pruffme: comment open not found");
  var closeIdx = html.indexOf("*/", openIdx + 2);
  if (closeIdx === -1) throw new Error("pruffme: comment close not found");
  return JSON.parse(html.slice(openIdx + 2, closeIdx).trim());
}

function extractSlideHash(board) {
  if (!board || !board.items) return "";
  try {
    var arr = JSON.parse(text.decode(base64.decode(board.items)));
    if (arr && arr.length > 0 && arr[0].hash) return arr[0].hash;
  } catch (e) {}
  return "";
}

Lane.prototype.enginePost = async function (action, content) {
  var body = "action=" + encodeURIComponent(action) +
    "&content=" + encodeURIComponent(base64.encode(text.encode(JSON.stringify(content))));
  var res = await this.session.fetch({
    url: "https://" + PRUFFME_BASE + "/engine/",
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  });
  if (res.status !== 200) throw new Error("pruffme: engine/" + action + " HTTP " + res.status);
  var data;
  try { data = JSON.parse(res.body); } catch (e) { throw new Error("pruffme: engine/" + action + " bad JSON"); }
  if (data && data.error) throw fatal("pruffme: engine/" + action + " error " + JSON.stringify(data.error));
  return data;
};

Lane.prototype.authorize = async function () {
  var res = await this.session.fetch({
    url: this.url,
    method: "GET",
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
  });
  if (res.status === 403 || res.status === 404 || res.status === 410) {
    throw fatal("pruffme: landing page HTTP " + res.status + " (no such board, or it is closed)");
  }
  if (res.status !== 200) throw new Error("pruffme: landing page HTTP " + res.status);
  var board;
  try { board = extractEmbedded(res.body); } catch (e) { throw fatal(String(e.message || e)); }
  if (!board.hash) throw fatal("pruffme: no board hash in landing page");
  this.boardHash = board.hash;
  this.slideHash = extractSlideHash(board);
  if (!this.slideHash) throw fatal("pruffme: no slide hash in board.items");

  var si = await this.enginePost("sockets-info", {});
  if (!si.socket_servers || si.socket_servers.length === 0) throw new Error("pruffme: sockets-info empty");
  this.socketServers = si.socket_servers.map(function (s) { return s.ip + ":" + (s.vport || SOCKET_PORT_DEFAULT); });
  this.serverIdx = Math.floor(Math.random() * this.socketServers.length);

  var lm = await this.enginePost("login-media", { media: this.boardHash, questions: [], utms: {}, devices: {} });
  if (!lm.participant || !lm.participant.hash) throw new Error("pruffme: login-media no participant");
  this.participant = lm.participant;
  this.participantHash = this.participant.hash;
};

Lane.prototype.bootstrap = async function () {
  var myBoot = ++this.bootGen;
  for (var n = 1; ; n++) {
    try {
      await this.authorize();
      return running && myBoot === this.bootGen;
    } catch (e) {
      if (!running || myBoot !== this.bootGen) return false;
      if ((e && e.fatal) || n >= BOOTSTRAP_ATTEMPTS) { giveUp(e); return false; }
      setState("reconnecting", String(e));
      await sleep(reconnectBackoff(n));
      if (!running || myBoot !== this.bootGen) return false;
    }
  }
};

Lane.prototype.writeEventObj = function (ns, obj) {
  var id = this.ack++;
  this.sock.send("42" + id + JSON.stringify([ns, obj]));
  return id;
};

Lane.prototype.sendSubscribe = function () {
  this.sessionId = randHex(32);
  return this.writeEventObj("dashboard", {
    action: "subscribe-slide-dashboard",
    data: {
      session: this.sessionId, dashboard: this.slideHash, presentation: this.boardHash,
      properties: {}, participant: this.participantHash, participant_team_role: -1,
      options: { type: "landing", participant: this.participant, intermediate: randHex(32) },
    },
  });
};

Lane.prototype.sendPiece = function (bytes) {
  this.writeEventObj("dashboard", {
    action: "notify-position",
    data: { position: { x: base64.encode(bytes), y: 123.0 }, vpt: { translate: { x: 0, y: 0 }, scale: 1, whyrugay: 1 } },
    participant: this.participantHash,
  });
};

Lane.prototype.deliver = function (b64) {
  if (typeof b64 !== "string" || b64 === "") return;
  var bytes;
  try { bytes = base64.decode(b64); } catch (e) { return; } // a real cursor, not ours
  if (!bytes || bytes.byteLength === 0) return;
  if (striped) lanes.deliver(this.idx, bytes);
  else emit(bytes);
};

Lane.prototype.handleNotifyPosition = function (data, envelopePart) {
  if (Array.isArray(data)) {
    if (data.length < 5 || data[0] === this.participantHash) return;
    this.deliver(data[4]);
    return;
  }
  if (data && data.position) {
    if (envelopePart && envelopePart === this.participantHash) return;
    this.deliver(data.position.x);
  }
};

Lane.prototype.handleMessage = function (msg) {
  if (msg === "2") { try { this.sock.send("3"); } catch (e) {} return; }
  if (msg === "3") return;
  if (msg.indexOf("42[") !== 0) return;
  var arr;
  try { arr = JSON.parse(msg.slice(2)); } catch (e) { return; }
  if (!arr || arr.length < 2 || arr[0] !== "dashboard" || !arr[1]) return;
  if (arr[1].action === "notify-position") this.handleNotifyPosition(arr[1].data, arr[1].participant);
};

Lane.prototype.waitRaw = function () {
  var l = this;
  return new Promise(function (resolve) { l.pendingWaiters.push({ pred: function () { return true; }, resolve: resolve }); });
};

Lane.prototype.waitFor = function (pred, timeoutMs) {
  var l = this;
  return new Promise(function (resolve) {
    var waiter = { pred: pred, done: false };
    var timer = setTimeout(function () {
      if (waiter.done) return;
      waiter.done = true;
      var i = l.pendingWaiters.indexOf(waiter);
      if (i >= 0) l.pendingWaiters.splice(i, 1);
      resolve(false);
    }, timeoutMs);
    waiter.resolve = function () { if (waiter.done) return; waiter.done = true; clearTimeout(timer); resolve(true); };
    l.pendingWaiters.push(waiter);
  });
};

Lane.prototype.dispatch = function (msg) {
  for (var i = 0; i < this.pendingWaiters.length; i++) {
    if (this.pendingWaiters[i].pred(msg)) {
      var w = this.pendingWaiters.splice(i, 1)[0];
      w.resolve();
      return true;
    }
  }
  return false;
};

Lane.prototype.handshake = async function () {
  await this.waitRaw(); // engine.io open
  this.sock.send("40");
  await this.waitRaw(); // socket.io connect ack
  this.writeEventObj("im", { operation: "subscribe", user: null });
  var self = this;
  var subscribed = await this.waitFor(function (m) { return m.indexOf('"subscribed"') !== -1; }, 10000);
  if (!subscribed) throw new Error("pruffme: wait 'subscribed' timed out");
  var subAck = this.sendSubscribe();
  var prefix = "43" + subAck + "[";
  var got = await this.waitFor(function (m) { return m.indexOf(prefix) === 0; }, HANDSHAKE_WAIT_MS);
  if (!got) throw new Error("pruffme: wait subscribe ack timed out");
};

Lane.prototype.closeSocket = function () {
  this.ready = false;
  if (striped) lanes.state(this.idx, false);
  var s = this.sock;
  this.sock = null;
  if (s) try { s.close(); } catch (e) {}
};

Lane.prototype.scheduleNextConnect = function () {
  if (!running || this.reconnectTimer) return;
  var l = this;
  var d = reconnectBackoff(this.reconnectAttempt);
  this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 10);
  this.reconnectTimer = setTimeout(function () { l.reconnectTimer = null; if (running) l.connectOnce(); }, d);
};

Lane.prototype.connectOnce = function () {
  var myGen = ++this.connectGen;
  var l = this;
  this.connectAndServe(myGen).then(null, function (e) {
    if (myGen !== l.connectGen) return;
    l.closeSocket();
    if (e && e.fatal) { giveUp(e); return; }
    setState("reconnecting", String(e));
    l.scheduleNextConnect();
  });
};

Lane.prototype.connectAndServe = async function (myGen) {
  this.ack = 0;
  this.pendingWaiters = [];
  this.ready = false;
  var host = this.socketServers[this.serverIdx % this.socketServers.length];
  this.serverIdx++;
  var l = this;
  var newSock = await ws.open("wss://" + host + "/socket.io/?EIO=4&transport=websocket",
    { "User-Agent": UA, "Origin": "https://" + PRUFFME_BASE }, { readTimeoutMs: READ_DEADLINE_MS });
  if (myGen !== this.connectGen || !running) { try { newSock.close(); } catch (e) {} return; }
  this.sock = newSock;
  newSock.onmessage = function (m) {
    if (m === "2") { try { newSock.send("3"); } catch (e) {} return; }
    if (l.dispatch(m)) return;
    l.handleMessage(m);
  };
  newSock.onclose = function () { if (l.sock === newSock) l.onSocketClose(); };
  await this.handshake();
  if (myGen !== this.connectGen || !running) return;
  this.ready = true;
  this.connectedSince = Date.now();
  this.reconnectAttempt = 0;
  if (striped) { lanes.state(this.idx, true); this.pump(); }
  updateState();
};

Lane.prototype.onSocketClose = function () {
  this.sock = null;
  this.ready = false;
  if (striped) lanes.state(this.idx, false);
  if (this.connectedSince && Date.now() - this.connectedSince > 60000) this.reconnectAttempt = 0;
  this.connectedSince = 0;
  if (!running) return;
  updateState();
  this.scheduleNextConnect();
};

// pump drains the stripe for this lane, fire-and-forget (Socket.IO is ordered
// and reliable while up, so no per-piece ack wait - that would cap the rate).
Lane.prototype.pump = function () {
  if (!striped || !this.ready || !this.sock) return;
  var pieces = lanes.pull(this.idx, 64);
  while (pieces.length) {
    for (var i = 0; i < pieces.length; i++) {
      try { this.sendPiece(new Uint8Array(pieces[i])); } catch (e) { return; }
    }
    if (pieces.length < 64) break;
    pieces = lanes.pull(this.idx, 64);
  }
};

function giveUp(e) {
  running = false;
  for (var i = 0; i < lanes_.length; i++) {
    lanes_[i].connectGen++;
    if (lanes_[i].reconnectTimer) { clearTimeout(lanes_[i].reconnectTimer); lanes_[i].reconnectTimer = null; }
    lanes_[i].closeSocket();
  }
  setState("dead", String(e));
}

function updateState() {
  for (var i = 0; i < lanes_.length; i++) if (lanes_[i].ready) { setState("connected"); return; }
  if (running) setState("reconnecting");
}

async function startLanes(urls) {
  lanes_ = urls.map(function (u, i) { return new Lane(i, u); });
  striped = urls.length >= 2;
  var oks = await Promise.all(lanes_.map(function (l) { return l.bootstrap(); }));
  if (!running) return;
  if (oks.indexOf(true) === -1) { if (running) setState("dead", "pruffme: no board could be opened"); return; }
  if (striped) lanes.open(lanes_.length, STRIPE);
  console.log("[PRUFFME] " + lanes_.length + " board(s), striped=" + striped);
  for (var i = 0; i < lanes_.length; i++) if (oks[i]) lanes_[i].connectOnce();
}

var Transport = {
  info: function () {
    return {
      name: "pruffme",
      version: "1.1.0",
      cookieDomain: "",
      mtu: 0, reliable: false, ordered: false,
      params: [
        { key: "url", label: "PRUFFME whiteboard URL", type: "url", required: true,
          description: "The board must have \"anyone with the link can edit\" on." },
        { key: "boards", label: "More boards for speed (space-separated, including this one)", type: "textarea", required: false, scope: "settings",
          description: "List several landing boards to run them as parallel lanes - N boards carry N times one board's speed." },
      ],
    };
  },

  open: function (cfg) {
    var p = cfg.params || {};
    // Boards come in the "boards" param (space/comma separated). The url field
    // holds one board; a comma-list there would be caught by the core as a
    // group (unsupported for scripts), so several boards ride "boards".
    var urls = parseBoards(p.boards || p.url || cfg.url || "");
    if (!urls.length) { setState("dead", "pruffme: no board URL provided"); return; }
    running = true;
    setState("connecting");
    startLanes(urls);
  },

  write: function (bytes) {
    // Single board: straight to its lane (no stripe). Several: the core's
    // Send went to the stripe, and the lanes pull from it - write() is not
    // called in that case.
    if (striped) return;
    var l = lanes_[0];
    if (!l || !l.ready) throw new Error("pruffme: not connected");
    l.sendPiece(new Uint8Array(bytes));
  },

  laneWake: function (i) { if (lanes_[i]) lanes_[i].pump(); },

  // The stripe's own out-of-band frames (acks) ride a notify-position too.
  laneSend: function (i, data) { var l = lanes_[i]; if (l && l.ready) try { l.sendPiece(new Uint8Array(data)); } catch (e) {} },

  close: function () {
    running = false;
    for (var i = 0; i < lanes_.length; i++) {
      if (lanes_[i].reconnectTimer) clearTimeout(lanes_[i].reconnectTimer);
      lanes_[i].closeSocket();
    }
    lanes_ = [];
  },
};
