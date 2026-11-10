export interface EtapiAttribute { attributeId: string; noteId: string; type: "label"|"relation"; name: string; value: string; position: number; isInheritable: boolean }
export interface EtapiNote { noteId: string; title: string; type: string; mime: string; attributes: EtapiAttribute[]; parentNoteIds: string[]; childNoteIds: string[]; dateCreated: string; dateModified: string; utcDateCreated: string; utcDateModified: string }
export interface SearchOpts { ancestorNoteId?: string; ancestorDepth?: string; orderBy?: string; orderDirection?: "asc"|"desc"; limit?: number; fastSearch?: boolean }

export class TriliumError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "TriliumError";
  }
}

export class TriliumClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async request(path: string, accept: string | null): Promise<Response> {
    const headers: Record<string, string> = { Authorization: this.token };
    if (accept) headers.Accept = accept;
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { method: "GET", headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new TriliumError(`GET ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      throw new TriliumError(`GET ${path} -> ${res.status}: ${body}`, res.status);
    }
    return res;
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.request(path, "application/json");
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw new TriliumError(`GET ${path} returned invalid JSON`, res.status);
    }
  }

  async search(query: string, opts: SearchOpts = {}): Promise<EtapiNote[]> {
    const p = new URLSearchParams({ search: query });
    if (opts.ancestorNoteId !== undefined) p.set("ancestorNoteId", opts.ancestorNoteId);
    if (opts.ancestorDepth !== undefined) p.set("ancestorDepth", opts.ancestorDepth);
    if (opts.orderBy !== undefined) p.set("orderBy", opts.orderBy);
    if (opts.orderDirection !== undefined) p.set("orderDirection", opts.orderDirection);
    if (opts.limit !== undefined) p.set("limit", String(opts.limit));
    if (opts.fastSearch !== undefined) p.set("fastSearch", String(opts.fastSearch));
    const path = `/etapi/notes?${p.toString()}`;
    const body = await this.json<{ results?: unknown }>(path);
    if (!body || !Array.isArray(body.results)) throw new TriliumError(`GET ${path} returned no results array`);
    return body.results as EtapiNote[];
  }

  getNote(id: string): Promise<EtapiNote> {
    return this.json<EtapiNote>(`/etapi/notes/${encodeURIComponent(id)}`);
  }

  async getContent(id: string): Promise<{ content: string; mime: string }> {
    const path = `/etapi/notes/${encodeURIComponent(id)}/content`;
    const res = await this.request(path, null);
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    return { content: await res.text(), mime };
  }

  appInfo(): Promise<{ appVersion: string }> {
    return this.json<{ appVersion: string }>("/etapi/app-info");
  }
}
