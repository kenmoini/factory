import { afterAll, expect, test } from "bun:test";
import { loadFixtureNotes, startFakeEtapi } from "./fake-etapi";

const fake = startFakeEtapi({ ...loadFixtureNotes(), token: "tok" });
afterAll(() => fake.stop());
const get = (p: string, token = "tok") => fetch(fake.url + p, { headers: { Authorization: token } });
const ids = async (p: string) => ((await (await get(p)).json()) as any).results.map((n: any) => n.noteId).sort();

test("label + ancestor filtering", async () => {
  expect(await ids("/etapi/notes?search=" + encodeURIComponent("#factoryTask"))).toEqual(["t001", "t002", "t003", "t004", "t005"]);
  expect(await ids("/etapi/notes?search=" + encodeURIComponent("#factoryReview") + "&ancestorNoteId=ws1")).toEqual(["r1", "r2"]);
  expect(await ids("/etapi/notes?search=" + encodeURIComponent("#factoryTask #status='done'"))).toEqual(["t001"]);
  expect(await ids("/etapi/notes?search=" + encodeURIComponent("#factoryDoc") + "&ancestorNoteId=proj1&ancestorDepth=eq1")).toEqual(["d1"]);
  expect(await ids("/etapi/notes?search=" + encodeURIComponent("#factoryTask") + "&limit=2")).toHaveLength(2);
});

test("auth, 404 and content types", async () => {
  expect((await get("/etapi/app-info", "bad")).status).toBe(401);
  expect((await get("/etapi/notes/nope")).status).toBe(404);
  expect((await get("/etapi/notes/d3/content")).headers.get("content-type")).toContain("text/x-markdown");
  expect((await get("/etapi/notes/d1/content")).headers.get("content-type")).toContain("text/html");
});
