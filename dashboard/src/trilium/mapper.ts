import { createHash } from "node:crypto";
import type { AgentRun, Doc, Labels, Milestone, Project, Review, Reviewer, Task, TaskStatus, Workstream } from "../shared/types";
import type { EtapiNote } from "./client";

const STATUSES: readonly TaskStatus[] = ["todo", "spec", "building", "reviewing", "fixing", "approving", "merging", "done", "needs-human", "blocked"];

export function labelsOf(note: EtapiNote): Labels {
  const out: Labels = {};
  for (const a of note.attributes ?? []) if (a.type === "label") out[a.name] = a.value;
  return out;
}

const int = (s: string | undefined): number => {
  const n = parseInt(s ?? "", 10);
  return Number.isNaN(n) ? 0 : n;
};

export function toProject(n: EtapiNote): Project {
  const l = labelsOf(n);
  return { id: n.noteId, title: n.title, repo: l.repo ?? n.title, repoPath: l.repoPath ?? "", labels: l, modified: n.utcDateModified };
}

export function toWorkstream(n: EtapiNote): Workstream {
  const l = labelsOf(n);
  return { id: n.noteId, slug: l.slug ?? n.title, title: n.title, status: l.wsStatus ?? "", labels: l, modified: n.utcDateModified };
}

export function toMilestone(n: EtapiNote): Milestone {
  const l = labelsOf(n);
  return { id: n.noteId, milestoneId: l.milestoneId ?? "", title: n.title, order: int(l.order), status: l.status ?? "todo", modified: n.utcDateModified };
}

export function toTask(n: EtapiNote): Task {
  const l = labelsOf(n);
  const status = (STATUSES as readonly string[]).includes(l.status) ? (l.status as TaskStatus) : "todo";
  const t: Task = {
    id: n.noteId,
    taskId: l.taskId ?? "",
    title: n.title,
    status,
    milestoneId: l.milestoneId ?? "",
    order: int(l.order),
    round: int(l.round),
    dependsOn: (l.dependsOn ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    modified: n.utcDateModified,
  };
  if (l.agentId) t.agentId = l.agentId;
  if (l.builderAgentId) t.builderAgentId = l.builderAgentId;
  if (l.escalation) t.escalation = l.escalation;
  return t;
}

export function toDoc(n: EtapiNote): Doc {
  const l = labelsOf(n);
  // defensive: orchestrator writes text notes; markdown branch kept for hand-made notes
  const format = n.type === "text" ? "html" : (n.mime ?? "").includes("markdown") ? "markdown" : "html";
  const d: Doc = { id: n.noteId, kind: l.factoryDoc || "unknown", title: n.title, format, modified: n.utcDateModified };
  if (n.parentNoteIds?.[0]) d.parentId = n.parentNoteIds[0];
  return d;
}

/** A validation `Round <N>` note (`#factoryValidation`, not `#factoryDoc`), listed under the Validation tab. */
export function toValidationDoc(n: EtapiNote): Doc {
  return { ...toDoc(n), kind: "validation", round: int(labelsOf(n).round) };
}

export function toReview(n: EtapiNote): Review {
  const l = labelsOf(n);
  const reviewer = (l.reviewer ?? "") as Reviewer;
  const verdict = l.verdict === "PASS" || l.verdict === "CHANGES" ? l.verdict : "PENDING";
  return { id: n.noteId, taskId: l.taskId ?? "", round: int(l.round), reviewer, verdict, modified: n.utcDateModified };
}

export function toAgentRun(n: EtapiNote): AgentRun {
  const l = labelsOf(n);
  const status = l.status === "done" || l.status === "failed" ? l.status : "running";
  const r: AgentRun = { id: n.noteId, title: n.title, agentType: l.agentType ?? "", status };
  if (l.agentId) r.agentId = l.agentId;
  if (l.taskId) r.taskId = l.taskId;
  if (l.startedAt) r.startedAt = l.startedAt;
  if (l.endedAt) r.endedAt = l.endedAt;
  return r;
}

export function fingerprint(notes: EtapiNote[]): string {
  const lines = notes.map((n) => {
    const l = labelsOf(n);
    return `${n.noteId}|${n.utcDateModified}|${l.status ?? ""}|${l.agentId ?? ""}|${l.round ?? ""}`;
  });
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
