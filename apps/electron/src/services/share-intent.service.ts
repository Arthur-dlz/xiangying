import { provide } from "@inversifyjs/binding-decorators";
import { SHARE_INTENT_TTL_MS, type ShareIntent } from "@mediago/common";
import { injectable } from "inversify";
import { defaultScheme } from "../constants";
import { parseShareIntentProtocolUrl } from "./share-intent-parser";

const MAX_PENDING_INTENTS = 20;
const DEDUP_WINDOW_MS = 2_000;

export interface ExternalInvocationResult {
  handled: boolean;
  queued: number;
}

@injectable()
@provide()
export default class ShareIntentService {
  private pending: ShareIntent[] = [];
  private readonly recent = new Map<string, number>();

  handleCommandLine(commandLine: readonly string[]): ExternalInvocationResult {
    let handled = false;
    let queued = 0;

    commandLine.forEach((argument) => {
      if (!this.looksLikeMediaGoUrl(argument)) return;
      const result = this.handleProtocolUrl(argument);
      handled ||= result.handled;
      queued += result.queued;
    });

    return { handled, queued };
  }

  handleProtocolUrl(rawUrl: string): ExternalInvocationResult {
    const parsed = parseShareIntentProtocolUrl(rawUrl, defaultScheme);
    if (!parsed.handled) return { handled: false, queued: 0 };
    if (!parsed.intent) return { handled: true, queued: 0 };
    if (!this.enqueue(parsed.intent)) return { handled: true, queued: 0 };
    return { handled: true, queued: 1 };
  }

  drain(): ShareIntent[] {
    const now = Date.now();
    const result = this.pending.filter(
      (intent) => now - intent.createdAt <= SHARE_INTENT_TTL_MS,
    );
    this.pending = [];
    return result;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  private enqueue(intent: ShareIntent): boolean {
    const now = Date.now();
    for (const [key, timestamp] of this.recent) {
      if (now - timestamp > DEDUP_WINDOW_MS) this.recent.delete(key);
    }

    const dedupKey = `${intent.url}\u0000${intent.name || ""}\u0000${intent.type}`;
    const previous = this.recent.get(dedupKey);
    if (previous && now - previous <= DEDUP_WINDOW_MS) return false;

    this.recent.set(dedupKey, now);
    if (this.pending.length >= MAX_PENDING_INTENTS) this.pending.shift();
    this.pending.push(intent);
    return true;
  }

  private looksLikeMediaGoUrl(value: string): boolean {
    return value
      .trim()
      .toLowerCase()
      .startsWith(`${defaultScheme.toLowerCase()}://`);
  }
}
