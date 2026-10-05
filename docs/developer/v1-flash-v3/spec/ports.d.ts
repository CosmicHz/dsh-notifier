/** v3 design contract: no runtime implementation or permissive stubs. */
export type Id = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SurfaceVersion = {bootId: Id; sequence: number};
export type Actor = {kind:'local-owner'; id:Id} | {kind:'im'; id:Id; accountId:Id; principalId:Id; replyContextId:Id} | {kind:'host';id:Id;sessionId:Id};
export type SecretValue = {kind:'literal';value:string}|{kind:'env';name:string};
export type SecretChange = {path:string;op:'set';value:SecretValue}|{path:string;op:'clear'};
export type SendResult = {status:'accepted'|'confirmed';providerMessageId?:string};
export type AttachmentRef = {id:Id;name:string;mime:string;size:number};
export type Content = {text:string;attachments:AttachmentRef[];actions:{label:string;token:string}[]};
export type ReplyContext = {id:Id;accountId:Id;userId:Id;chatId:Id;chatType:'private';transportData:Record<string,Json>;expiresAt:number|null;createdAt:number;updatedAt:number};
export type EnvelopeBase = {eventId:Id;channelId:Id;accountId:Id;userId:Id;chatId:Id;chatType:'private'|'group';messageId:Id;receivedAt:number;epoch:Id;replyContext:Omit<ReplyContext,'id'|'createdAt'|'updatedAt'>};
export type InboundEnvelope = EnvelopeBase & ({kind:'message';text:string;attachments:AttachmentRef[];replyTo:null|{messageId:Id;content?:string}}|{kind:'callback';token:string;providerCallbackId:Id});
export type HostCapabilities = {converse:boolean;steer:boolean;stop:boolean;questions:boolean;approvals:boolean;attachments:boolean;callbackMount:boolean;interactionRecovery:'process-only'|'queryable'};
export type TaskView={id:Id;label:string;sessionId:Id;status:string};
export type SessionView={id:Id;agentId:Id;workspaceId:Id;label:string;status:'idle'|'running'|'closed'};
export type InteractionRequest={hostRef:Id;sessionId:Id;turnId:Id|null;type:'approval'|'question'|'action';prompt:string;choices:{id:Id;label:string}[];multiple:boolean;allowText:boolean;expiresAt:number};
export type HostEvent = {eventId:Id;at:number} & (
 {type:'interaction.opened';request:InteractionRequest} |
 {type:'interaction.closed';hostRef:Id;status:'resolved'|'cancelled'} |
 {type:'turn.started';sessionId:Id;turnId:Id} |
 {type:'turn.output';sessionId:Id;turnId:Id;text:string;attachments:AttachmentRef[]} |
 {type:'turn.completed';sessionId:Id;turnId:Id} |
 {type:'turn.failed';sessionId:Id;turnId:Id;code:string} |
 {type:'session.closed';sessionId:Id} |
 {type:'capabilities.changed';capabilities:HostCapabilities});
export interface HostPort {
 listTasks():Promise<TaskView[]>;listSessions():Promise<SessionView[]>;getSession(id:Id):Promise<SessionView|null>;
 submit(x:{sessionId:Id;mode:'followup'|'inject'|'steer';text:string;attachments:AttachmentRef[];requestId:Id;signal:AbortSignal}):Promise<{hostRef:Id;turnId:Id|null}>;
 stop(x:{sessionId:Id;requestId:Id;signal:AbortSignal}):Promise<{stopped:boolean}>;
 settleInteraction(x:{hostRef:Id;decision:'approve'|'reject'|'answer';choiceIds?:Id[];text?:string;requestId:Id;signal:AbortSignal}):Promise<{status:'resolved'|'already_handled'}>;
 queryInteraction(hostRef:Id):Promise<{status:'pending'|'resolved'|'cancelled'|'unknown'}>;
 saveAttachment(x:{sessionId:Id;name:string;mime:string;bytes:Uint8Array;requestId:Id;signal:AbortSignal}):Promise<AttachmentRef>;
 readAttachment(x:{sessionId:Id;attachmentId:Id;signal:AbortSignal}):Promise<{name:string;mime:string;bytes:Uint8Array}>;
 subscribe(handler:(event:HostEvent)=>void):()=>void;
 getCapabilities():Promise<HostCapabilities>;
 mountCallback(x:{path:string;maxBytes:number;handler:(request:{method:string;headers:Record<string,string>;rawBody:Uint8Array;signal:AbortSignal})=>Promise<{status:number;headers:Record<string,string>;body:Uint8Array}>}):Promise<()=>void>;
}
export interface Store<S> {snapshot():S;transact<T>(expectedGlobalRevision:number|null,mutator:(draft:S)=>T):Promise<{revision:number;value:T}>;close():Promise<void>}
export type OpenStore<S>={status:'ready';store:Store<S>;error:null}|{status:'degraded';store:null;error:{code:string;message:string}};
export interface NetworkPort {
 request(x:{url:string;method:string;headers:Record<string,string>;body?:Uint8Array;timeoutMs:number;maxBytes:number;allowPrivateNetwork:boolean;signal:AbortSignal}):Promise<{status:number;headers:Record<string,string>;body:Uint8Array}>;
 openWebSocket(x:{url:string;headers:Record<string,string>;timeoutMs:number;maxFrameBytes:number;signal:AbortSignal;onFrame:(bytes:Uint8Array)=>void;onClose:(code:number)=>void}):Promise<{send(bytes:Uint8Array):Promise<void>;close():Promise<void>}>;
}
