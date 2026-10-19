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

function startWizard() {
  var srv = httpserver.listen(function (req) {
    if (req.path === "/" || req.path === "") {
      return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: SETUP_HTML };
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
    url: "http://" + srv.addr + "/",
    reason: "Подключение через MAX",
  });
}

function verifyToken(req) {
  var body;
  try { body = JSON.parse(text.decode(req.body)); } catch (e) {
    return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "bad json" }) };
  }
  var token = body.token || "";
  if (!token) {
    return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "пустой токен" }) };
  }

  return maxclient.connect().then(function (c) {
    return maxclient.loginByToken(c, token).then(function (resp) {
      var p = resp.payload || {};
      var contact = p.contact || {};
      var name = (contact.firstName || "") + " " + (contact.lastName || "");
      var phone = contact.phone || "";
      var uid = contact.id || 0;
      try { c.sock.close(); } catch (e) {}
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, uid: uid, name: name.trim(), phone: phone }),
      };
    });
  }).catch(function (e) {
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(e) }),
    };
  });
}

function verifyChat(req) {
  var body;
  try { body = JSON.parse(text.decode(req.body)); } catch (e) {
    return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "bad json" }) };
  }

  var clientTok = body.clientToken;
  var nodeTok = body.nodeToken;
  var clientUid = body.clientUid;
  var nodeUid = body.nodeUid;

  return maxclient.connect().then(function (cA) {
    return maxclient.loginByToken(cA, clientTok).then(function (respA) {
      var chats = (respA.payload || {}).chats || [];
      var chatId = 0;
      for (var i = 0; i < chats.length; i++) {
        var members = chats[i].memberIds || [];
        if (members.indexOf(nodeUid) !== -1) {
          chatId = chats[i].id;
          break;
        }
      }
      if (!chatId) {
        for (var j = 0; j < chats.length; j++) {
          if (chats[j].id === nodeUid) { chatId = nodeUid; break; }
        }
      }
      if (!chatId) chatId = nodeUid;

      return maxclient.connect().then(function (cB) {
        return maxclient.loginByToken(cB, nodeTok).then(function () {
          var msgRx = false;
          var testText = "ofx_" + Date.now();
          cB.setOnEvent(function (pkt) {
            if (pkt.opcode === 128) {
              var msg = (pkt.payload || {}).message || {};
              if (msg.text === testText) msgRx = true;
            }
          });
          var cid = Math.floor(Math.random() * 9007199254740991) + 1;
          return cA.invoke(64, { chatId: chatId, message: { text: testText, cid: cid } }).then(function (r) {
            if ((r || {}).cmd === 3) {
              try { cA.sock.close(); } catch (e) {}
              try { cB.sock.close(); } catch (e) {}
              return {
                status: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ok: false, error: "MSG_SEND failed: " + JSON.stringify((r.payload || {}).error) }),
              };
            }
            var serverChatId = (r.payload || {}).chatId || chatId;
            return new Promise(function (resolve) {
              var checks = 0;
              var timer = setInterval(function () {
                checks++;
                if (msgRx || checks > 20) {
                  clearInterval(timer);
                  try { cA.sock.close(); } catch (e) {}
                  try { cB.sock.close(); } catch (e) {}
                  resolve({
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(msgRx
                      ? { ok: true, chatId: serverChatId }
                      : { ok: false, error: "сообщение не доставлено за 10 секунд" }),
                  });
                }
              }, 500);
            });
          });
        });
      });
    });
  }).catch(function (e) {
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(e) }),
    };
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

var Transport = {
  info: function () {
    return {
      name: "oneme-webrtc",
      version: "3.2.1",
      mtu: 0,
      reliable: false,
      ordered: false,
      params: [
        { key: "token", label: "MAX web token", type: "secret", required: true },
        { key: "uid", label: "Callee userId", type: "text", required: false },
        { key: "chatId", label: "Chat ID for signaling", type: "text", required: false },
        { key: "exit", label: "Receiver role (true/false)", type: "text", required: false },
      ],
    };
  },

  open: function (cfg) {
    var p = (cfg && cfg.params) || {};
    maxToken = p.token || "";
    calleeID = parseInt(p.uid, 10) || 0;
    chatID = parseInt(p.chatId, 10) || 0;
    role = (p.exit === true || p.exit === "true") ? "receiver" : "caller";
    running = true;

    if (!maxToken) {
      startWizard();
      return;
    }

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
  },

  write: function (bytes) {
    if (dc) dc.send(bytes);
  },

  close: function () {
    running = false;
    if (pc) { try { pc.close(); } catch (e) {} }
    if (callConn) { try { callConn.close(); } catch (e) {} }
    if (client && client.sock) { try { client.sock.close(); } catch (e) {} }
  },

};
