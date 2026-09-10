import type { BridgefuContextEnvelopeV1, BridgefuContextInput, BridgefuHandoffEnvelopeV1, BridgefuWebRtcAttachment } from "./types.js";
export declare const RVOIP_DATA_MESSAGE_PROTOCOL = "rvoip.data.v1";
export declare const BRIDGEFU_CONTEXT_LABEL = "bridgefu.context.v1";
export declare const BRIDGEFU_CONTEXT_CONTENT_TYPE = "application/vnd.bridgefu.context.v1+json";
export declare const BRIDGEFU_HANDOFF_LABEL = "bridgefu.handoff.v1";
export declare const BRIDGEFU_HANDOFF_CONTENT_TYPE = "application/vnd.bridgefu.handoff.v1+json";
export type DataReliability = {
    mode: "reliable-ordered";
} | {
    mode: "reliable-unordered";
} | {
    mode: "max-retransmits";
    ordered: boolean;
    count: number;
} | {
    mode: "max-lifetime";
    ordered: boolean;
    milliseconds: number;
};
export declare const RELIABLE_ORDERED: DataReliability;
export interface RvoipDataMessage {
    label: string;
    contentType: string;
    data: Uint8Array;
    reliability: DataReliability;
    messageId: string;
}
export type EncodedRvoipDataMessage = string | Uint8Array;
export declare function dataChannelInitForReliability(reliability: DataReliability): RTCDataChannelInit;
export declare function reliabilityFromDataChannel(channel: RTCDataChannel): DataReliability;
/** Encode the exact rvoip-webrtc `RVDM` v1 DataChannel wire envelope. */
export declare function encodeRvoipDataMessage(message: Readonly<RvoipDataMessage>): EncodedRvoipDataMessage;
/** Decode and authenticate label/reliability against the receiving channel. */
export declare function decodeRvoipDataMessage(encoded: EncodedRvoipDataMessage, expected?: {
    label: string;
    reliability: DataReliability;
}): RvoipDataMessage;
export declare function decodeRvoipDataChannelMessage(channel: RTCDataChannel, data: unknown): Promise<RvoipDataMessage>;
export declare function sendRvoipDataMessage(channel: RTCDataChannel, message: Readonly<RvoipDataMessage>): void;
export declare function createBridgefuContextMessage(attachment: Readonly<BridgefuWebRtcAttachment>, input: Readonly<BridgefuContextInput>, messageId: string): RvoipDataMessage;
export declare function parseBridgefuContextMessage(message: Readonly<RvoipDataMessage>): BridgefuContextEnvelopeV1;
export declare function parseBridgefuHandoffMessage(message: Readonly<RvoipDataMessage>): BridgefuHandoffEnvelopeV1;
//# sourceMappingURL=data-message.d.ts.map