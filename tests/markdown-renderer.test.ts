import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../client/src/MarkdownContent.js";

function renderMarkdown(value: string): string {
  return renderToStaticMarkup(createElement(MarkdownContent, { value }));
}

test("renders standard Markdown blocks and inline formatting", () => {
  const markup = renderMarkdown([
    "## Context",
    "",
    "Use **strong** and [a link](https://example.com).",
    "",
    "> A cited note",
    "",
    "- first item",
    "- second item",
    "",
    "Use `42` in code.",
    "",
    "![Diagram](https://example.com/diagram.png)"
  ].join("\n"));

  assert.match(markup, /<h2>Context<\/h2>/);
  assert.match(markup, /<strong>strong<\/strong>/);
  assert.match(markup, /href="https:\/\/example\.com"/);
  assert.match(markup, /<blockquote>/);
  assert.match(markup, /<ul>/);
  assert.match(markup, /<code>42<\/code>/);
  assert.match(markup, /<img src="https:\/\/example\.com\/diagram\.png" alt="Diagram"/);
});

test("skips raw HTML instead of rendering executable markup", () => {
  const markup = renderMarkdown("<script>alert('unsafe')</script>");

  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /alert\('unsafe'\)/);
});
