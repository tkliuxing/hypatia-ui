import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HypatiaCliError,
  buildKnowledgeQuery,
  buildStatementQuery,
  filterKnowledge,
  isUnrecognizedSubcommand,
  listScopes,
  normalizeContent,
  normalizeKnowledge,
  normalizeStatement,
  parseCliObject,
  parseCliRows,
  parseShelves,
  parseValueList
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

test("normalizes Hypatia 0.3 statement positions with legacy fallbacks", () => {
  const current = normalizeStatement({
    head: "API",
    relation: "depends_on",
    tail: "Database",
    created_at: "2026-01-01 10:00:00",
    content: { data: "primary store" }
  });
  const legacy = normalizeStatement({
    subject: "Worker",
    predicate: "uses",
    object: "Queue",
    content: {}
  });

  assert.deepEqual(current, {
    subject: "API",
    predicate: "depends_on",
    object: "Database",
    createdAt: "2026-01-01 10:00:00",
    content: { data: "primary store", format: "markdown", tags: [], scopes: [], figures: [] }
  });
  assert.equal(legacy.subject, "Worker");
  assert.equal(legacy.predicate, "uses");
  assert.equal(legacy.object, "Queue");
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

test("normalizes malformed content without leaking invalid fields", () => {
  assert.deepEqual(normalizeContent({
    data: 42,
    format: "",
    tags: ["valid", 2],
    scopes: null,
    figures: "not-an-array"
  }), {
    data: "",
    format: "markdown",
    tags: ["valid"],
    scopes: [],
    figures: []
  });
});

test("parses knowledge object sentinels and rejects malformed results", () => {
  assert.equal(parseCliObject("No results found.\n"), null);
  assert.equal(parseCliObject("Knowledge not found.\n"), null);
  assert.deepEqual(parseCliObject(JSON.stringify({ name: "Alpha" })), { name: "Alpha" });
  assert.throws(() => parseCliObject("[]"), /unexpected knowledge response/i);
  assert.throws(() => parseCliRows("{\"name\":\"Alpha\"}"), /unexpected query response/i);
});

test("reads scope list values and keeps the global scope as the empty string", () => {
  assert.deepEqual(parseValueList('[\n  { "entries": 12, "value": "" },\n  { "entries": 8, "value": "hypatia" }\n]\n'), ["", "hypatia"]);
  assert.deepEqual(parseValueList("[]\n"), []);
  assert.deepEqual(parseValueList('[{"entries":1},{"value":null},{"value":"a"}]'), ["a"]);
  assert.throws(() => parseValueList('["a"]'), HypatiaCliError);
});

test("recognizes only the refusal of the named subcommand", () => {
  const refusal = new HypatiaCliError("error: unrecognized subcommand 'scope'\n\nUsage: hypatia [COMMAND]", 2);
  assert.equal(isUnrecognizedSubcommand(refusal, "scope"), true);
  assert.equal(isUnrecognizedSubcommand(refusal, "tag"), false);
  assert.equal(isUnrecognizedSubcommand(new HypatiaCliError("Error: shelf error: shelf 'x' is not connected", 1), "scope"), false);
  assert.equal(isUnrecognizedSubcommand(new Error("unrecognized subcommand 'scope'"), "scope"), false);
});

async function withFakeHypatia(script: string, run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "hypatia-archive-"));
  const binary = path.join(directory, "hypatia");
  const previous = process.env.HYPATIA_BIN;
  await writeFile(binary, "#!/bin/sh\n" + script);
  await chmod(binary, 0o755);
  process.env.HYPATIA_BIN = binary;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.HYPATIA_BIN;
    else process.env.HYPATIA_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("lists scopes through scope list --json on the requested shelf", async () => {
  await withFakeHypatia(
    'if [ "$*" = "scope list --json --shelf work" ]; then echo \'[{"value":"","entries":1},{"value":"a","entries":2}]\'; exit 0; fi\n'
      + 'echo "unexpected arguments: $*" >&2; exit 1\n',
    async () => {
      assert.deepEqual(await listScopes("work"), ["", "a"]);
    }
  );
});

test("answers null for scopes when the CLI predates scope list", async () => {
  await withFakeHypatia(
    "printf \"error: unrecognized subcommand 'scope'\\n\\nUsage: hypatia [COMMAND]\\n\" >&2; exit 2\n",
    async () => {
      assert.equal(await listScopes("default"), null);
    }
  );
});

test("passes other scope list failures through", async () => {
  await withFakeHypatia(
    "echo \"Error: shelf error: shelf 'x' is not connected\" >&2; exit 1\n",
    async () => {
      await assert.rejects(listScopes("x"), /not connected/);
    }
  );
});
