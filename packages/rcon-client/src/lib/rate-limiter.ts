function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enforces a minimum delay between outgoing packets — CoD2 RCON is spoofable/floodable
 * (docs/PLAN.md §2.4/§8), so the gateway must throttle its own outgoing rate regardless of
 * how many commands are queued up (e.g. a burst of Telegram button clicks).
 */
export class RateLimiter {
  private lastSendAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const elapsed = Date.now() - this.lastSendAt;
    const delay = this.minIntervalMs - elapsed;
    if (delay > 0) {
      await sleep(delay);
    }
    this.lastSendAt = Date.now();
  }
}
