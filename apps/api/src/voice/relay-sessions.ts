/**
 * Remembers which conversations have already opened a live voice session, so the
 * one-time address Twilio is given cannot be used to open a second one (for example
 * if it leaked into a log): a conversation gets ONE session, ever.
 *
 * Kept in this process's memory, like the rate limits. With several API instances
 * behind a load balancer this must move to a shared store before being relied on.
 */
export class RelaySessions {
  private readonly opened = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True the first time a conversation asks, false for every later request until the record expires. */
  tryOpen(conversationId: string): boolean {
    const current = this.now();
    for (const [id, at] of this.opened) {
      if (current - at >= this.ttlMs) this.opened.delete(id);
    }
    if (this.opened.has(conversationId)) {
      return false;
    }
    this.opened.set(conversationId, current);
    return true;
  }
}
