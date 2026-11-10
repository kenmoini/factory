import type { StreamEvent } from "./shared/types";

type Fn = (e: StreamEvent) => void;

export class EventHub {
  private subs = new Map<string, Set<Fn>>();

  subscribe(repoKey: string, fn: Fn): () => void {
    let set = this.subs.get(repoKey);
    if (!set) this.subs.set(repoKey, (set = new Set()));
    // wrap so the same fn subscribed twice yields two independent subscriptions
    const wrapped: Fn = (e) => fn(e);
    set.add(wrapped);
    return () => {
      const s = this.subs.get(repoKey);
      if (!s) return;
      s.delete(wrapped);
      if (s.size === 0) this.subs.delete(repoKey);
    };
  }

  publish(repoKey: string, e: StreamEvent): void {
    for (const fn of [...(this.subs.get(repoKey) ?? [])]) {
      try { fn(e); } catch { /* a bad subscriber must not break others */ }
    }
  }

  count(repoKey: string): number { return this.subs.get(repoKey)?.size ?? 0; }
}
