function safeString(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

export type InboundRecoveryGateEntry<T> = {
  key: string;
  item: T;
};

export class InboundRecoveryGate<T> {
  private discovering = false;
  private readonly recoveringKeys = new Set<string>();
  private entries: Array<InboundRecoveryGateEntry<T>> = [];

  begin() {
    this.discovering = true;
    this.recoveringKeys.clear();
  }

  configure(keys: Iterable<string>) {
    this.discovering = false;
    this.recoveringKeys.clear();
    for (const key of keys) {
      const normalized = safeString(key).trim();
      if (normalized) this.recoveringKeys.add(normalized);
    }
    const readyKeys: string[] = [];
    const seenReadyKeys = new Set<string>();
    for (const entry of this.entries) {
      if (this.recoveringKeys.has(entry.key)) continue;
      this.recoveringKeys.add(entry.key);
      if (!seenReadyKeys.has(entry.key)) {
        seenReadyKeys.add(entry.key);
        readyKeys.push(entry.key);
      }
    }
    return readyKeys;
  }

  buffer(key: string, item: T) {
    const normalized = safeString(key).trim();
    if (!this.discovering && !this.recoveringKeys.has(normalized)) return false;
    this.entries.push({ key: normalized, item });
    return true;
  }

  drain(key: string) {
    const normalized = safeString(key).trim();
    const drained: T[] = [];
    const pending: Array<InboundRecoveryGateEntry<T>> = [];
    for (const entry of this.entries) {
      if (entry.key === normalized) drained.push(entry.item);
      else pending.push(entry);
    }
    this.entries = pending;
    return drained;
  }

  prepend(key: string, items: T[]) {
    if (!items.length) return;
    const normalized = safeString(key).trim();
    this.recoveringKeys.add(normalized);
    this.entries.unshift(...items.map((item) => ({ key: normalized, item })));
  }

  hasPending(key?: string) {
    if (key === undefined) return this.entries.length > 0;
    const normalized = safeString(key).trim();
    return this.entries.some((entry) => entry.key === normalized);
  }

  open(key: string) {
    const normalized = safeString(key).trim();
    if (this.hasPending(normalized)) {
      throw new Error(
        `Inbound recovery gate still has buffered messages for ${normalized}`,
      );
    }
    this.recoveringKeys.delete(normalized);
  }

  isBuffering(key?: string) {
    if (key === undefined) {
      return this.discovering || this.recoveringKeys.size > 0;
    }
    const normalized = safeString(key).trim();
    return this.discovering || this.recoveringKeys.has(normalized);
  }
}

export function applyInboundRecoveryResult(
  bot: any,
  logger: any,
  result: {
    failures: string[];
    deferred: string[];
    retired: string[];
  },
) {
  if (result.retired.length) {
    logger?.info?.(
      `inbound recovery retired checkpoints=${JSON.stringify(result.retired)}`,
    );
  }
  const pending = [
    ...result.failures,
    ...result.deferred.map((chatKey) => `${chatKey}:recovery_deferred`),
  ];
  bot.inboundRecovery = pending.length
    ? { status: "degraded", failures: pending }
    : { status: "ready" };
  if (result.failures.length) {
    logger?.warn?.(
      `inbound recovery degraded failures=${JSON.stringify(result.failures)}`,
    );
  }
}
