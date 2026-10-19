// MAX P2P DataChannel transport via TURN relay.
//
// 2026-10-18 PROVEN: P2P DC works through MAX TURN (155.212.x:19302,
// whitelisted on RU carriers). SFU is media-only — no SCTP/DC, and
// transmit-data does NOT forward between peers. Signaling goes through
// MSG_SEND (opcode 64) with emoji-encrypted SDP.
//
// Flow: login → call → TURN creds → SDP via MSG_SEND → P2P DC.
// Params: token, uid (callee userId), chatId, exit (receiver role).

var maxclient = require("../../lib/maxclient.js");
var SETUP_HTML = require("./setup_html.js");

var running = false;
var client = null;
var role = "caller";
var calleeID = 0;
var chatID = 0;
var maxToken = "";

var callConn = null;
var callSeq = 1;
var localID = 0;
var remoteID = 0;
var reconnectAttempt = 0;

var pc = null;
var dc = null;
var pendingCandidates = [];
var haveRemoteDesc = false;
var turnCreds = null;

// ── Emoji SDP cipher ──
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
var EMOJI = "\u{1F300}\u{1F301}\u{1F302}\u{1F303}\u{1F304}\u{1F305}\u{1F306}\u{1F307}\u{1F308}\u{1F309}\u{1F30A}\u{1F30B}\u{1F30C}\u{1F30D}\u{1F30E}\u{1F30F}\u{1F310}\u{1F311}\u{1F312}\u{1F313}\u{1F314}\u{1F315}\u{1F316}\u{1F317}\u{1F318}\u{1F319}\u{1F31A}\u{1F31B}\u{1F31C}\u{1F31D}\u{1F31E}\u{1F31F}\u{1F320}\u{1F321}\u{1F322}\u{1F323}\u{1F324}\u{1F325}\u{1F326}\u{1F327}\u{1F328}\u{1F329}\u{1F32A}\u{1F32B}\u{1F32C}\u{1F32D}\u{1F32E}\u{1F32F}\u{1F330}\u{1F331}\u{1F332}\u{1F333}\u{1F334}\u{1F335}\u{1F336}\u{1F337}\u{1F338}\u{1F339}\u{1F33A}\u{1F33B}\u{1F33C}\u{1F33D}\u{1F33E}\u{1F33F}\u{1F340}";
var EMOJI_LIST = [];
for (var ci = 0; ci < EMOJI.length; ci++) {
  var cp = EMOJI.codePointAt(ci);
  EMOJI_LIST.push(String.fromCodePoint(cp));
  if (cp > 0xFFFF) ci++;
}
var C2E = {}, E2C = {};
for (var bi = 0; bi < B64.length; bi++) {
  C2E[B64[bi]] = EMOJI_LIST[bi];
  E2C[EMOJI_LIST[bi]] = B64[bi];
}
var SDP_PREFIX = "\u{1F511}"; // 🔑

function sdpKey() {
  return crypto.sha256(text.encode("max-ofx-sdp-key-2026"));
}

function xorBytes(data, key) {
  var keyBuf = new Uint8Array(key);
  var dataBuf = new Uint8Array(data);
  var out = new Uint8Array(dataBuf.length);
  for (var xi = 0; xi < dataBuf.length; xi++) {
    out[xi] = dataBuf[xi] ^ keyBuf[xi % keyBuf.length];
  }
  return out.buffer;
}

function encodeSDP(sdpType, sdp) {
  var json = JSON.stringify({ t: sdpType, s: sdp });
  var compressed = gzip.compress(text.encode(json));
  var encrypted = xorBytes(compressed, sdpKey());
  var b64str = base64.encode(encrypted);
  var out = SDP_PREFIX;
  for (var ei = 0; ei < b64str.length; ei++) {
    out += C2E[b64str[ei]] || b64str[ei];
  }
  return out;
}

function decodeSDP(emojiText) {
  if (emojiText.indexOf(SDP_PREFIX) === 0) {
    emojiText = emojiText.substring(SDP_PREFIX.length);
  }
  var b64str = "";
  for (var di = 0; di < emojiText.length; di++) {
    var ch = emojiText.codePointAt(di);
    var sym = String.fromCodePoint(ch);
    b64str += E2C[sym] || sym;
    if (ch > 0xFFFF) di++;
  }
  var encrypted = base64.decode(b64str);
  var compressed = xorBytes(encrypted, sdpKey());
  var json = text.decode(gzip.decompress(compressed));
  var obj = JSON.parse(json);
  return { type: obj.t, sdp: obj.s };
}


// ── Setup wizard backend ──

var wizardServer = null;

// startWizard serves the setup page and asks the app to show it. values are what is known: with the
// node's user id (values.uid) the wizard only signs this side in (a second client of an existing
// node); without, it signs both accounts in and hands back {client, node}.
function startWizard(values) {
  if (wizardServer) return;
  var init = { nodeUid: String((values && values.uid) || "") };
  var page = SETUP_HTML.replace(
    '<script id="init" type="application/json">{}</script>',
    '<script id="init" type="application/json">' + JSON.stringify(init).replace(/</g, "\\u003c") + "</script>"
  );
  wizardServer = httpserver.listen(function (req) {
    if (req.path === "/" || req.path === "") {
      return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: page };
    }
    if (req.path === "/api/verify" && req.method === "POST") {
      return verifyToken(req);
    }
    if (req.path === "/api/chat" && req.method === "POST") {
      return verifyChat(req);
    }
    return { status: 404, body: "not found" };
  });

  raise("needsSetup", {
    url: "http://" + wizardServer.addr + "/",
    reason: init.nodeUid ? "Вход в MAX" : "Подключение через MAX",
  });
}

function jsonResponse(obj) {
  return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// accountOf reads who a LOGIN reply is about. The web client takes payload.profile.contact
// (id, phone, names[0].firstName / lastName); hintUid is the id the sign-in window saw.
function accountOf(payload, hintUid) {
  var p = payload || {};
  var profile = p.profile || {};
  var contact = profile.contact || p.contact || {};
  var n0 = (contact.names && contact.names[0]) || {};
  var name = ((n0.firstName || contact.firstName || n0.name || "") + " " + (n0.lastName || contact.lastName || "")).trim();
  var phone = contact.phone ? String(contact.phone) : "";
  if (phone && phone.charAt(0) !== "+") phone = "+" + phone;
  return {
    uid: contact.id || profile.id || hintUid || 0,
    name: name,
    phone: phone,
    // Key names only, no values: what to look at when a field comes back empty.
    shape: Object.keys(p).join(",") + " | profile: " + Object.keys(profile).join(",") + " | contact: " + Object.keys(contact).join(","),
  };
}

function verifyToken(req) {
  var body;
  try { body = JSON.parse(text.decode(req.body)); } catch (e) {
    return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "bad json" }) };
  }
  var token = body.token || "";
  if (!token) return jsonResponse({ ok: false, error: "пустой токен" });

  return maxclient.connect().then(function (c) {
    return maxclient.loginByToken(c, token).then(function (resp) {
      var a = accountOf(resp.payload, parseInt(body.viewerId, 10) || 0);
      try { c.sock.close(); } catch (e) {}
      return jsonResponse({ ok: true, uid: a.uid, name: a.name, phone: a.phone, shape: a.shape });
    });
  }).catch(function (e) {
    return jsonResponse({ ok: false, error: String(e) });
  });
}

// xorIds: a private chat's id is the two user ids XORed. The 32-bit ^ would cut the high bits off.
function xorIds(a, b) {
  var M = 4294967296;
  var hi = (Math.floor(a / M) ^ Math.floor(b / M)) >>> 0;
  var lo = ((a % M) ^ (b % M)) >>> 0;
  return hi * M + lo;
}

// dialogCandidates lists the chat ids a message to nodeUid may go to, best first: a dialog the
// LOGIN reply already lists with that user in it, the XOR id, the bare user id.
function dialogCandidates(chats, clientUid, nodeUid) {
  var out = [];
  function add(id) { if (id && out.indexOf(id) === -1) out.push(id); }
  for (var i = 0; i < chats.length; i++) {
    var c = chats[i] || {};
    var parts = c.participants || {};
    var ids = c.memberIds || [];
    if (c.type === "DIALOG" && (parts[nodeUid] !== undefined || ids.indexOf(nodeUid) !== -1)) add(c.id);
  }
  if (clientUid && nodeUid) add(xorIds(clientUid, nodeUid));
  add(nodeUid);
  return out;
}

// acceptedChat is the chat check without the other account's token (a second client of an existing
// node): the first chat id the server takes a message for. Whether it arrives cannot be seen from here.
function acceptedChat(c, cands) {
  var tried = [];
  function attempt(i) {
    if (i >= cands.length) {
      return Promise.resolve({ ok: false, error: "MAX не принял сообщение ни в один чат (" + tried.join("; ") + ")" });
    }
    var cid = Math.floor(Math.random() * 9007199254740991) + 1;
    return c.invoke(64, { chatId: cands[i], message: { text: "ofx_" + Date.now(), cid: cid } }).then(function (r) {
      if ((r || {}).cmd === 3) {
        tried.push(cands[i] + ": " + (((r.payload || {}).message) || ((r.payload || {}).error) || "ошибка"));
        return attempt(i + 1);
      }
      return { ok: true, chatId: (r.payload || {}).chatId || cands[i], unconfirmed: true };
    });
  }
  return attempt(0);
}

function verifyChat(req) {
  var body;
  try { body = JSON.parse(text.decode(req.body)); } catch (e) {
    return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "bad json" }) };
  }

  var clientTok = body.clientToken;
  var nodeTok = body.nodeToken;
  var clientUid = parseInt(body.clientUid, 10) || 0;
  var nodeUid = parseInt(body.nodeUid, 10) || 0;
  var cA = null, cB = null;
  function closeBoth() {
    try { if (cA) cA.sock.close(); } catch (e) {}
    try { if (cB) cB.sock.close(); } catch (e) {}
  }

  return maxclient.connect().then(function (a) {
    cA = a;
    return maxclient.loginByToken(cA, clientTok);
  }).then(function (respA) {
    var cands = dialogCandidates((respA.payload || {}).chats || [], clientUid, nodeUid);
    if (!nodeTok) return acceptedChat(cA, cands);
    return maxclient.connect().then(function (b) {
      cB = b;
      return maxclient.loginByToken(cB, nodeTok);
    }).then(function () {
      var msgRx = false;
      var testText = "ofx_" + Date.now();
      cB.setOnEvent(function (pkt) {
        if (pkt.opcode === 128) {
          var msg = (pkt.payload || {}).message || {};
          if (msg.text === testText) msgRx = true;
        }
      });

      // The first id the server takes a message for is the chat.
      var tried = [];
      function attempt(i) {
        if (i >= cands.length) {
          return Promise.resolve({ ok: false, error: "MSG_SEND не принят ни для одного чата (" + tried.join("; ") + ")" });
        }
        var cid = Math.floor(Math.random() * 9007199254740991) + 1;
        return cA.invoke(64, { chatId: cands[i], message: { text: testText, cid: cid } }).then(function (r) {
          if ((r || {}).cmd === 3) {
            tried.push(cands[i] + ": " + (((r.payload || {}).message) || ((r.payload || {}).error) || "ошибка"));
            return attempt(i + 1);
          }
          var serverChatId = (r.payload || {}).chatId || cands[i];
          return new Promise(function (resolve) {
            var checks = 0;
            var timer = setInterval(function () {
              checks++;
              if (msgRx || checks > 20) {
                clearInterval(timer);
                resolve(msgRx ? { ok: true, chatId: serverChatId } : { ok: false, error: "сообщение не доставлено за 10 секунд" });
              }
            }, 500);
          });
        });
      }
      return attempt(0);
    });
  }).then(function (res) {
    closeBoth();
    return jsonResponse(res);
  }).catch(function (e) {
    closeBoth();
    return jsonResponse({ ok: false, error: String(e) });
  });
}


// ── Call + DC state ──

function resetCallState() {
  callSeq = 1;
  localID = 0;
  remoteID = 0;
  callConn = null;
  haveRemoteDesc = false;
  pendingCandidates = [];
  turnCreds = null;
  if (pc) { try { pc.close(); } catch (e) {} }
  pc = null;
  dc = null;
}

function sendCallJSON(obj) {
  if (!callConn) return;
  obj.sequence = callSeq;
  obj.participantId = localID;
  obj.participantType = "USER";
  callSeq++;
  try {
    callConn.send(JSON.stringify(obj));
  } catch (e) {
    setState("degraded", String(e));
  }
}

function sendAcceptCall() {
  sendCallJSON({
    command: "accept-call",
    mediaSettings: {
      isAudioEnabled: true, isVideoEnabled: false, isScreenSharingEnabled: false,
      isFastScreenSharingEnabled: false, isAudioSharingEnabled: false, isAnimojiEnabled: false,
    },
  });
}

function createP2PPeerConnection() {
  if (!turnCreds) {
    setState("degraded", "no TURN credentials");
    return;
  }
  var iceServers = [];
  if (turnCreds.turn && turnCreds.turn.urls && turnCreds.turn.urls.length) {
    iceServers.push({
      urls: turnCreds.turn.urls,
      username: turnCreds.turn.username,
      credential: turnCreds.turn.credential,
    });
  }
  pc = webrtc.newPeerConnection({
    iceServers: iceServers,
    iceTransportPolicy: "relay",
  });

  pc.onicecandidate = function () {};
  pc.onconnectionstatechange = function (s) {
    if (s === "connected") {
      setState("connected");
      reconnectAttempt = 0;
    } else if (s === "failed" || s === "closed") {
      setState("reconnecting", "peerconnection " + s);
    }
  };
  pc.ondatachannel = function (remoteDC) {
    dc = remoteDC;
    dc.onmessage = function (bytes) { emit(bytes); };
  };

  dc = pc.createDataChannel("x", { ordered: true, maxRetransmits: 0 });
  dc.onmessage = function (bytes) { emit(bytes); };
}

function findLocalID(data, wantCreator) {
  if (localID !== 0) return;
  var conv = data.conversation;
  if (!conv || !conv.participants) return;
  for (var i = 0; i < conv.participants.length; i++) {
    var p = conv.participants[i];
    var isCreator = (p.roles || []).indexOf("CREATOR") !== -1;
    if (isCreator === wantCreator) localID = p.id;
  }
}

// ── MSG_SEND signaling (replaces transmit-data) ──

function sendSDPviaMsg(sdpType, sdp) {
  var emoji = encodeSDP(sdpType, sdp);
  var cid = Math.floor(Math.random() * 9007199254740991) + 1;
  client.invoke(64, { chatId: chatID, message: { text: emoji, cid: cid } }).catch(function (e) {
    setState("degraded", "sdp send: " + String(e));
  });
}

function handleSDPPush(packet) {
  if (packet.opcode !== 128) return;
  var msg = (packet.payload || {}).message || {};
  var txt = msg.text || "";
  if (txt.indexOf(SDP_PREFIX) !== 0) return;

  var parsed;
  try { parsed = decodeSDP(txt); } catch (e) { return; }

  if (!pc) return;
  if (parsed.type === "offer") {
    pc.setRemoteDescription("offer", parsed.sdp).then(function () {
      haveRemoteDesc = true;
      return pc.createAnswer().then(function (answer) {
        return pc.setLocalDescription("answer", answer).then(function () {
          sendSDPviaMsg("answer", answer);
        });
      });
    }).catch(function (e) { setState("degraded", "sdp answer: " + String(e)); });
  } else if (parsed.type === "answer") {
    pc.setRemoteDescription("answer", parsed.sdp).then(function () {
      haveRemoteDesc = true;
    }).catch(function (e) { setState("degraded", "sdp set: " + String(e)); });
  }
}

// ── Call signaling socket handling ──

function handleCallMessage(text_, wantCreator) {
  var data;
  try { data = JSON.parse(text_); } catch (e) { return; }
  findLocalID(data, wantCreator);
  if (typeof data.participantId === "number") remoteID = data.participantId;

  if (data.conversationParams) {
    turnCreds = data.conversationParams;
    createP2PPeerConnection();

    if (role === "caller") {
      pc.createOffer().then(function (offer) {
        return pc.setLocalDescription("offer", offer).then(function () {
          sendSDPviaMsg("offer", offer);
        });
      }).catch(function (e) { setState("degraded", "p2p offer: " + String(e)); });
    }
    return;
  }
}

function onCallSocketMessage(msg, wantCreator) {
  var t = typeof msg === "string" ? msg : text.decode(msg);
  if (t === "ping") {
    try { callConn.send("pong"); } catch (e) {}
    return;
  }
  if (t.length < 10) return;
  handleCallMessage(t, wantCreator);
}

function onCallSocketClose() {
  callConn = null;
  if (!running) return;
  if (role !== "caller") return;
  setState("reconnecting");
  reconnectAttempt++;
  if (reconnectAttempt > 10) reconnectAttempt = 10;
  setTimeout(function () { if (running) connectCallerLoop(); }, reconnectAttempt * 1000);
}

function connectCallerLoop() {
  if (!running) return;
  resetCallState();

  client.invoke(78, {
    conversationId: maxclient.genUUID(),
    calleeIds: [calleeID],
    internalParams: JSON.stringify({
      deviceId: client.deviceId, sdkVersion: "2.8.9", clientAppKey: "CNHIJPLGDIHBABABA",
      platform: "WEB", protocolVersion: 5, domainId: "", capabilities: "2A03F",
    }),
    isVideo: false,
  }).then(function (resp) {
    var payload = resp.payload || {};
    var params = JSON.parse(payload.internalCallerParams || "{}");
    var endpoint = params.endpoint + "&platform=WEB&appVersion=1.1&version=5&device=browser&capabilities=2A03F&clientType=ONE_ME&tgt=start";
    return ws.open(endpoint, {}, { readTimeoutMs: 0 });
  }).then(function (sock) {
    callConn = sock;
    sock.onmessage = function (msg) { onCallSocketMessage(msg, false); };
    sock.onclose = onCallSocketClose;
  }).catch(function (e) {
    setState("reconnecting", String(e));
    onCallSocketClose();
  });
}

function onIncomingCallEvent(packet) {
  if (packet.opcode === 137) {
    var payload = packet.payload || {};
    var callDetails;
    try {
      callDetails = maxclient.decodeCallDetails(payload.vcp || "");
    } catch (e) {
      return;
    }
    var endpoint = maxclient.craftEndpoint(payload.conversationId, callDetails);
    resetCallState();
    ws.open(endpoint, {}, { readTimeoutMs: 0 }).then(function (sock) {
      callConn = sock;
      sock.onmessage = function (msg) { onCallSocketMessage(msg, true); };
      sock.onclose = onCallSocketClose;
      setTimeout(function () { sendAcceptCall(); }, 1000);
    }).catch(function () {});
    return;
  }
  handleSDPPush(packet);
}

function onCallerEvent(packet) {
  handleSDPPush(packet);
}


// ── Transport interface ──

// readParams takes the settings the carrier was given (the core adds exit itself: it is the node).
function readParams(p) {
  maxToken = p.token || "";
  calleeID = parseInt(p.uid, 10) || 0;
  chatID = parseInt(p.chatId, 10) || 0;
  role = (p.exit === true || p.exit === "true") ? "receiver" : "caller";
}

// begin signs in with the token and runs the role: the node waits for the call, the client makes it.
function begin() {
  maxclient.connect().then(function (c) {
    client = c;
    return maxclient.loginByToken(client, maxToken);
  }).then(function () {
    maxclient.startKeepalive(client);
    if (role === "receiver") {
      client.setOnEvent(onIncomingCallEvent);
    } else {
      client.setOnEvent(onCallerEvent);
      connectCallerLoop();
    }
  }).catch(function (e) {
    setState("dead", String(e));
  });
}

// stopCall drops what a running call holds, for a restart with other settings.
function stopCall() {
  if (pc) { try { pc.close(); } catch (e) {} }
  if (callConn) { try { callConn.close(); } catch (e) {} }
  if (client && client.sock) { try { client.sock.close(); } catch (e) {} }
  pc = null;
  callConn = null;
  client = null;
}

var tokenFromParams = false;

var Transport = {
  info: function () {
    return {
      name: "oneme-webrtc",
      version: "3.3.2",
      // What a setup page hands over lands in the cookie jar of this address (cookiesApplied).
      cookieDomain: "https://web.max.ru/",
      mtu: 0,
      reliable: false,
      ordered: false,
      // All of them are settings, none is the profile's one input: a profile's value field would otherwise be
      // taken for the token, and wiped when the wizard filled the setting instead. Which end this is the core
      // says itself (cfg.params.exit), so it is no setting.
      params: [
        { key: "token", label: "MAX web token", type: "secret", required: true, scope: "settings" },
        { key: "uid", label: "Callee userId", type: "text", required: false, scope: "settings" },
        { key: "chatId", label: "Chat ID for signaling", type: "text", required: false, scope: "settings" },
      ],
    };
  },

  // setup is the wizard an app runs while a node is being made (before anything connects): it
  // signs the accounts in and hands back {client: {...}, node: {...}} through openfluxSubmit.
  setup: function (values) {
    startWizard(values || {});
  },

  open: function (cfg) {
    readParams((cfg && cfg.params) || {});
    tokenFromParams = !!maxToken;
    running = true;

    if (!maxToken) {
      if (role === "receiver") {
        // A node has no one to sign in for it: it needs the token its setup gave it.
        setState("dead", "у ноды нет токена аккаунта MAX: настройте ноду заново");
        return;
      }
      // Nothing saved yet: ask for the account (or both), the answer comes back as cookiesApplied.
      startWizard({ uid: calleeID ? String(calleeID) : "" });
      return;
    }
    begin();
  },

  // cookiesApplied: the setup page's answer for this side (token, uid, chatId), or what the app
  // saved from an earlier one. Settings the carrier was given outrank it.
  onEvent: function (kind) {
    if (kind !== "cookiesApplied" || !running || tokenFromParams) return;
    var c = cookieJar.get();
    if (!c.token || c.token === maxToken) return;
    stopCall();
    maxToken = c.token;
    calleeID = parseInt(c.uid, 10) || calleeID;
    chatID = parseInt(c.chatId, 10) || chatID;
    begin();
  },

  write: function (bytes) {
    if (dc) dc.send(bytes);
  },

  close: function () {
    running = false;
    if (wizardServer) { try { wizardServer.close(); } catch (e) {} wizardServer = null; }
    stopCall();
  },

};
