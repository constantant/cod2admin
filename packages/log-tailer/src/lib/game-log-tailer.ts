import { EventEmitter } from 'node:events';
import { detectReportTrigger, parseChatLine } from './chat-parser.js';
import { FileTailer } from './file-tailer.js';
import { parseSessionEventLine } from './session-event-parser.js';
import { SessionTracker, type SessionTrackerOptions } from './session-tracker.js';
import type { ChatEvent, PlayerSession, ReportTrigger } from './types.js';

export interface GameLogTailerOptions {
  /** Path to `games_mp.log` (docs/PLAN.md §11.1's `COD2_LOG_PATH`). */
  logPath: string;
  pollIntervalMs?: number;
  chatHistorySize?: number;
  /** Test hook — overrides the tracker's clock. Not meant for production use. */
  now?: SessionTrackerOptions['now'];
}

/**
 * Ties `FileTailer` (raw line-by-line file following) to the `games_mp.log` line parsers and
 * `SessionTracker` (docs/PLAN.md §5 steps 1/3): the single entry point report-pipeline consumes
 * for `!report` detection plus live session state.
 */
export class GameLogTailer extends EventEmitter {
  private readonly fileTailer: FileTailer;
  private readonly sessions: SessionTracker;

  constructor(options: GameLogTailerOptions) {
    super();
    this.sessions = new SessionTracker({ chatHistorySize: options.chatHistorySize, now: options.now });
    this.fileTailer = new FileTailer({
      path: options.logPath,
      pollIntervalMs: options.pollIntervalMs,
      onLine: (line) => this.handleLine(line),
      onError: (error) => this.emitTyped('error', error),
    });
  }

  async start(): Promise<void> {
    await this.fileTailer.start();
  }

  stop(): void {
    this.fileTailer.stop();
  }

  getSession(num: number): PlayerSession | undefined {
    return this.sessions.getSession(num);
  }

  listSessions(): PlayerSession[] {
    return this.sessions.listSessions();
  }

  override on(event: 'chat', listener: (chat: ChatEvent) => void): this;
  override on(event: 'reportTrigger', listener: (trigger: ReportTrigger) => void): this;
  override on(event: 'connect' | 'disconnect', listener: (session: PlayerSession) => void): this;
  override on(event: 'error', listener: (error: Error) => void): this;
  // `any[]` here (not `unknown[]`) to match EventEmitter's own `on` signature, or TS rejects
  // this as an incompatible implementation for the typed overloads above.
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private handleLine(line: string): void {
    const chat = parseChatLine(line);
    if (chat) {
      this.sessions.handleChat(chat);
      this.emitTyped('chat', chat);
      const trigger = detectReportTrigger(chat);
      if (trigger) {
        this.emitTyped('reportTrigger', trigger);
      }
      return;
    }

    const sessionEvent = parseSessionEventLine(line);
    if (sessionEvent) {
      const session = this.sessions.handleSessionEvent(sessionEvent);
      this.emitTyped(sessionEvent.kind, session);
    }
  }

  private emitTyped(event: 'chat', chat: ChatEvent): void;
  private emitTyped(event: 'reportTrigger', trigger: ReportTrigger): void;
  private emitTyped(event: 'connect' | 'disconnect', session: PlayerSession): void;
  private emitTyped(event: 'error', error: Error): void;
  private emitTyped(event: string, payload: unknown): void {
    this.emit(event, payload);
  }
}
