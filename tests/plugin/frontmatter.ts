export type FrontmatterValue = string | string[] | boolean;

/** Only these keys are comma-split into arrays; every other key stays a string. */
export const LIST_KEYS = new Set(["tools", "disallowedTools", "allowed-tools", "disallowed-tools", "skills", "keywords"]);

function scalar(key: string, raw: string): FrontmatterValue {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (LIST_KEYS.has(key) && v.includes(",")) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return v.replace(/^(["'])(.*)\1$/, "$2");
}

export function parseFrontmatter(md: string): { data: Record<string, FrontmatterValue>; body: string } {
  const lines = md.split("\n");
  if (lines[0]?.trimEnd() !== "---") return { data: {}, body: md };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end === -1) return { data: {}, body: md };
  const data: Record<string, FrontmatterValue> = {};
  let listKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(item[1].trim().replace(/^(["'])(.*)\1$/, "$2"));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[2].trim() === "") {
      data[kv[1]] = [];
      listKey = kv[1];
    } else {
      data[kv[1]] = scalar(kv[1], kv[2]);
      listKey = null;
    }
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}
