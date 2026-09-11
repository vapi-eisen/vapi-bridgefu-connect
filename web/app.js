// Browser half of the vapi-bridgefu-connect lab (adapted from the upstream
// qualification demo site and the StandardCharter widget captions).
//
// Sequence: POST /api/session (local server adds the lab bearer) -> one-use
// Bridgefu attachment -> BridgefuWebRtcClient.connect -> Bridgefu dials the Vapi
// assistant -> caller asks for a person -> Vapi tool -> Bridgefu replaces the
// Vapi leg with Amazon Connect while this RTCPeerConnection stays stable.
import {
  BridgefuWebRtcClient,
  normalizeBridgefuRouteAttachment,
} from "./vendor/bridgefu-webrtc-browser/dist/index.js";

const el = {
  status: document.querySelector("#status"),
  caption: document.querySelector("#caption"),
  timeline: document.querySelector("#timeline"),
  session: document.querySelector("#session"),
  start: document.querySelector("#start"),
  mute: document.querySelector("#mute"),
  dtmf: document.querySelector("#dtmf"),
  end: document.querySelector("#end"),
  remote: document.querySelector("#remote-audio"),
};

const CAPTIONS = {
  preparing: "Preparing a secure voice connection…",
  ringing: "Connecting your call…",
  attaching: "Securing media…",
  connected: "Connected.",
  resumed: "The call center was unavailable, so the assistant has resumed.",
  reconnecting: "Restoring the voice connection…",
  ended: "The call has ended.",
  failed: "The handoff could not be completed.",
};

let client = null;
let muted = false;
let connectedLegs = 0;

/**
 * Bridgefu's WebRTC driver binds an IPv4 UDP socket (0.0.0.0:20000-20399). When the browser
 * advertises an IPv6 host candidate the driver logs "Failed to send to [fd..]: Address family
 * not supported by protocol (os error 97)" and the attachment fails within the same second.
 * Until the release handles that, keep IPv6 candidates local: the SDK still sees every IPv4
 * candidate and the end-of-candidates marker.
 */
function candidateAddress(candidate) {
  return String(candidate?.candidate ?? "").split(" ")[4] ?? "";
}

function ipv4OnlyEnvironment() {
  return {
    createPeerConnection: (configuration) => {
      const peer = new RTCPeerConnection(configuration);
      let handler = null;
      peer.addEventListener("icecandidate", (event) => {
        if (event.candidate && candidateAddress(event.candidate).includes(":")) {
          addEvent("skipped an IPv6 candidate (Bridgefu media is IPv4-only)");
          return;
        }
        handler?.(event);
      });
      Object.defineProperty(peer, "onicecandidate", {
        configurable: true,
        get: () => handler,
        set: (fn) => {
          handler = fn;
        },
      });
      return peer;
    },
    createWebSocket: (url, protocols) => new WebSocket(url, protocols),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    now: () => Date.now(),
    randomId: () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
}

function setStatus(text) {
  el.status.textContent = text;
}

function setButtons({ start, mute, dtmf, end }) {
  el.start.disabled = !start;
  el.mute.disabled = !mute;
  el.dtmf.disabled = !dtmf;
  el.end.disabled = !end;
}

function addEvent(text) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  item.append(time, document.createTextNode(" " + text));
  el.timeline.append(item);
  while (el.timeline.children.length > 40) el.timeline.firstChild.remove();
}

async function requestSession() {
  const response = await fetch("/api/session", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).error ?? "";
    } catch {
      /* body was not JSON */
    }
    throw new Error(`session request failed (${response.status}${detail ? " " + detail : ""})`);
  }
  const session = await response.json();
  for (const key of ["session_id", "tenant_id", "call_id", "leg_id", "attachment"]) {
    if (!(key in session)) throw new Error(`session response is missing ${key}`);
  }
  return session;
}

function wire(value) {
  value.on("state", ({ state }) => {
    addEvent(`connection ${state}`);
    if (state === "connected") {
      setStatus("Connected. Riley (the Vapi assistant) should greet you.");
      setButtons({ start: false, mute: true, dtmf: true, end: true });
    } else if (state === "closed" || state === "failed") {
      setStatus(state === "closed" ? "Call ended." : "The call could not continue.");
      setButtons({ start: true, mute: false, dtmf: false, end: false });
      client = null;
    }
  });
  value.on("handoff", ({ status, detail }) => {
    el.caption.textContent = CAPTIONS[status] ?? "";
    addEvent(`handoff ${status}${detail ? ` (${detail})` : ""}`);
    if (status === "connected") {
      connectedLegs += 1;
      if (connectedLegs === 1) {
        setStatus("Talking to Riley (Vapi assistant). Ask for a person to trigger the handoff.");
      } else {
        setStatus("Connected to the Amazon Connect agent. Check Agent Workspace for the screen pop.");
        el.caption.textContent = "Handoff complete. Your browser connection never dropped.";
      }
    } else if (status === "resumed") {
      setStatus("The agent could not be reached; Riley is back.");
    } else if (status === "failed") {
      setStatus("Handoff failed. See the timeline and verify-web for details.");
    }
  });
  value.on("remoteTrack", ({ event }) => {
    if (event.track?.kind === "audio") addEvent("remote audio track received");
  });
  value.on("reconnectRequired", () => {
    addEvent("signaling lost; a new call is required");
    setStatus("Connection lost. Start a new call.");
    setButtons({ start: true, mute: false, dtmf: false, end: false });
    client = null;
  });
  value.on("error", ({ error }) => {
    addEvent(`error ${error?.code ?? error?.name ?? "unknown"}${error?.message ? `: ${error.message}` : ""}`);
    setStatus("Something went wrong. See the timeline.");
  });
}

async function start() {
  setButtons({ start: false, mute: false, dtmf: false, end: false });
  connectedLegs = 0;
  muted = false;
  el.mute.textContent = "Mute";
  el.caption.textContent = "";
  setStatus("Requesting a Bridgefu attachment…");
  try {
    const session = await requestSession();
    el.session.textContent = session.session_id;
    addEvent(`session ${session.session_id.slice(0, 12)}… created`);
    const attachment = normalizeBridgefuRouteAttachment(session.attachment, {
      tenantId: session.tenant_id,
      callId: session.call_id,
      legId: session.leg_id,
    });
    client = new BridgefuWebRtcClient({
      environment: ipv4OnlyEnvironment(),
      remoteAudioElement: el.remote,
      connectTimeoutMs: 30_000,
      disconnectGraceMs: 2_000,
    });
    wire(client);
    setStatus("Attaching to Bridgefu…");
    await client.connect(attachment);
  } catch (error) {
    addEvent(`start failed: ${error?.code ?? error?.message ?? "unknown"}`);
    setStatus("Could not start the call. Is the lab-web stack up and the overlay applied?");
    setButtons({ start: true, mute: false, dtmf: false, end: false });
    client = null;
  }
}

el.start.addEventListener("click", start);
el.end.addEventListener("click", async () => {
  if (client) await client.disconnect().catch(() => undefined);
});
el.mute.addEventListener("click", () => {
  muted = !muted;
  for (const sender of client?.peerConnection?.getSenders() ?? []) {
    if (sender.track?.kind === "audio") sender.track.enabled = !muted;
  }
  el.mute.textContent = muted ? "Unmute" : "Mute";
  addEvent(muted ? "microphone muted" : "microphone unmuted");
});
el.dtmf.addEventListener("click", () => {
  try {
    client?.sendDtmf("9");
    addEvent("sent DTMF 9");
  } catch (error) {
    addEvent(`DTMF unavailable (${error?.code ?? "error"})`);
  }
});
window.addEventListener("pagehide", () => {
  void client?.disconnect().catch(() => undefined);
});

setStatus("Ready. Click Talk to support and allow the microphone.");
setButtons({ start: true, mute: false, dtmf: false, end: false });
