import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKnowledgeQuery,
  buildStatementQuery,
  filterKnowledge,
  normalizeKnowledge,
  parseCliRows,
  parseShelves
} from "../server/hypatia.js";

test("parses Hypatia query rows and normalizes optional content fields", () => {
  const rows = parseCliRows(JSON.stringify([{
    name: "Rust",
    created_at: "2026-01-01 10:00:00",
    content: { data: "systems language", format: "markdown", tags: ["language"], scopes: null, figures: null }
  }]));
  const knowledge = normalizeKnowledge(rows[0]);

  assert.equal(knowledge.name, "Rust");
  assert.deepEqual(knowledge.content.tags, ["language"]);
  assert.deepEqual(knowledge.content.scopes, []);
  assert.deepEqual(knowledge.content.figures, []);
});

test("handles empty output from the Hypatia query formatter", () => {
  assert.deepEqual(parseCliRows("No results found.\n"), []);
});

test("constructs a direct knowledge query for blank and search states", () => {
  assert.deepEqual(buildKnowledgeQuery(""), ["$knowledge"]);
  assert.deepEqual(buildKnowledgeQuery("memory bridge"), ["$knowledge", ["$search", "memory bridge"]]);
});

test("constructs a bounded JSE query for incremental reads", () => {
  assert.deepEqual(buildKnowledgeQuery("", { limit: 51, offset: 100 }), {
    $knowledge: [],
    limit: 51,
    offset: 100
  });
});

test("constructs bounded statement queries for graph neighborhoods", () => {
  assert.deepEqual(buildStatementQuery(["$triple", "API", "$*", "$*"], 60), {
    $statement: [["$triple", "API", "$*", "$*"]],
    limit: 60,
    offset: 0
  });
});

test("filters knowledge by tag and global or named scope", () => {
  const entries = [
    { name: "One", content: { data: "", format: "markdown", tags: ["rule"], scopes: [""], figures: [] }, createdAt: "" },
    { name: "Two", content: { data: "", format: "markdown", tags: ["reference"], scopes: ["project-a"], figures: [] }, createdAt: "" }
  ];

  assert.deepEqual(filterKnowledge(entries, "rul", "__global__").map((entry) => entry.name), ["One"]);
  assert.deepEqual(filterKnowledge(entries, "", "project-a").map((entry) => entry.name), ["Two"]);
});

test("parses connected shelf lines without assuming a fixed path", () => {
  assert.deepEqual(parseShelves("  default  /Users/example/.hypatia/default  [connected]\n"), [
    { name: "default", path: "/Users/example/.hypatia/default", connected: true }
  ]);
});
