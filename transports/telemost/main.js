// Yandex Telemost: packets ride a conference as a participant's video stream.
// WORK IN PROGRESS (2026-10-21): connects, authenticates, receives serverHello
// and builds the publisher/subscriber, but the SFU drops the socket during the
// publish handshake - the single-participant signaling still needs live
// iteration against the conference (the native carrier's own comments record
// the same stage taking many rounds). The media host it drives is complete.
// Port of transport/yandex (telemost*.go) as of core 0.14.5, driving the media
// host (transport/script/host_media.go): the frame clock, the hand-written RTP,
// data inside VP8 keyframes, fragments, NACK answering and reassembly are the
// host's; joining, signaling, SDP and slot steering are here.
//
// One participant: it publishes a DISPLAY_VIDEO (screen-share) track carrying
// tunnel data, and subscribes to the one peer in the room, paging its slot onto
// that peer. A room holds one share slot, so the two tunnel ends are one
// publisher and one subscriber. (The native carrier stripes several camera
// lanes for more than one stream's bandwidth; this port is a single lane.)

var UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
var CLIENT_VERSION = "211.2.0";
var PARTICIPANT_NAME = "Гость";

var cookies = "";
var conferenceURL = "";
var userID = "";
var isExit = false;
var running = false;

var sock = null;
var roomID = "", peerID = "", credentials = "", sessionID = "", peerSessionID = "", mediaServerURL = "";
var clientInstanceID = uuid(), idempotencyKey = uuid();
var iceServers = [];
var pingIntervalMs = 5000;
var pingTimer = null, lastPing = 0;

var pubPC = null, subPC = null, pubTrack = null;
var pubSeq = 1, subSeq = 1;
var shareMID = "1", shareSSRC = 0, ridExtID = 0, shareCodecPT = 96;
var target = ""; // the peer we page our slot onto
var slotsView = null, lastOffsetReq = -1, lastOffsetAt = 0;
var parts = {}; // participantId -> {streaming, gone}

var SHARE_CODEC = "video/VP8";

function uuid() {
  var h = [];
  for (var i = 0; i < 16; i++) h.push(Math.floor(Math.random() * 256));
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  var s = "";
  for (i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += (h[i] + 0x100).toString(16).slice(1);
  }
  return s;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function userIDFromCookies(ck) {
  var m = /yandexuid=(\d+)/.exec(ck) || /\byandex_login=([^;]+)/.exec(ck);
  // The native extractUserIDFromCookie reads the "yandexuid"; any stable value works for X-Uid.
  var y = /yandexuid=(\d+)/.exec(ck);
  return y ? y[1] : "";
}

// ---- HTTP join ----

async function getConnectionInfo() {
  var apiURL, method, body = null;
  if (conferenceURL) {
    apiURL = "https://cloud-api.yandex.ru/telemost_front/v2/telemost/conferences/" +
      encodeURIComponent(conferenceURL) + "/connection?next_gen_media_platform_allowed=true&waiting_room_supported=true";
    method = "GET";
  } else {
    apiURL = "https://cloud-api.yandex.ru/telemost_front/v2/telemost/conferences?next_gen_media_platform_allowed=true";
    method = "POST";
    body = "{}";
  }
  var headers = {
    Accept: "*/*", "Accept-Language": "en-US,en;q=0.6", "Client-Instance-Id": clientInstanceID,
    Origin: "https://telemost.yandex.ru", Referer: "https://telemost.yandex.ru/",
    "User-Agent": UA, "X-Telemost-Client-Version": CLIENT_VERSION,
    "content-type": "application/json", "idempotency-key": idempotencyKey,
  };
  if (method === "POST") { headers.Cookie = cookies; headers["X-Uid"] = userID; }
  var res = await http.fetch({ url: apiURL, method: method, headers: headers, body: body });
  if (res.status === 401 || res.status === 403) {
    raise("authRequired", { account: "yandex", reason: "Telemost needs a Yandex sign-in to create a conference (status " + res.status + ")" });
  }
  if (res.status !== 200 && res.status !== 201) throw new Error("connection API status " + res.status);
  var d = JSON.parse(res.body);
  roomID = d.room_id || "";
  peerID = d.peer_id || "";
  credentials = d.credentials || "";
  sessionID = d.session_id || "";
  peerSessionID = d.peer_session_id || "";
  if (d.uri) conferenceURL = d.uri;
  mediaServerURL = (d.client_configuration || {}).media_server_url || "";
  if (!mediaServerURL) throw new Error("no media_server_url in the connection response");
}

// ---- WS signaling ----

function wsSend(obj) {
  if (sock) try { sock.send(JSON.stringify(obj)); } catch (e) {}
}

function ack(uid) {
  if (uid) wsSend({ uid: uid, ack: { status: { code: "OK" } } });
}

async function connectWS() {
  sock = await ws.open(mediaServerURL, { "User-Agent": UA, Origin: "https://telemost.yandex.ru" }, { readTimeoutMs: 60000 });
  sock.onmessage = function (raw) { handleMessage(raw); };
  sock.onclose = function (reason) {
    sock = null;
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    if (running) { setState("reconnecting", "ws closed: " + reason); scheduleReconnect(); }
  };
  sendHello();
  keepAlive();
}

var reconnecting = false;
function scheduleReconnect() {
  if (!running || reconnecting) return;
  reconnecting = true;
  setTimeout(function () {
    reconnecting = false;
    if (!running) return;
    start().catch(function (e) { setState("reconnecting", String(e)); scheduleReconnect(); });
  }, 1000 + Math.floor(Math.random() * 1000));
}

function sendHello() {
  wsSend({
    uid: uuid(),
    hello: {
      roomId: roomID, participantId: peerID, credentials: credentials, serviceName: "telemost",
      sendAudio: false, sendVideo: true, sendSharing: true,
      participantAttributes: { name: PARTICIPANT_NAME, role: "SPEAKER", description: "" },
      participantMeta: { name: PARTICIPANT_NAME, role: "SPEAKER", description: "", sendAudio: false, sendVideo: true, sendSharing: true },
      sdkInfo: { implementation: "browser", version: "6.2.1", userAgent: UA, hwConcurrency: 10 },
      sdkInitializationId: uuid(),
      capabilitiesOffer: {
        offerAnswerMode: ["SEPARATE"], initialSubscriberOffer: ["ON_HELLO"], slotsMode: ["FROM_CONTROLLER"],
        simulcastMode: ["DISABLED", "STATIC"], dataChannelSharing: ["TO_RTP"],
        dataChannelVideoCodec: ["VP8", "UNIQUE_CODEC_FROM_TRACK_DESCRIPTION"],
        subscriberOfferAsyncAck: ["SUBSCRIBER_OFFER_ASYNC_ACK_DISABLED", "SUBSCRIBER_OFFER_ASYNC_ACK_ENABLED"],
      },
    },
  });
}

function keepAlive() {
  if (pingTimer) clearTimeout(pingTimer);
  pingTimer = setTimeout(function () {
    pingTimer = null;
    if (!sock) return;
    wsSend({ uid: uuid(), ping: {} });
    keepAlive();
  }, Math.max(1000, Math.min(pingIntervalMs, 20000)));
}

function handleMessage(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  var uid = msg.uid;
  if (msg.ack || msg.pong) return;
  if (msg.serverHello) { onServerHello(msg.serverHello); ack(uid); return; }
  if (msg.subscriberSdpOffer) { ack(uid); handleSubscriberOffer(msg.subscriberSdpOffer); return; }
  if (msg.publisherSdpAnswer) { ack(uid); handlePublisherAnswer(msg.publisherSdpAnswer); return; }
  if (msg.webrtcIceCandidate) { ack(uid); handleIce(msg.webrtcIceCandidate); return; }
  if (msg.slotsConfig) { ack(uid); onSlotsConfig(msg.slotsConfig); return; }
  if (msg.upsertDescription) { ack(uid); onDescriptions(msg.upsertDescription, false); return; }
  if (msg.updateDescription) { ack(uid); onDescriptions(msg.updateDescription, false); return; }
  if (msg.removeDescription) { ack(uid); onDescriptions(msg.removeDescription, true); return; }
  if (uid) ack(uid);
}

function onServerHello(sh) {
  var pp = sh.pingPongConfiguration;
  if (pp && typeof pp.pingInterval === "number") pingIntervalMs = pp.pingInterval;
  iceServers = [];
  var rtc = sh.rtcConfiguration;
  if (rtc && Array.isArray(rtc.iceServers)) {
    for (var i = 0; i < rtc.iceServers.length; i++) {
      var s = rtc.iceServers[i];
      var urls = Array.isArray(s.urls) ? s.urls : (s.urls ? [s.urls] : []);
      if (urls.length) iceServers.push({ urls: urls, username: s.username || "", credential: s.credential || "" });
    }
  }
  sendUpdateMe();
  initPublisher().catch(function (e) { console.log("[Telemost] publisher: " + e); });
  initSubscriber();
}

function sendUpdateMe() {
  wsSend({
    uid: uuid(),
    updateMe: {
      participantMeta: { name: PARTICIPANT_NAME, role: "SPEAKER", description: "", sendAudio: false, sendVideo: false, sendSharing: true },
      participantAttributes: { name: PARTICIPANT_NAME, role: "SPEAKER", description: "" },
      sendAudio: false, sendVideo: false, sendSharing: true,
    },
  });
}

// ---- publisher ----

async function initPublisher() {
  pubPC = webrtc.newPeerConnection({ media: "publisher", iceServers: iceServers });
  pubPC.onicecandidate = function (c) { if (c) sendIce(c, "PUBLISHER"); };
  pubPC.onconnectionstatechange = function (st) {
    if (st === "connected") { if (pubTrack) pubTrack.ready(true); setState("connected"); }
  };
  pubTrack = pubPC.publishTrack({ codec: SHARE_CODEC, fps: 120, framesPerTick: 12, pace: true, probe: isExit });
  pubTrack.useLane(-1); // single participant: data comes through write(), fed by the core via Send

  var offer = await pubPC.createOffer();
  var planned = rewritePublisherSDP(offer);
  // Pion accepts only the exact offer it made as the local description; the
  // sendonly/content rewrite is what we hand the SFU, not what we set locally
  // (native: SetLocalDescription(offer), sendSDP=plan.sdp).
  await pubPC.setLocalDescription("offer", offer);
  shareSSRC = planned.ssrc;
  ridExtID = planned.ridExtID;
  shareMID = planned.videoMid || "1";
  shareCodecPT = planned.pt || 96;
  pubTrack.setLayers([{ ssrc: shareSSRC, rid: "" }], ridExtID);

  wsSend({
    uid: uuid(),
    publisherSdpOffer: {
      pcSeq: pubSeq,
      sdp: planned.sdp,
      tracks: [{
        kind: "DISPLAY_VIDEO", label: "Primary Monitor", priority: 0, dcLabel: "sharing",
        mid: shareMID, groupId: 2, description: "",
        codecs: (function () { var c = {}; c[shareCodecPT] = { channels: 0, clockRate: 90000, mimeType: SHARE_CODEC, sdpFmtpLine: "" }; return c; })(),
      }],
    },
  });
  sendPublisherTrackDescription();
  sendSetSlots();
}

async function handlePublisherAnswer(ans) {
  if (!pubPC || !ans.sdp) return;
  try { await pubPC.setRemoteDescription("answer", ans.sdp); } catch (e) { console.log("[Telemost] pub setRemote: " + e); return; }
  if (pubTrack) {
    try {
      var bound = await pubTrack.start();
      if (bound && bound.ssrc) { shareSSRC = bound.ssrc >>> 0; pubTrack.setLayers([{ ssrc: shareSSRC, rid: "" }], ridExtID); }
    } catch (e) { console.log("[Telemost] track start: " + e); }
  }
  await sleep(150); sendPublisherTrackDescription();
  await sleep(200); sendSetSlots();
}

function sendPublisherTrackDescription() {
  wsSend({
    uid: uuid(),
    updatePublisherTrackDescription: {
      publisherTrackDescriptions: [{
        mid: shareMID, transceiverMid: shareMID, kind: "DISPLAY_VIDEO", priority: 0,
        label: "Primary Monitor", codecs: {}, groupId: 2, description: "",
      }],
    },
  });
}

var slotKey = 0;
function sendSetSlots() {
  slotKey++;
  wsSend({
    uid: uuid(),
    setSlots: {
      slots: [{ width: 1280, height: 720 }],
      audioSlotsCount: 0, key: slotKey, shutdownAllVideo: false,
      withSelfView: false, selfViewVisibility: "ON_LOADING_THEN_SHOW", gridConfig: {},
    },
  });
}

// ---- subscriber ----

function initSubscriber() {
  subPC = webrtc.newPeerConnection({ media: "subscriber", iceServers: iceServers });
  subPC.onicecandidate = function (c) { if (c) sendIce(c, "SUBSCRIBER"); };
  subPC.onMediaTrack = function (track) {
    if (track.kind === "video") {
      track.remb(100000000); // our downlink is fat; drive the SFU's forward estimate up
      track.deliver(-1); // single participant: received frames go straight up via emit
    }
  };
}

async function handleSubscriberOffer(off) {
  if (!subPC) initSubscriber();
  if (!off.sdp) return;
  var pcSeq = off.pcSeq || 1;
  subSeq = pcSeq;
  try {
    await subPC.setRemoteDescription("offer", off.sdp);
    var answer = await subPC.createAnswer();
    answer = forceRecvonlyVideo(answer);
    await subPC.setLocalDescription("answer", answer);
    wsSend({ uid: uuid(), subscriberSdpAnswer: { sdp: answer, pcSeq: pcSeq } });
  } catch (e) { console.log("[Telemost] sub offer: " + e); }
}

function sendIce(c, targetRole) {
  var seq = targetRole === "PUBLISHER" ? pubSeq : subSeq;
  wsSend({
    uid: uuid(),
    webrtcIceCandidate: {
      candidate: c.candidate, sdpMid: c.sdpMid || "", usernameFragment: c.sdpMid || "",
      sdpMlineIndex: c.sdpMLineIndex || 0, target: targetRole, pcSeq: seq,
    },
  });
}

function handleIce(m) {
  var pc = m.target === "PUBLISHER" ? pubPC : subPC;
  if (!pc) return;
  pc.addIceCandidate({ candidate: m.candidate, sdpMid: m.sdpMid || "", sdpMLineIndex: m.sdpMlineIndex || 0 })
    .catch(function (e) { console.log("[Telemost] addIce " + m.target + ": " + e); });
}

// ---- descriptions / slot steering: page our one slot onto the peer ----

function onDescriptions(v, removed) {
  var list = [];
  if (v && v.description && Array.isArray(v.description)) list = v.description;
  else if (Array.isArray(v)) list = v;
  else if (v && typeof v === "object") list = [v];
  for (var i = 0; i < list.length; i++) {
    var e = list[i], id = "", m = null;
    if (typeof e === "string") id = e;
    else if (e && typeof e === "object") { m = e; id = e.id || e.participantId || ""; }
    if (!id || id === peerID) continue;
    var p = parts[id] || {};
    if (removed) p.gone = true;
    else if (m) {
      p.streaming = !!(m.sendVideo || m.sendSharing);
      p.gone = ("disconnectedAt" in m);
    }
    parts[id] = p;
  }
  pickTarget();
}

function pickTarget() {
  var best = "";
  for (var id in parts) {
    if (parts[id].streaming && !parts[id].gone) { best = id; break; }
  }
  if (best && best !== target) {
    target = best;
    steerSlots();
  }
}

function onSlotsConfig(sc) {
  var ids = function (es) {
    var out = [];
    es = es || [];
    for (var i = 0; i < es.length; i++) {
      var e = es[i], got = "";
      var keys = ["participantVideoByMid", "participantScreenSharingByMid", "participant"];
      for (var k = 0; k < keys.length; k++) {
        if (e[keys[k]] && e[keys[k]].participantId) { got = e[keys[k]].participantId; break; }
      }
      out.push(got);
    }
    return out;
  };
  slotsView = { offset: sc.offset || 0, prev: ids(sc.prevSlots), cur: ids(sc.slots), next: ids(sc.nextSlots) };
  steerSlots();
}

function steerSlots() {
  if (!slotsView || !target) return;
  var v = slotsView, want = -1, i;
  for (i = 0; i < v.cur.length; i++) if (v.cur[i] === target) want = v.offset + i;
  if (want === v.offset) return;
  if (want < 0) {
    var prevStart = Math.max(0, v.offset - v.prev.length);
    for (i = 0; i < v.prev.length; i++) if (v.prev[i] === target) want = prevStart + i;
    for (i = 0; i < v.next.length; i++) if (v.next[i] === target) want = v.offset + v.cur.length + i;
  }
  if (want < 0) want = v.next.length > 0 ? v.offset + v.cur.length + v.next.length : 0;
  if (want === lastOffsetReq && Date.now() - lastOffsetAt < 700) return;
  lastOffsetReq = want; lastOffsetAt = Date.now();
  wsSend({ uid: uuid(), setSlotsOffset: { offset: want } });
}

// ---- SDP rewriting (telemost_sdp.go, single mode) ----

function rewritePublisherSDP(sdp) {
  var lines = sdp.split("\r\n");
  var out = [], inVideo = false, dirFixed = false;
  var ssrc = 0, ridExt = 0, videoMid = "", pt = 0;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.indexOf("m=video") === 0) { inVideo = true; dirFixed = false; out.push(l); continue; }
    if (l.indexOf("m=") === 0) { inVideo = false; out.push(l); continue; }
    if (!inVideo) { out.push(l); continue; }
    if (l.indexOf("a=mid:") === 0) videoMid = l.slice(6);
    var em = /^a=extmap:(\d+)(?:\/\S+)?\s+(\S+)/.exec(l);
    if (em && em[2] === "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id") ridExt = parseInt(em[1], 10);
    var sm = /^a=ssrc:(\d+)/.exec(l);
    if (sm && !ssrc) ssrc = parseInt(sm[1], 10) >>> 0;
    var rm = /^a=rtpmap:(\d+)\s+VP8\/90000/i.exec(l);
    if (rm) pt = parseInt(rm[1], 10);
    if (l.indexOf("a=rid:") === 0 || l.indexOf("a=simulcast:") === 0 ||
        l.indexOf("a=ssrc-group:") === 0 || l.indexOf("a=content:") === 0) continue;
    if (l === "a=sendrecv" || l === "a=recvonly" || l === "a=inactive" || l === "a=sendonly") {
      if (!dirFixed) { out.push("a=sendonly"); out.push("a=content:speaker,main"); dirFixed = true; }
      continue;
    }
    out.push(l);
  }
  return { sdp: out.join("\r\n"), ssrc: ssrc, ridExtID: ridExt, videoMid: videoMid, pt: pt };
}

function forceRecvonlyVideo(sdp) {
  var lines = sdp.split("\r\n"), out = [], inVideo = false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.indexOf("m=video") === 0) { inVideo = true; out.push(l); continue; }
    if (l.indexOf("m=") === 0) { inVideo = false; out.push(l); continue; }
    if (inVideo && (l === "a=sendrecv" || l === "a=sendonly" || l === "a=inactive")) { out.push("a=recvonly"); continue; }
    out.push(l);
  }
  return out.join("\r\n");
}

async function start() {
  await getConnectionInfo();
  if (!running) return;
  await connectWS();
}

var Transport = {
  info: function () {
    return {
      name: "telemost",
      version: "1.0.0",
      cookieDomain: "https://yandex.ru/",
      scopeCookiesToParentDomain: true,
      mtu: 0, reliable: false, ordered: false,
      params: [{ key: "url", label: "Telemost conference link", type: "url", required: false }],
      auth: {
        account: "yandex", label: "Яндекс", need: "create",
        signInUrl: "https://passport.yandex.ru/auth?retpath=https%3A%2F%2Ftelemost.yandex.ru%2F",
        homeUrl: "https://telemost.yandex.ru/", waitForHome: true,
        cookieUrls: ["https://passport.yandex.ru/", "https://yandex.ru/", "https://telemost.yandex.ru/", "https://cloud-api.yandex.ru/"],
        loginCookie: "Session_id", loginNameCookie: "yandex_login",
      },
    };
  },

  open: function (cfg) {
    var p = cfg.params || {};
    conferenceURL = (p.url || cfg.url || "").trim();
    cookies = String(p.cookies || "");
    isExit = p.exit === true || p.exit === "true";
    userID = userIDFromCookies(cookies);
    running = true;
    setState("connecting");
    start().catch(function (e) { setState("reconnecting", String(e)); scheduleReconnect(); });
  },

  write: function (bytes) {
    if (!pubTrack) throw new Error("telemost: not publishing yet");
    pubTrack.write(bytes); // the host's frame clock sends it on the next ticks
  },

  close: function () {
    running = false;
    if (pingTimer) clearTimeout(pingTimer);
    if (sock) try { sock.close(); } catch (e) {}
    if (pubPC) try { pubPC.close(); } catch (e) {}
    if (subPC) try { subPC.close(); } catch (e) {}
  },
};
