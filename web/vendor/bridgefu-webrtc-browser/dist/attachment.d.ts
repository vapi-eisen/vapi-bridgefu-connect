import { type BridgefuAttachmentBinding, type BridgefuRouteWebRtcAttachment, type BridgefuWebRtcAttachment } from "./types.js";
/**
 * Normalize the snake_case named-route REST response into the self-contained
 * descriptor consumed by {@link BridgefuWebRtcClient}.
 *
 * The surrounding call response supplies the authenticated tenant/call/leg
 * binding. This helper checks that the server's private attachment
 * subprotocol and token agree before either value reaches WebSocket setup.
 */
export declare function normalizeBridgefuRouteAttachment(attachment: Readonly<BridgefuRouteWebRtcAttachment>, binding: Readonly<BridgefuAttachmentBinding>): BridgefuWebRtcAttachment;
//# sourceMappingURL=attachment.d.ts.map