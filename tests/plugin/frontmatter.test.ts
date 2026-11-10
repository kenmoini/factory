import { expect, test } from "bun:test";
import { parseFrontmatter } from "./frontmatter";

test("parses a string value", () => {
  expect(parseFrontmatter("---\nname: run\n---\nbody").data.name).toBe("run");
});
test("strips surrounding quotes", () => {
  expect(parseFrontmatter('---\ndescription: "hi there"\n---\n').data.description).toBe("hi there");
});
test("parses booleans", () => {
  const { data } = parseFrontmatter("---\ndisable-model-invocation: true\nx: false\n---\n");
  expect(data["disable-model-invocation"]).toBe(true);
  expect(data.x).toBe(false);
});
test("parses comma lists", () => {
  expect(parseFrontmatter("---\ntools: Read, Grep, Bash\n---\n").data.tools).toEqual(["Read", "Grep", "Bash"]);
});
test("parses dash lists", () => {
  expect(parseFrontmatter("---\ntools:\n  - Read\n  - Grep\nname: a\n---\n").data).toEqual({ tools: ["Read", "Grep"], name: "a" });
});
test("returns body without frontmatter", () => {
  expect(parseFrontmatter("---\nname: a\n---\n# Title\ntext\n").body).toBe("# Title\ntext\n");
});
test("no frontmatter returns empty data and full body", () => {
  const md = "# Just a doc\n";
  expect(parseFrontmatter(md)).toEqual({ data: {}, body: md });
});
test("comma in description stays a string; only list keys split", () => {
  const { data } = parseFrontmatter('---\ndescription: "Use when X, Y"\ntools: Read, Grep\n---\n');
  expect(data.description).toBe("Use when X, Y");
  expect(data.tools).toEqual(["Read", "Grep"]);
});
