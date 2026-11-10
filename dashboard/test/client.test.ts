import { describe, expect, test } from "bun:test";
import { TriliumClient, TriliumError } from "../src/trilium/client";

type Call = { url: string; init: RequestInit };
function mk(res: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return res(); }) as typeof fetch;
  return { calls, client: new TriliumClient({ baseUrl: "http://t:37740/", token: "tok", fetchImpl }) };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("TriliumClient", () => {
  test("search builds URL and sends auth header", async () => {
    const { calls, client } = mk(() => json({ results: [{ noteId: "x" }] }));
    const r = await client.search("#factoryTask", { ancestorNoteId: "ws1", orderBy: "utcDateModified", orderDirection: "desc", limit: 200 });
    expect(r).toHaveLength(1);
    expect(calls[0].url).toContain("/etapi/notes?search=%23factoryTask&ancestorNoteId=ws1&orderBy=utcDateModified&orderDirection=desc&limit=200");
    expect(calls[0].url).not.toContain("//etapi");
    const h = new Headers(calls[0].init.headers);
    expect(h.get("authorization")).toBe("tok");
    expect(h.get("accept")).toBe("application/json");
  });
  test("search without opts only sends search", async () => {
    const { calls, client } = mk(() => json({ results: [] }));
    await client.search("#a");
    expect(calls[0].url.endsWith("/etapi/notes?search=%23a")).toBe(true);
  });
  test("search without results array throws", async () => {
    const { client } = mk(() => json({ nope: 1 }));
    await expect(client.search("#a")).rejects.toBeInstanceOf(TriliumError);
  });
  test("non-2xx rejects with status, no token leak", async () => {
    const { client } = mk(() => new Response("forbidden body", { status: 401 }));
    const err = await client.getNote("abc").catch((e) => e);
    expect(err).toBeInstanceOf(TriliumError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("GET /etapi/notes/abc");
    expect(err.message).toContain("forbidden body");
    expect(err.message).not.toContain("tok");
  });
  test("network error wrapped", async () => {
    const client = new TriliumClient({ baseUrl: "http://t", token: "tok", fetchImpl: (async () => { throw new Error("boom"); }) as unknown as typeof fetch });
    const err = await client.appInfo().catch((e) => e);
    expect(err).toBeInstanceOf(TriliumError);
    expect(err.status).toBeUndefined();
  });
  test("getContent returns mime without params", async () => {
    const { calls, client } = mk(() => new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(await client.getContent("n1")).toEqual({ content: "<p>hi</p>", mime: "text/html" });
    expect(calls[0].url).toContain("/etapi/notes/n1/content");
  });
  test("getNote and appInfo", async () => {
    const { calls, client } = mk(() => json({ appVersion: "0.63.0", noteId: "n1" }));
    expect((await client.appInfo()).appVersion).toBe("0.63.0");
    expect((await client.getNote("n1")).noteId).toBe("n1");
    expect(calls[0].url).toContain("/etapi/app-info");
  });
});
