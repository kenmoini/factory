import DOMPurify from "dompurify";
import { marked } from "marked";

/** Turns a Trilium note body into HTML that is safe to inject: markdown is rendered first, and both formats are sanitized. */
export function toSafeHtml(content: string, format: "html" | "markdown"): string {
  const html = format === "markdown" ? (marked.parse(content, { async: false }) as string) : content;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
