import type { EventHub } from "../hub";
import type { RepoEntry } from "../repos";
import type { Doc, LiveAgent, WorkstreamSnapshot } from "../shared/types";
import type { EtapiNote, TriliumClient } from "./client";
import { fingerprint, labelsOf, toAgentRun, toDoc, toMilestone, toProject, toReview, toTask, toWorkstream } from "./mapper";

export interface PollerDeps { client: TriliumClient; hub: EventHub; live: () => LiveAgent[]; now?: () => Date }

export class Poller {
  private snap: WorkstreamSnapshot | null = null;
  private err: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private projectId: string | undefined;
  private activeSlug: string | undefined;
  private intervalMs: number;

  constructor(private repo: RepoEntry, private deps: PollerDeps, opts: { intervalMs?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? 3000;
    this.projectId = repo.projectNoteId;
    this.activeSlug = repo.activeWorkstream;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): WorkstreamSnapshot | null { return this.snap; }
  lastError(): string | null { return this.err; }

  selectWorkstream(slug: string): Promise<boolean> {
    this.activeSlug = slug;
    return this.refresh();
  }

  refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const p = this.doRefresh().finally(() => { this.inFlight = null; });
    this.inFlight = p;
    return p;
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const { client } = this.deps;
      let projectNote: EtapiNote | undefined;
      if (this.projectId) projectNote = await client.getNote(this.projectId);
      else {
        projectNote = (await client.search(`#factoryProject #repoPath='${this.repo.repoPath.replace(/'/g, "\\'")}'`))[0];
        if (projectNote) this.projectId = projectNote.noteId;
      }
      if (!projectNote) throw new Error(`project note not found for ${this.repo.repoPath}`);
      const pid = projectNote.noteId;

      const wsNotes = await client.search("#factoryWorkstream", { ancestorNoteId: pid });
      const wsNote = (this.activeSlug && wsNotes.find((n) => (labelsOf(n).slug ?? n.title) === this.activeSlug)) || wsNotes[0];

      let milestones: EtapiNote[] = [], tasks: EtapiNote[] = [], wsDocs: EtapiNote[] = [], reviews: EtapiNote[] = [];
      if (wsNote) {
        const o = { ancestorNoteId: wsNote.noteId };
        milestones = await client.search("#factoryMilestone", o);
        tasks = await client.search("#factoryTask", o);
        wsDocs = await client.search("#factoryDoc", o);
        reviews = await client.search("#factoryReview", o);
      }
      const runs = await client.search("#factoryAgentRun", { ancestorNoteId: pid, orderBy: "utcDateModified", orderDirection: "desc", limit: 200 });
      const projDocs = await client.search("#factoryDoc", { ancestorNoteId: pid, ancestorDepth: "eq1" });

      const seen = new Set<string>();
      const docNotes = [...wsDocs, ...projDocs].filter((n) => !seen.has(n.noteId) && !!seen.add(n.noteId));
      const all = [projectNote, ...wsNotes, ...milestones, ...tasks, ...docNotes, ...reviews, ...runs];
      const fp = fingerprint(all);
      this.err = null;
      if (this.snap && this.snap.fingerprint === fp) return false;

      const docs: Doc[] = docNotes.map(toDoc);
      this.snap = {
        project: toProject(projectNote),
        workstream: wsNote ? toWorkstream(wsNote) : null,
        milestones: milestones.map(toMilestone),
        tasks: tasks.map(toTask),
        docs,
        reviews: reviews.map(toReview),
        runs: runs.map(toAgentRun),
        live: this.deps.live(),
        fingerprint: fp,
      };
      this.deps.hub.publish(this.repo.repoPath, { type: "snapshot", data: this.snap });
      return true;
    } catch (e) {
      this.err = e instanceof Error ? e.message : String(e);
      return false;
    }
  }
}
