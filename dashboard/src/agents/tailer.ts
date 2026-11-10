import { closeSync, existsSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Step } from "../shared/types";
import { parseTranscript } from "./parser";

const CAP = 2000;

export class TranscriptTailer {
  readonly steps: Step[] = [];
  state: "waiting" | "tailing" | "stopped" | "gone" = "waiting";
  /** True once the file was found and tailing began (it stays true after `stop()`). */
  found = false;
  /** When a read last found new bytes (the injected clock), for the idle sweep; undefined until then. */
  lastGrowthAt?: number;
  private count = 0;
  private offset = 0;
  private rest = "";
  private decoder = new StringDecoder("utf8");
  private reading = false;
  private retries = 0;
  private timer?: ReturnType<typeof setInterval>;
  private watcher?: FSWatcher;
  private pollMs: number;
  private retryMs: number;
  private maxRetries: number;
  private now: () => number;

  private resolve: () => string | null;
  path: string | null;

  constructor(pathOrResolve: string | (() => string | null), private onStep: (s: Step) => void, opts: { pollMs?: number; retryMs?: number; maxRetries?: number; now?: () => number } = {}) {
    this.resolve = typeof pathOrResolve === "function" ? pathOrResolve : () => pathOrResolve;
    this.path = this.resolve();
    this.pollMs = opts.pollMs ?? 500;
    this.retryMs = opts.retryMs ?? 1000;
    this.maxRetries = opts.maxRetries ?? 30;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.state === "stopped" || this.timer) return;
    if (this.path && existsSync(this.path)) { this.begin(); return; }
    this.state = "waiting";
    this.timer = setInterval(() => {
      this.path = this.resolve() ?? this.path;
      if (this.path && existsSync(this.path)) { this.clearTimer(); this.begin(); }
      else if (++this.retries >= this.maxRetries) { this.clearTimer(); this.state = "gone"; }
    }, this.retryMs);
    this.timer.unref?.();
  }

  private begin(): void {
    this.state = "tailing";
    this.found = true;
    try {
      this.watcher = watch(this.path!, () => this.readMore());
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
    } catch { /* poll fallback */ }
    this.timer = setInterval(() => this.readMore(), this.pollMs);
    this.timer.unref?.();
    this.readMore();
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Read whatever was appended since the last call. Guarded against re-entrancy. */
  readMore(): void {
    if (this.reading || this.state === "stopped" || !this.path) return;
    this.reading = true;
    try {
      const size = statSync(this.path).size;
      if (size < this.offset) { this.offset = 0; this.rest = ""; this.decoder = new StringDecoder("utf8"); }
      if (size === this.offset) return;
      const fd = openSync(this.path, "r");
      let chunk = "";
      try {
        const buf = Buffer.alloc(size - this.offset);
        const n = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += n;
        if (n > 0) this.lastGrowthAt = this.now();
        chunk = this.decoder.write(buf.subarray(0, n));
      } finally { closeSync(fd); }
      const { steps, rest } = parseTranscript(this.rest + chunk);
      this.rest = rest;
      steps.forEach((s, i) => {
        const step = { ...s, seq: this.count + i };
        this.steps.push(step);
        try { this.onStep(step); } catch { /* subscriber error */ }
      });
      this.count += steps.length;
      if (this.steps.length > CAP) this.steps.splice(0, this.steps.length - CAP);
    } catch { /* file vanished or unreadable; try again next tick */ }
    finally { this.reading = false; }
  }

  stop(): void {
    this.clearTimer();
    this.watcher?.close();
    this.watcher = undefined;
    this.state = "stopped";
  }

  readAll(): Step[] { return [...this.steps]; }
}
