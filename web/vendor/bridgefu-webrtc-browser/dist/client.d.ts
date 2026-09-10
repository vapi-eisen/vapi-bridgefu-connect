import { type DataReliability, type RvoipDataMessage } from "./data-message.js";
import { type BridgefuContextInput, type BridgefuDataChannelSpec, type BridgefuWebRtcAttachment, type BridgefuWebRtcClientOptions, type BridgefuWebRtcEventMap, type BridgefuWebRtcEventName, type BridgefuWebRtcState } from "./types.js";
/**
 * Browser-side owner for one Bridgefu WebRTC attachment.
 *
 * A client instance handles one active attachment at a time. Reconnection
 * requires a freshly issued descriptor because Bridgefu tokens are single-use.
 */
export declare class BridgefuWebRtcClient {
    private readonly environment;
    private readonly rtcConfiguration;
    private readonly microphone;
    private readonly credentialProvider;
    private readonly ringback;
    private readonly remoteAudioElement;
    private readonly connectTimeoutMs;
    private readonly disconnectGraceMs;
    private readonly allowInsecureLocalhost;
    private readonly channelSpecs;
    private readonly listeners;
    private readonly channels;
    private stateValue;
    private handoffStatus;
    private lastHandoffGeneration;
    private generation;
    private intentionalClose;
    private ringbackActive;
    private peer;
    private socket;
    private localStream;
    private attachment;
    private lastAttachmentToken;
    private connectionId;
    private requestId;
    private offerSdp;
    private peerConnected;
    private remoteAdmissionReady;
    private pendingIce;
    private signalingQueue;
    private signalingBacklog;
    private connectWaiter;
    private connectTimer;
    private disconnectTimer;
    constructor(options?: BridgefuWebRtcClientOptions);
    get state(): BridgefuWebRtcState;
    get peerConnection(): RTCPeerConnection | null;
    get serverConnectionId(): string | null;
    on<K extends BridgefuWebRtcEventName>(name: K, listener: (event: BridgefuWebRtcEventMap[K]) => void): () => void;
    /** Register an arbitrary DataChannel before the next initial offer. */
    addDataChannel(spec: BridgefuDataChannelSpec): void;
    connect(attachment: BridgefuWebRtcAttachment): Promise<void>;
    /**
     * Tear down the old route and attach with a fresh single-use descriptor.
     * Replaying the previous attachment is rejected locally.
     */
    reconnect(attachment: BridgefuWebRtcAttachment): Promise<void>;
    disconnect(): Promise<void>;
    getDataChannel(label: string): RTCDataChannel | null;
    sendRaw(label: string, data: string | ArrayBuffer | ArrayBufferView): void;
    sendDataMessage(label: string, contentType: string, data: string | Uint8Array, reliability?: DataReliability): RvoipDataMessage;
    sendContext(input: BridgefuContextInput): RvoipDataMessage;
    sendDtmf(tones: string, durationMs?: number, interToneGapMs?: number): void;
    private connectInternal;
    private bindPeer;
    private bindSocket;
    private handleSignalingMessage;
    private installDataChannels;
    private attachDataChannel;
    private sendOrQueueIce;
    private flushPendingIce;
    private sendSignaling;
    private requireConnectionMatch;
    private requireAdmissionOutcomeMatch;
    private requireEmptyAdmissionPayload;
    private tryCompleteAttachment;
    private requireOpenChannel;
    private scheduleDisconnectFailure;
    private clearDisconnectTimer;
    private requireReconnect;
    private fail;
    private cleanupResources;
    private setState;
    private setHandoff;
    private applyServerHandoffStatus;
    private startRingback;
    private stopRingback;
    private invokeRingback;
    private emit;
    private nextRequestId;
    private nextMessageId;
    private assertGeneration;
}
//# sourceMappingURL=client.d.ts.map