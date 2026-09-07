import type { GithubRelease } from './github-releases.js';

export interface PendingUpdate {
  release: GithubRelease;
}

/**
 * In-memory pending-confirmation state for `/update` (docs/PLAN.md §13.3), structurally identical
 * to `ReportRegistry` (reports.ts) — a short id (embedded in `callback_data`, well under
 * Telegram's 64-byte limit) mapped to the pending release, so nothing sensitive (a download URL)
 * ever needs to round-trip through `callback_data` itself. No chat/message id is tracked here —
 * unlike `ReportRegistry`, `/update`'s Confirm/Cancel buttons only ever get edited from within
 * the same callback context that received the tap, so grammy's implicit edit target is enough.
 * Not persisted — a gateway restart just means a pending Update/Cancel card stops working, same
 * restart caveat as every other in-memory registry in this codebase.
 */
export class UpdateRegistry {
  private readonly pending = new Map<string, PendingUpdate>();
  private nextId = 1;

  reserveId(): string {
    return String(this.nextId++);
  }

  set(id: string, update: PendingUpdate): void {
    this.pending.set(id, update);
  }

  get(id: string): PendingUpdate | undefined {
    return this.pending.get(id);
  }

  delete(id: string): void {
    this.pending.delete(id);
  }
}
