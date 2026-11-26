/**
 * 案件チャットの接続管理（WebSocket + 取りこぼしの取得 + 定期取得への切り替え）。
 *
 * React から独立させ、WebSocket・API・可視状態を差し込めるようにしてある（単体テスト用）。
 * WebSocket は「新着の合図」だけを運び、本文は必ず HTTP で取り直す。
 */
import {
  FALLBACK_POLL_MS,
  MAX_CONNECT_FAILURES,
  PAGE_SIZE,
  PING_INTERVAL_MS,
  backoffDelay,
  knowsCursor,
  latestCursor,
  mergeMessages,
  type MessageView,
} from './chatLogic';

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ChatApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export interface ChatDeps {
  api: ChatApi;
  createSocket: (url: string) => SocketLike;
  isVisible: () => boolean;
  random?: () => number;
  /** ticket 取得で「チャット基盤が無い」と分かったときの判定（503 CHAT_UNAVAILABLE） */
  isUnavailable: (error: unknown) => boolean;
}

export interface ChatState {
  messages: MessageView[];
  connected: boolean;
  degraded: boolean;
  hasOlder: boolean;
}

interface Page {
  items: MessageView[];
  hasMore: boolean;
}

/** 取りこぼしを埋める取得の上限回数（50件 × 回数）。これを超える分は次の接続で埋める。 */
const MAX_CATCH_UP_PAGES = 5;

export class ChatConnection {
  private state: ChatState;
  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private connecting = false;
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unavailable = false;
  private started = false;
  private catchingUp = false;
  private catchUpAgain = false;

  constructor(
    private readonly caseId: string,
    initial: { messages: MessageView[]; hasOlder: boolean },
    private readonly deps: ChatDeps,
  ) {
    this.state = {
      messages: initial.messages,
      connected: false,
      degraded: false,
      hasOlder: initial.hasOlder,
    };
  }

  getState = (): ChatState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private path(suffix = '') {
    return `/api/cases/${this.caseId}/messages${suffix}`;
  }

  start() {
    this.started = true;
    if (this.deps.isVisible()) void this.connect();
  }

  stop() {
    this.started = false;
    this.teardown();
  }

  /** タブの表示・非表示。隠れている間は接続も定期取得も止める。 */
  onVisibilityChange() {
    if (!this.started) return;
    if (!this.deps.isVisible()) {
      this.teardown();
      return;
    }
    this.failures = 0;
    this.resume();
  }

  /** 回線が戻ったとき。待たずにすぐつなぎ直す。 */
  onOnline() {
    if (!this.started || !this.deps.isVisible()) return;
    this.failures = 0;
    this.resume();
  }

  private resume() {
    if (this.unavailable) {
      this.startPolling();
      void this.catchUp();
    } else {
      this.clearReconnect();
      void this.connect();
    }
  }

  private teardown() {
    this.clearReconnect();
    this.stopPing();
    this.stopPolling();
    const socket = this.socket;
    this.socket = null;
    this.connecting = false;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    if (this.state.connected) this.set({ connected: false });
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.deps.isVisible()) return;
      void this.catchUp();
      // 基盤はあるのに接続できなかった場合は、30秒ごとに1回だけつなぎ直しを試す
      if (!this.unavailable) void this.connect();
    }, FALLBACK_POLL_MS);
  }

  private enterFallback(unavailable: boolean) {
    this.unavailable = unavailable;
    this.set({ degraded: true });
    this.startPolling();
    void this.catchUp();
  }

  private async connect() {
    if (this.socket || this.connecting || !this.started || !this.deps.isVisible()) return;
    this.connecting = true;
    try {
      const { url } = await this.deps.api.post<{ url: string; expiresIn: number }>(
        this.path('/ticket'),
      );
      if (!this.connecting || !this.started || !this.deps.isVisible()) return;
      this.open(url);
    } catch (error) {
      if (!this.connecting) return;
      this.connecting = false;
      if (this.deps.isUnavailable(error)) this.enterFallback(true);
      else this.connectFailed();
    }
  }

  private open(url: string) {
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(url);
    } catch {
      this.connecting = false;
      this.connectFailed();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.connecting = false;
      this.failures = 0;
      this.stopPolling();
      this.unavailable = false;
      this.set({ connected: true, degraded: false });
      this.stopPing();
      this.pingTimer = setInterval(() => this.socket?.send('ping'), PING_INTERVAL_MS);
      void this.catchUp();
    };
    socket.onmessage = (event) => this.onSignal(event.data);
    socket.onclose = () => {
      const wasOpen = this.state.connected;
      this.socket = null;
      this.connecting = false;
      this.stopPing();
      this.set({ connected: false });
      if (!this.started || !this.deps.isVisible()) return;
      // つながっていたものが切れたときは数えず1秒から。つながらなかったときは失敗に数える
      if (wasOpen) this.scheduleReconnect();
      else this.connectFailed();
    };
    socket.onerror = () => {
      // 失敗の扱いは onclose に任せる
    };
  }

  private connectFailed() {
    this.failures += 1;
    if (this.failures >= MAX_CONNECT_FAILURES) {
      this.enterFallback(false);
      return;
    }
    if (!this.state.degraded) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    this.clearReconnect();
    const delay = backoffDelay(Math.max(this.failures - 1, 0), this.deps.random);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private onSignal(data: unknown) {
    if (typeof data !== 'string') return;
    let signal: { type?: unknown; cursor?: unknown };
    try {
      signal = JSON.parse(data);
    } catch {
      return;
    }
    if (signal.type === 'message') {
      if (typeof signal.cursor === 'string' && knowsCursor(this.state.messages, signal.cursor)) {
        return;
      }
      void this.catchUp();
    } else if (signal.type === 'retract') {
      void this.refreshLatest();
    }
  }

  /** 手元の最新より後ろを取り込む。実行中に重なった要求は1回にまとめて、終わってからもう一度。 */
  async catchUp() {
    if (this.catchingUp) {
      this.catchUpAgain = true;
      return;
    }
    this.catchingUp = true;
    try {
      do {
        this.catchUpAgain = false;
        for (let page = 0; page < MAX_CATCH_UP_PAGES; page += 1) {
          const cursor = latestCursor(this.state.messages);
          const query = cursor
            ? `?after=${encodeURIComponent(cursor)}&limit=${PAGE_SIZE}`
            : `?limit=${PAGE_SIZE}`;
          const { items, hasMore } = await this.deps.api.get<Page>(this.path(query));
          if (items.length > 0) this.set({ messages: mergeMessages(this.state.messages, items) });
          if (!hasMore || items.length === 0) break;
        }
      } while (this.catchUpAgain);
    } catch {
      // 次の通知・接続・定期取得で取り直す
    } finally {
      this.catchingUp = false;
    }
  }

  /** 取り消しの反映。直近50件を取り直し、同じ id は置き換える。 */
  private async refreshLatest() {
    try {
      const { items } = await this.deps.api.get<Page>(this.path(`?limit=${PAGE_SIZE}`));
      this.set({ messages: mergeMessages(this.state.messages, items) });
    } catch {
      // 次の機会に取り直す
    }
  }

  async send(body: string): Promise<MessageView> {
    const message = await this.deps.api.post<MessageView>(this.path(), { body });
    this.set({ messages: mergeMessages(this.state.messages, [message]) });
    return message;
  }

  async retract(id: string): Promise<void> {
    await this.deps.api.del(`/api/messages/${id}`);
    const target = this.state.messages.find((m) => m.id === id);
    if (target) {
      const done = { ...target, retracted: true, body: null };
      this.set({ messages: mergeMessages(this.state.messages, [done]) });
    }
  }

  async loadOlder(): Promise<void> {
    const first = this.state.messages[0];
    if (!first) return;
    const { items, hasMore } = await this.deps.api.get<Page>(
      this.path(`?before=${encodeURIComponent(first.cursor)}&limit=${PAGE_SIZE}`),
    );
    this.set({ messages: mergeMessages(this.state.messages, items), hasOlder: hasMore });
  }
}
