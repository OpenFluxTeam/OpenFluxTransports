// OpenFlux script transport for VK Teams calls (WebRTC DataChannel over VK Calls room).
//
// Establishes a high-speed, low-latency P2P/TURN WebRTC DataChannel between peers
// using the VK Teams calls signaling WebSocket (custom-data command).
//
// Params:
//   url:  VK Teams call join link (e.g. https://calls.myteam.mail.ru/join/...)
//   exit: true for exit node (listener), false for client (initiator)

var BASE_URL = "https://u.myteam.vmailru.net";
var API_VERSION = "v149";
var GUEST_NAME = "OpenFluxGuest";
var UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var running = false;
var isExit = false;
var joinLink = "";
var callConfig = null;

// Network state
var wsConn = null;
var wsSeq = 1;
var pc = null;
var dc = null;
var offerTimer = null;
var pendingCandidates = [];
var haveRemoteDesc = false;
var offerEpoch = 0;
var lastAnswer = null;      // exit: the answer for offerEpoch, resent when the same offer comes again
var answered = false;       // client: the exit's answer for offerEpoch is applied
var openTimer = null;       // client: gives up on an answered offer whose channel never opens

// Reconnect state
var reconnectTimer = null;
var reconnectDelay = 3000;
var RECONNECT_MAX = 30000;

function nextSeq() {
  return wsSeq++;
}

// VK answers most failures with HTTP 200 and the error in the body, so a status check alone says
// nothing. fail() builds the error every step throws; fatal=true means retrying cannot help
// (the call link itself is bad or the call is over), so the transport goes "dead" instead of looping.
function fail(step, detail, fatal) {
  var e = new Error(step + ": " + detail);
  e.fatal = !!fatal;
  return e;
}

function parseBody(step, resp) {
  if (resp.status !== 200) throw fail(step, "http " + resp.status);
  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw fail(step, "bad json");
  }
}

// Join errors that mean the link will never work: an undecodable/unknown link or an ended call.
function joinErrorIsFatal(code) {
  code = String(code || "");
  return code.indexOf("join_link.") === 0 || /mismatch|not_found|ended|closed|finished|deleted|forbidden/.test(code);
}

function extractJoinLink(url) {
  if (!url) return "";
  var u = String(url).trim();
  var idx = u.indexOf("/join/");
  if (idx !== -1) {
    var sub = u.substring(idx + 6);
    var q = sub.indexOf("?");
    if (q !== -1) sub = sub.substring(0, q);
    var sl = sub.indexOf("/");
    if (sl !== -1) sub = sub.substring(0, sl);
    return sub;
  }
  if (u.indexOf("/") !== -1) {
    var parts = u.split("/");
    return parts[parts.length - 1];
  }
  return u;
}

function resetCallState() {
  haveRemoteDesc = false;
  answered = false;
  lastAnswer = null;
  pendingCandidates = [];
  if (openTimer) {
    clearTimeout(openTimer);
    openTimer = null;
  }
  if (offerTimer) {
    clearInterval(offerTimer);
    offerTimer = null;
  }
  if (dc) {
    try { dc.close(); } catch (e) {}
    dc = null;
  }
  if (pc) {
    try { pc.close(); } catch (e) {}
    pc = null;
  }
}

function sendCustomData(payload) {
  if (!wsConn) return;
  var msg = {
    command: "custom-data",
    sequence: nextSeq(),
    data: payload
  };
  try {
    wsConn.send(JSON.stringify(msg));
  } catch (e) {
    // ignore send error
  }
}

async function authenticateAndJoin(link) {
  var ts = Math.floor(Date.now() / 1000);

  // 1. Optional config fetch (ignore errors)
  try {
    await http.fetch({
      url: BASE_URL + "/myteam-config.json?r=" + ts + "&domain=biz.mail.ru&email=guest@biz.mail.ru",
      headers: { "User-Agent": UA }
    });
  } catch (e) {}

  // 2. Auth as guest
  var authResp = await http.fetch({
    url: BASE_URL + "/api/" + API_VERSION + "/rapi/auth/guest",
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      "Origin": "https://myteam.mail.ru",
      "Referer": "https://myteam.mail.ru/"
    },
    body: JSON.stringify({
      reqId: "78200-" + ts,
      params: {
        name: GUEST_NAME,
        scopes: ["calls/" + link]
      }
    })
  });
  var guestData = parseBody("auth guest", authResp);
  if (!guestData.results || !guestData.results.sn || !guestData.results.token) {
    throw fail("auth guest", "refused (code " + (guestData.status && guestData.status.code) + ")");
  }
  var sn = guestData.results.sn;
  var token = guestData.results.token;

  // 3. Start WIM session
  var sessionParams = "ts=" + ts +
    "&a=" + encodeURIComponent(token) +
    "&userSn=" + encodeURIComponent(sn) +
    "&k=ic1zmlWFTdkiTnkL&view=online&clientName=webVKTeams&language=en-US&deviceId=openflux-device-id&sessionTimeout=2592000" +
    "&assertCaps=094613584C7F11D18222444553540000,0946135C4C7F11D18222444553540000" +
    "&events=myInfo,presence,webrtcMsg";

  var sessResp = await http.fetch({
    url: BASE_URL + "/api/" + API_VERSION + "/wim/aim/startSession",
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://myteam.mail.ru",
      "Referer": "https://myteam.mail.ru/"
    },
    body: sessionParams
  });
  var sessData = parseBody("start session", sessResp);
  var sessInner = sessData.response || {};
  if (sessInner.statusCode !== 200 || !sessInner.data || !sessInner.data.aimsid) {
    throw fail("start session", "refused (statusCode " + sessInner.statusCode + ")");
  }
  var aimsid = sessInner.data.aimsid;

  // 4. Get OK Calls auth token
  var tokenResp = await http.fetch({
    url: BASE_URL + "/api/" + API_VERSION + "/rapi/okcalls/getAuthToken",
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      "X-Teams-Aimsid": aimsid,
      "Origin": "https://myteam.mail.ru",
      "Referer": "https://myteam.mail.ru/"
    },
    body: JSON.stringify({ reqId: "10711-" + ts, aimsid: aimsid })
  });
  var tokenData = parseBody("get auth token", tokenResp);
  if (!tokenData.results || !tokenData.results.token) {
    throw fail("get auth token", "refused (code " + (tokenData.status && tokenData.status.code) + ")");
  }
  var callsApiToken = tokenData.results.token;

  // 5. Calls anonym login
  var sessionDataJSON = JSON.stringify({
    version: 3,
    device_id: "openflux-device",
    client_version: 1.1,
    client_type: "SDK_JS",
    auth_token: callsApiToken
  });

  var loginParams = "session_data=" + encodeURIComponent(sessionDataJSON) +
    "&method=auth.anonymLogin&format=JSON&application_key=CIAPPDKGDIHBABABA";

  var loginResp = await http.fetch({
    url: "https://calls.okcdn.ru/fb.do",
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://myteam.mail.ru",
      "Referer": "https://myteam.mail.ru/"
    },
    body: loginParams
  });
  var loginData = parseBody("calls anonymLogin", loginResp);
  if (loginData.error_code || !loginData.session_key) {
    throw fail("calls anonymLogin", String(loginData.error_msg || "no session_key"));
  }

  // 6. Join conversation by link
  var joinParams = "joinLink=" + encodeURIComponent(link) +
    "&isVideo=false&protocolVersion=6&capabilities=253F" +
    "&anonymToken=" + encodeURIComponent(callsApiToken) +
    "&method=vchat.joinConversationByLink&format=JSON&application_key=CIAPPDKGDIHBABABA" +
    "&session_key=" + encodeURIComponent(loginData.session_key);

  var joinResp = await http.fetch({
    url: "https://calls.okcdn.ru/fb.do",
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://myteam.mail.ru",
      "Referer": "https://myteam.mail.ru/"
    },
    body: joinParams
  });
  var convData = parseBody("join conversation", joinResp);
  if (convData.error_code || !convData.endpoint) {
    var detail = convData.custom_error && convData.custom_error.vchat_detailed_api_error;
    var detailCode = detail && detail.code;
    throw fail("join conversation",
      String(detailCode || convData.error_msg || "no endpoint") + (convData.error_code ? " (error " + convData.error_code + ")" : ""),
      joinErrorIsFatal(detailCode));
  }

  return convData;
}

function buildIceServers(convData) {
  var iceServers = [];
  if (convData.turn_server && convData.turn_server.urls && convData.turn_server.urls.length > 0) {
    iceServers.push({
      urls: convData.turn_server.urls,
      username: convData.turn_server.username,
      credential: convData.turn_server.credential
    });
  }
  if (convData.stun_server && convData.stun_server.urls && convData.stun_server.urls.length > 0) {
    iceServers.push({
      urls: convData.stun_server.urls
    });
  }
  return iceServers;
}

function flushPendingCandidates() {
  if (!pc || !haveRemoteDesc) return;
  for (var i = 0; i < pendingCandidates.length; i++) {
    try {
      pc.addIceCandidate(pendingCandidates[i]);
    } catch (e) {}
  }
  pendingCandidates = [];
}

async function initiateClientOffer() {
  if (!running || !callConfig) return;
  resetCallState();

  var iceServers = buildIceServers(callConfig);
  pc = webrtc.newPeerConnection({ iceServers: iceServers });
  offerEpoch = Date.now();
  var epoch = offerEpoch;

  pc.onicecandidate = function (c) {
    if (c) {
      sendCustomData({
        type: "ice-candidate",
        from: "client",
        candidate: JSON.stringify(c),
        epoch: epoch
      });
    }
  };

  pc.onconnectionstatechange = function (s) {
    if (s === "failed" || s === "closed") {
      setState("reconnecting", "pc state " + s);
    }
  };

  dc = pc.createDataChannel("flux-tunnel", { ordered: true });
  dc.onopen = function () {
    setState("connected");
    if (offerTimer) {
      clearInterval(offerTimer);
      offerTimer = null;
    }
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  };
  dc.onclose = function () {
    setState("reconnecting", "datachannel closed");
  };
  dc.onmessage = function (bytes) {
    emit(bytes);
  };

  var offer = await pc.createOffer();
  await pc.setLocalDescription("offer", offer);

  sendCustomData({
    type: "sdp-offer",
    from: "client",
    sdp: offer,
    epoch: epoch
  });

  if (!offerTimer) {
    offerTimer = setInterval(function () {
      // Once the exit has answered, resending the offer only makes it start over: ICE then
      // needs time, so the answered offer is left alone (openTimer starts a new one if it stalls).
      if (!running || answered || epoch !== offerEpoch || (dc && dc.readyState === "open")) {
        if (offerTimer) {
          clearInterval(offerTimer);
          offerTimer = null;
        }
        return;
      }
      sendCustomData({
        type: "sdp-offer",
        from: "client",
        sdp: offer,
        epoch: epoch
      });
    }, 2000);
  }
}

async function handleRemoteOffer(offerSDP, epoch) {
  if (!running || !callConfig) return;
  // The client resends its offer every 2 s until the answer reaches it. The same offer again
  // is not a new call: starting over would throw away an ICE negotiation that is under way.
  if (pc && epoch === offerEpoch) {
    if (lastAnswer) {
      sendCustomData({ type: "sdp-answer", from: "exit", sdp: lastAnswer, epoch: epoch });
    }
    return;
  }
  resetCallState();

  var iceServers = buildIceServers(callConfig);
  pc = webrtc.newPeerConnection({ iceServers: iceServers });
  offerEpoch = epoch;

  pc.onicecandidate = function (c) {
    if (c) {
      sendCustomData({
        type: "ice-candidate",
        from: "exit",
        candidate: JSON.stringify(c),
        epoch: epoch
      });
    }
  };

  pc.onconnectionstatechange = function (s) {
    if (s === "failed" || s === "closed") {
      setState("reconnecting", "pc state " + s);
    }
  };

  pc.ondatachannel = function (remoteDC) {
    dc = remoteDC;
    dc.onopen = function () {
      setState("connected");
    };
    dc.onclose = function () {
      setState("reconnecting", "datachannel closed");
    };
    dc.onmessage = function (bytes) {
      emit(bytes);
    };
  };

  await pc.setRemoteDescription("offer", offerSDP);
  haveRemoteDesc = true;
  flushPendingCandidates();

  var answer = await pc.createAnswer();
  await pc.setLocalDescription("answer", answer);
  lastAnswer = answer;

  sendCustomData({
    type: "sdp-answer",
    from: "exit",
    sdp: answer,
    epoch: epoch
  });
}

async function handleRemoteAnswer(answerSDP, epoch) {
  if (!pc || answered || epoch !== offerEpoch) return;
  answered = true;
  try {
    await pc.setRemoteDescription("answer", answerSDP);
    haveRemoteDesc = true;
    flushPendingCandidates();
    if (!openTimer) {
      openTimer = setTimeout(function () {
        openTimer = null;
        if (running && !isExit && dc && dc.readyState !== "open") {
          initiateClientOffer().catch(function (e) {
            setState("degraded", "offer error: " + String(e));
          });
        }
      }, 25000);
    }
  } catch (e) {
    answered = false;
    setState("degraded", "answer error: " + String(e));
  }
}

function handleRemoteCandidate(candJSON, epoch) {
  if (epoch !== offerEpoch) return;
  try {
    var c = JSON.parse(candJSON);
    if (pc && haveRemoteDesc) {
      pc.addIceCandidate(c);
    } else {
      pendingCandidates.push(c);
    }
  } catch (e) {}
}

function handleCustomData(d) {
  if (!d) return;
  var typ = d.type;
  var from = d.from;
  var epoch = d.epoch || 0;

  if (isExit) {
    if (from !== "client") return;
    if (typ === "sdp-offer") {
      handleRemoteOffer(d.sdp, epoch).catch(function (e) {
        setState("degraded", "handle offer: " + String(e));
      });
    } else if (typ === "ice-candidate") {
      handleRemoteCandidate(d.candidate, epoch);
    }
  } else {
    if (from !== "exit") return;
    if (typ === "sdp-answer") {
      handleRemoteAnswer(d.sdp, epoch).catch(function (e) {
        setState("degraded", "handle answer: " + String(e));
      });
    } else if (typ === "ice-candidate") {
      handleRemoteCandidate(d.candidate, epoch);
    }
  }
}

function handleSocketMessage(msg) {
  var t = typeof msg === "string" ? msg : text.decode(msg);
  if (t === "ping") {
    try { wsConn.send("pong"); } catch (e) {}
    return;
  }
  var data;
  try {
    data = JSON.parse(t);
  } catch (e) {
    return;
  }
  if (data.type === "notification" && data.notification === "custom-data") {
    handleCustomData(data.data);
  }
}

async function connectWebSocket(endpoint) {
  var wsURL = endpoint + "&platform=WEB&appVersion=1.1&version=6&device=browser&capabilities=253F&clientType=VK_TEAMS&tgt=join";
  var sock = await ws.open(wsURL, {
    "Origin": "https://myteam.mail.ru",
    "User-Agent": UA
  }, { readTimeoutMs: 0 });

  wsConn = sock;
  sock.onmessage = handleSocketMessage;
  sock.onclose = function () {
    if (wsConn === sock) wsConn = null;
    if (!running) return;
    setState("reconnecting", "websocket closed");
    scheduleReconnect(2000);
  };
}

// One place decides what a failed connect means: a fatal one (bad or ended call link) ends the
// transport with a reason the app can show; anything else is retried with a growing delay.
function handleConnectError(e) {
  if (!running) return;
  if (e && e.fatal) {
    running = false;
    resetCallState();
    setState("dead", String(e.message || e));
    return;
  }
  setState("reconnecting", String((e && e.message) || e));
  scheduleReconnect(reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

function scheduleReconnect(delay) {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    if (!running) return;
    connectOnce().catch(handleConnectError);
  }, delay);
}

async function connectOnce() {
  callConfig = await authenticateAndJoin(joinLink);
  await connectWebSocket(callConfig.endpoint);
  reconnectDelay = 3000;

  if (!isExit) {
    setTimeout(function () {
      if (running) {
        initiateClientOffer().catch(function (e) {
          setState("degraded", "offer error: " + String(e));
        });
      }
    }, 1000);
  }
}

var Transport = {
  info: function () {
    return {
      name: "vkteams",
      version: "1.0.3",
      mtu: 0,
      reliable: true,
      ordered: true,
      params: [
        { key: "url", label: "VK Teams Call Join URL", type: "url", required: true },
        { key: "exit", label: "Run as Exit Node", type: "boolean", default: false }
      ]
    };
  },

  open: async function (cfg) {
    running = true;
    setState("connecting");

    var rawURL = cfg.url || (cfg.params && cfg.params.url) || "";
    joinLink = extractJoinLink(rawURL);
    if (!joinLink) {
      setState("dead", "missing join url");
      return;
    }

    if (cfg.params && (cfg.params.exit === "true" || cfg.params.exit === true || cfg.params.role === "exit")) {
      isExit = true;
    } else {
      isExit = false;
    }

    try {
      await connectOnce();
    } catch (e) {
      handleConnectError(e);
    }
  },

  write: function (bytes) {
    if (!dc) {
      throw new Error("data channel not ready");
    }
    dc.send(bytes);
  },

  close: function () {
    running = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setState("dead");
    resetCallState();
    if (wsConn) {
      try { wsConn.close(); } catch (e) {}
      wsConn = null;
    }
  }
};
