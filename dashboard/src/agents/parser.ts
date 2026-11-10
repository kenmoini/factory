import type { Step } from "../shared/types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);

export function summarizeTool(name: string, input: unknown): string {
  const i: Obj = isObj(input) ? input : {};
  switch (name) {
    case "Bash":
      return str(i.description) || clip(str(i.command));
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
    case "MultiEdit":
      return str(i.file_path);
    case "Glob":
    case "Grep": {
      const p = str(i.pattern);
      const path = str(i.path);
      return path ? `${p} in ${path}` : p;
    }
    case "Agent":
      return str(i.description);
    case "WebFetch":
      return str(i.url);
    case "WebSearch":
      return str(i.query);
    case "Skill":
      return str(i.skill);
    default:
      if (input === undefined || input === null) return "";
      try {
        return (JSON.stringify(input) ?? "").slice(0, 80);
      } catch {
        return "";
      }
  }
}

export function parseLine(line: string, seq: number): Step[] {
  try {
    if (!line.trim()) return [];
    const d: unknown = JSON.parse(line);
    if (!isObj(d) || (d.type !== "assistant" && d.type !== "user")) return [];
    const ts = str(d.timestamp) || new Date().toISOString();
    const content = isObj(d.message) ? d.message.content : undefined;
    if (!Array.isArray(content)) return [];
    const steps: Step[] = [];
    for (const b of content) {
      if (!isObj(b)) continue;
      const base = { seq: seq + steps.length, ts };
      if (d.type === "assistant") {
        if (b.type === "text") steps.push({ ...base, kind: "text", text: str(b.text) });
        else if (b.type === "thinking") steps.push({ ...base, kind: "thinking" });
        else if (b.type === "tool_use") {
          const name = str(b.name);
          steps.push({ ...base, kind: "tool", tool: { name, summary: summarizeTool(name, b.input) }, toolUseId: str(b.id) });
        }
      } else if (b.type === "tool_result") {
        steps.push({ ...base, kind: "result", toolUseId: str(b.tool_use_id), isError: !!b.is_error });
      }
    }
    return steps;
  } catch {
    return [];
  }
}

export function parseTranscript(text: string): { steps: Step[]; rest: string } {
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  const steps: Step[] = [];
  for (const line of parts) steps.push(...parseLine(line, steps.length));
  return { steps, rest };
}
