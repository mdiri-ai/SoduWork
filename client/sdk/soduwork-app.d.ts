/** Browser globals for the public SoduWork H5 SDK 1.7.0. Load soduwork-app.js separately. */
declare namespace SoduWorkApp {
  type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
  interface JsonObject { [key: string]: JsonValue; }
  type NoParams = Record<string, never>;

  interface Failure {
    ok: false;
    reason: string;
    code?: string;
    /** The result is unknown; inspect existing records before resubmitting. */
    uncertain?: boolean;
  }
  type Receipt<T = unknown> = ({ ok: true } & T) | Failure;
  type Acknowledgement = { ok: true } | Failure;

  interface ConfigureOptions {
    /** Exact HTTP(S) origin, without a path or wildcard. */
    parentOrigin?: string;
    /** Only the native top-level page may authorize direct iframes. */
    allowedFrameOrigins?: string[];
  }
  interface Context {
    appId: string;
    contributionId: string;
    tabId: string;
    activeConversationId: string;
    /** Older shells may omit the current interface language. */
    locale?: string;
  }
  interface CurrentUser {
    id: string;
    username?: string;
    name?: string;
    displayName?: string;
    orgId?: string;
    orgName?: string;
  }
  interface OffsetOptions { offset?: number | null; limit?: number | null; }
  interface NotificationsOptions extends OffsetOptions {
    source?: 'server' | 'center' | null;
    folder?: 'received' | 'sent' | null;
    before?: string | null;
  }
  interface Notification {
    id?: string;
    messageId?: string;
    serverMessageId?: string;
    senderId?: string;
    recipientId?: string;
    senderName?: string;
    recipientName?: string;
    conversationId?: string;
    text?: string;
    bodyText?: string;
    title?: string;
    kind?: string;
    taskId?: string;
    status?: string;
    at?: string | number;
    read?: boolean;
    createdAt?: string | number;
    readAt?: string | number;
    deliveredAt?: string | number;
  }
  type NotificationsPage =
    | { source?: 'server'; items: Notification[]; nextCursor: string | null }
    | { source: 'center'; items: Notification[]; nextOffset: number | null };
  type LibraryStorage = 'local' | 'minio' | 'nfs';
  interface LibraryListOptions extends OffsetOptions {
    storage?: LibraryStorage | null;
    folderId?: string | null;
    query?: string | null;
  }
  interface LibraryItem {
    id?: string;
    title?: string;
    name?: string;
    filename?: string;
    kind?: string;
    folderId?: string;
    storage?: string;
    backend?: string;
    size?: number;
    contentType?: string;
    createdAt?: string | number;
    updatedAt?: string | number;
  }
  interface LibraryReadOptions {
    id: string;
    format?: 'text' | 'base64' | null;
    offset?: number | null;
    /** Characters for text, bytes for base64. */
    length?: number | null;
  }
  type LibraryContent =
    | { id: string; format: 'text'; content: string; totalLength: number; offset: number; nextOffset: number | null }
    | { id: string; format: 'base64'; data: string; mimeType: string; totalBytes: number; offset: number; nextOffset: number | null };
  interface ConversationsOptions extends OffsetOptions { archived?: boolean | null; }
  interface ConversationSummary { id: string; title: string; adapterId: string; cloud: boolean; at: string | number; }
  interface ConversationSegment { id: string; adapterId: string; }
  interface MessagesOptions extends OffsetOptions { id: string; segmentId?: string | null; after?: number | null; }
  interface ConversationMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
    hasNonTextContent: boolean;
  }
  interface ConversationEvent {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    delta: boolean;
    streamId: string;
    done: boolean;
  }
  type ConversationPage =
    | { requiresSegment: true; format?: never; items: []; segments: ConversationSegment[]; nextOffset: null }
    | { requiresSegment?: false; format: 'messages'; items: ConversationMessage[]; segments: ConversationSegment[]; nextOffset: number | null }
    | { requiresSegment?: false; format: 'events'; items: ConversationEvent[]; segments: ConversationSegment[]; cursor: number; nextAfter: number | null };
  interface DirectoryMember { id: string; name: string; orgId: string; org: string; canReceive: boolean; }
  interface OrganizationUnit { id: string; name: string; parentId: string; }
  interface Directory {
    members: DirectoryMember[];
    orgUnits: OrganizationUnit[];
    organizationDirectoryAvailable: boolean;
    truncated: boolean;
    reason: string;
  }

  interface SendOptions { text: string; requestId?: string; attachmentIds?: string[]; }
  interface SendRequest extends SendOptions { requestId: string; }
  /** Acceptance is admission to the conversation, not model or business completion. */
  type SendReceipt = { ok: true; accepted: true } | (Failure & { accepted?: false });
  interface MentionOptions { recipientUserId?: string; query?: string; text?: string; requestId?: string; }
  interface MentionRequest extends MentionOptions { requestId: string; }
  /** A review/selection card is open; the user has not necessarily sent a notification. */
  type MentionReceipt = { ok: true; opened: true; state: 'review' | 'select' } | (Failure & { opened?: false });
  interface InsertTextOptions { text: string; append?: boolean; }

  type SettingsReadOptions =
    | { keys?: string[] | null; includeSecrets?: false }
    | { keys: string[]; includeSecrets: true };
  type SettingsUpdateOptions = SettingsReadOptions & {
    values?: JsonObject | null;
    remove?: string[] | null;
    secretKeys?: string[] | null;
    expectedRevision?: number | null;
  };
  interface Settings {
    revision: number;
    updatedAt: string;
    secretKeys: string[];
    secretMasks: Record<string, string>;
    configuredKeys: string[];
    values: JsonObject;
  }
  interface AutomationContext { spaceId?: string; spaceName?: string; page?: string; characterName?: string; }
  interface AutomationOptions { text: string; requestId?: string; context?: AutomationContext; }
  interface AutomationRequest extends AutomationOptions { requestId: string; }
  interface Schedule {
    id: string;
    title: string;
    every: string;
    /** Remaining schedule fields depend on the selected timing/execution mode. */
    [key: string]: unknown;
  }
  interface AutomationCreated {
    state: 'created';
    schedule: Schedule;
    /** Execution preflight readiness; saving does not mean the job ran. */
    executionState: string;
    message: string;
  }
  interface GenerateOptions {
    input: string;
    instructions: string;
    requestId?: string;
    model?: string | null;
    maxOutputTokens?: number | null;
    timeoutMs?: number | null;
  }
  interface GenerateRequest extends GenerateOptions { requestId: string; }
  interface Generated {
    requestId: string;
    text: string;
    model: string;
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    finishReason: 'stop' | 'length';
  }
  type GenerateReceipt = ({ ok: true } & Generated) | (Failure & { finishReason?: 'length'; httpStatus?: number });

  interface DataTarget { appId?: string; collection: string; }
  interface DataGetOptions extends DataTarget { id: string; }
  interface DataListOptions extends DataTarget {
    limit?: number;
    /** Omitted, null and empty cursors all select the first page. */
    after?: string | null;
    filter?: Record<string, string | number | boolean | null> | null;
  }
  interface DataRecord { id: string; value: JsonObject; revision: number; updatedAt: string; deleted?: false; }
  interface DeletedRecord { id: string; deleted: true; revision: number; }
  type DataOperation =
    | { id: string; value: JsonObject; expectedRevision: number; delete?: false }
    | { id: string; delete: true; expectedRevision: number; value?: JsonObject };
  interface DataBatchOptions extends DataTarget { operations: DataOperation[]; }
  interface DataApp { appId: string; name: string; collections: { key: string; indexes: string[] }[]; }
  interface Asset { id: string; name: string; type: string; size: number; }
  interface AssetPutOptions { name: string; type: string; data: Uint8Array; appId?: string; }
  interface AssetGetOptions { id: string; appId?: string; }
  type AssetContent = { asset: null; data?: never } | { asset: Asset; data: Uint8Array };
  interface McpContext { spaceId?: string; recordId?: string; spaceName?: string; recordName?: string; }
  interface McpConnectOptions { server: string; url: string; credentialKey?: string; token?: string; context?: McpContext; }

  interface Attachment { id: string; name: string; type: string; size: number; }
  /** File, Blob, or a compatible sliced source; no native path is accepted. */
  interface FileLike {
    readonly size: number;
    readonly name?: string;
    readonly type?: string;
    slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  }
  interface AttachmentImportOptions {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  }
  interface AttachmentBeginOptions { name: string; type?: string; size: number; }
  interface AttachmentAppendOptions { id: string; offset: number; data: Uint8Array; }
  interface FileSource { sourceId: string; name: string; type: string; size: number; url: string; }
  interface PersistentFile { id: string; projectId: string; name: string; type: string; size: number; sha256: string; createdAt: string; url: string; }
  type FileReceipt = Receipt<{ file: PersistentFile }>;
  interface FileImportOptions {
    projectId: string;
    name?: string;
    signal?: AbortSignal;
    onProgress?: (progress: { loaded: number; total: number }) => void;
  }
  interface FileCopyOptions { projectId: string; sourceId: string; }
  interface FileGetOptions { projectId: string; id: string; }
  interface FileBeginOptions { projectId: string; name: string; type: string; size: number; }
  interface FileAppendOptions { id: string; offset: number; data: Uint8Array | number[]; }

  interface TurnSettledEvent { state: 'settled'; }
  type DataChangedEvent =
    | { topic: 'identity' | 'notifications' | 'conversations' | 'library' }
    | { topic: 'content'; spaceId?: string | undefined; topicId?: string | undefined };
  type Unsubscribe = () => void;

  /** Only names accepted by the public H5 request allowlist, including transfer primitives. */
  interface RequestMap {
    'files.pickLocal': { params: NoParams; result: Receipt<{ items: FileSource[] }> };
    'files.copyLocal': { params: FileCopyOptions; result: FileReceipt };
    'files.begin': { params: FileBeginOptions; result: Receipt<{ id: string; chunkBytes: number }> };
    'files.append': { params: FileAppendOptions; result: Receipt<{ offset: number }> };
    'files.finish': { params: { id: string }; result: FileReceipt };
    'files.cancel': { params: { id: string }; result: Acknowledgement };
    'files.getUrl': { params: FileGetOptions; result: FileReceipt };
    'ai.generate': { params: GenerateRequest; result: GenerateReceipt };
    'context.get': { params: NoParams; result: Receipt<Context> };
    'user.getCurrent': { params: NoParams; result: Receipt<{ user: CurrentUser }> };
    'notifications.list': { params: NotificationsOptions; result: Receipt<NotificationsPage> };
    'library.list': { params: LibraryListOptions; result: Receipt<{ storage: LibraryStorage; items: LibraryItem[]; folders: LibraryItem[]; nextOffset: number | null }> };
    'library.read': { params: LibraryReadOptions; result: Receipt<LibraryContent> };
    'conversations.list': { params: ConversationsOptions; result: Receipt<{ items: ConversationSummary[]; nextOffset: number | null }> };
    'conversations.messages': { params: MessagesOptions; result: Receipt<ConversationPage> };
    'directory.list': { params: NoParams; result: Receipt<Directory> };
    'composer.mention': { params: MentionRequest; result: MentionReceipt };
    'composer.send': { params: SendRequest; result: SendReceipt };
    'composer.insertText': { params: InsertTextOptions; result: Acknowledgement };
    'composer.expand': { params: NoParams; result: Receipt<{ state: 'pinned' | 'rail' }> };
    'composer.collapse': { params: NoParams; result: Receipt<{ state: 'rail' }> };
    'settings.get': { params: SettingsReadOptions; result: Receipt<Settings> };
    'settings.update': { params: SettingsUpdateOptions; result: Receipt<Settings> };
    'automation.create': { params: AutomationRequest; result: Receipt<AutomationCreated> };
    'data.apps': { params: NoParams; result: Receipt<{ apps: DataApp[]; remoteUnavailable: boolean }> };
    'data.get': { params: DataGetOptions; result: Receipt<{ item: DataRecord | null; revision: number }> };
    'data.list': { params: DataListOptions; result: Receipt<{ items: DataRecord[]; next: string | null }> };
    'data.batch': { params: DataBatchOptions; result: Receipt<{ items: (DataRecord | DeletedRecord)[] }> };
    'data.assetPut': { params: AssetPutOptions; result: Receipt<{ asset: Asset }> };
    'data.assetGet': { params: AssetGetOptions; result: Receipt<AssetContent> };
    'mcp.connect': { params: McpConnectOptions; result: Receipt<{ connected: boolean; server: string }> };
    'attachments.pick': { params: NoParams; result: Receipt<{ items: Attachment[] }> };
    'attachments.begin': { params: AttachmentBeginOptions; result: Receipt<{ id: string; chunkBytes: number }> };
    'attachments.append': { params: AttachmentAppendOptions; result: Receipt<{ written: number }> };
    'attachments.finish': { params: { id: string }; result: Receipt<{ item: Attachment }> };
    'attachments.release': { params: { ids: string[] }; result: Acknowledgement };
    'attachments.check': { params: { ids: string[] }; result: Receipt<{ items: Attachment[] }> };
  }
  type Method = keyof RequestMap;
  type Result<M extends Method> = RequestMap[M]['result'];
  type RequestArguments<M extends Method> = {} extends RequestMap[M]['params']
    ? [params?: RequestMap[M]['params']]
    : [params: RequestMap[M]['params']];

  interface SDK {
    readonly version: '1.7.0';
    configure(options?: ConfigureOptions): void;
    createRequestId(): string;
    /** Transport errors may reject; ok:false and uncertain receipts remain explicit. */
    request<M extends Method>(method: M, ...args: RequestArguments<M>): Promise<Result<M>>;
    readonly context: Readonly<{ get(): Promise<Result<'context.get'>> }>;
    readonly user: Readonly<{ getCurrent(): Promise<Result<'user.getCurrent'>> }>;
    readonly notifications: Readonly<{ list(options?: NotificationsOptions): Promise<Result<'notifications.list'>> }>;
    readonly library: Readonly<{
      list(options?: LibraryListOptions): Promise<Result<'library.list'>>;
      read(options: LibraryReadOptions): Promise<Result<'library.read'>>;
    }>;
    readonly conversations: Readonly<{
      list(options?: ConversationsOptions): Promise<Result<'conversations.list'>>;
      messages(options: MessagesOptions): Promise<Result<'conversations.messages'>>;
    }>;
    readonly directory: Readonly<{ list(): Promise<Result<'directory.list'>> }>;
    readonly chat: Readonly<{
      send(options: SendOptions): Promise<SendReceipt>;
      mention(options?: MentionOptions): Promise<MentionReceipt>;
      insertText(options: InsertTextOptions): Promise<Acknowledgement>;
      expand(): Promise<Result<'composer.expand'>>;
      collapse(): Promise<Result<'composer.collapse'>>;
    }>;
    readonly settings: Readonly<{
      get(options?: SettingsReadOptions): Promise<Result<'settings.get'>>;
      update(options?: SettingsUpdateOptions): Promise<Result<'settings.update'>>;
    }>;
    readonly automation: Readonly<{ create(options: AutomationOptions): Promise<Result<'automation.create'>> }>;
    readonly ai: Readonly<{ generate(options: GenerateOptions): Promise<GenerateReceipt> }>;
    readonly data: Readonly<{
      apps(): Promise<Result<'data.apps'>>;
      get(options: DataGetOptions): Promise<Result<'data.get'>>;
      list(options: DataListOptions): Promise<Result<'data.list'>>;
      batch(options: DataBatchOptions): Promise<Result<'data.batch'>>;
      assetPut(options: AssetPutOptions): Promise<Result<'data.assetPut'>>;
      assetGet(options: AssetGetOptions): Promise<Result<'data.assetGet'>>;
    }>;
    readonly mcp: Readonly<{ connect(options: McpConnectOptions): Promise<Result<'mcp.connect'>> }>;
    readonly attachments: Readonly<{
      pick(): Promise<Result<'attachments.pick'>>;
      /** Resolves to one attachment directly; transfer failures reject. */
      importFile(file: FileLike, options?: AttachmentImportOptions): Promise<Attachment>;
      release(ids: string[]): Promise<Acknowledgement>;
      check(ids: string[]): Promise<Result<'attachments.check'>>;
    }>;
    readonly files: Readonly<{
      pickLocal(): Promise<Result<'files.pickLocal'>>;
      copyLocal(options: FileCopyOptions): Promise<FileReceipt>;
      /** A complete persistent-file receipt, distinct from a temporary attachment. */
      importFile(file: FileLike, options: FileImportOptions): Promise<FileReceipt>;
      getUrl(options: FileGetOptions): Promise<FileReceipt>;
    }>;
    readonly events: Readonly<{
      /** A settled turn may have failed or been cancelled; this is a refresh hint. */
      onRefresh(callback: (event: TurnSettledEvent) => void): Unsubscribe;
      onTurnSettled(callback: (event: TurnSettledEvent) => void): Unsubscribe;
      onDataChanged(callback: (event: DataChangedEvent) => void): Unsubscribe;
    }>;
  }
}

declare const soduWorkApp: SoduWorkApp.SDK;
interface Window { readonly soduWorkApp: SoduWorkApp.SDK; }
