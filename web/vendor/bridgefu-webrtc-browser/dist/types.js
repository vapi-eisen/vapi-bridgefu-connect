/** rvoip WebSocket signaling subprotocol selected by the server. */
export const RVOIP_WEBRTC_SIGNALING_PROTOCOL = "rvoip.webrtc.v1";
/** Private subprotocol prefix carrying one single-use Bridgefu attachment. */
export const BRIDGEFU_ATTACHMENT_PROTOCOL_PREFIX = "bridgefu.attach.";
/** Private subprotocol prefix carrying a signaling-only bearer. */
export const RVOIP_SIGNALING_TOKEN_PROTOCOL_PREFIX = "token.";
export class BridgefuWebRtcError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = "BridgefuWebRtcError";
        this.code = code;
    }
}
//# sourceMappingURL=types.js.map