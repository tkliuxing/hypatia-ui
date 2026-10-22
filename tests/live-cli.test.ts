import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKnowledgeQuery,
  buildStatementQuery,
  findSimilarKnowledge,
  getKnowledge,
  isSemanticUnavailable,
  listScopes,
  listTags,
  normalizeKnowledge,
  parseShelves,
  queryHypatia,
  runHypatia
} from "../server/hypatia.js";

// The unit tests above run against fake binaries, which cannot notice a change
// in the real CLI's output. This file is the opposite: it talks to whatever
// `hypatia` is on PATH and never creates or deletes a record, so it is skipped
// unless asked for.
//   HYPATIA_LIVE=1 pnpm test
// The shelf defaults to `default`; HYPATIA_LIVE_SHELF names another one.
const live = process.env.HYPATIA_LIVE === "1";
const shelf = process.env.HYPATIA_LIVE_SHELF || "default";
const skipped = { skip: !live };

test("the installed CLI answers --version and lists its shelves", skipped, async () => {
  const version = await runHypatia(["--version"]);
  assert.match(version.stdout.trim(), /^hypatia \d+\.\d+\.\d+/);

  const shelves = parseShelves((await runHypatia(["list"])).stdout);
  assert.ok(Array.isArray(shelves));
  assert.ok(shelves.every((entry) => entry.name && entry.path));
});

test("a bounded knowledge query returns one record shape", skipped, async () => {
  const rows = await queryHypatia(shelf, buildKnowledgeQuery("", { limit: 1, offset: 0 }));
  assert.ok(rows.length <= 1);
  for (const row of rows.map(normalizeKnowledge)) {
    assert.equal(typeof row.name, "string");
    assert.equal(typeof row.content.format, "string");
    assert.ok(Array.isArray(row.content.tags));
    assert.ok(Array.isArray(row.content.scopes));
  }
});

test("a statement query answers rows or the empty sentinel", skipped, async () => {
  // `$triple` needs at least one named position, so the query is anchored on a
  // record that exists rather than on four wildcards.
  const [row] = await queryHypatia(shelf, buildKnowledgeQuery("", { limit: 1, offset: 0 }));
  if (!row) return;
  const statements = await queryHypatia(shelf, buildStatementQuery(["$triple", normalizeKnowledge(row).name, "$*", "$*"], 1));
  assert.ok(Array.isArray(statements));
});

test("a missing knowledge name reads as null instead of an error", skipped, async () => {
  assert.equal(await getKnowledge(shelf, "hypatia-archive-live-test-missing-entry"), null);
});

test("the scope and tag rosters answer values or a clean refusal", skipped, async () => {
  for (const roster of [await listScopes(shelf), await listTags(shelf)]) {
    if (roster === null) continue; // a CLI older than 4.1.0
    assert.ok(roster.every((value) => typeof value === "string"));
  }
});

test("semantic search answers rows or reports an unconfigured model", skipped, async () => {
  try {
    const hits = await findSimilarKnowledge(shelf, "knowledge maintenance", 2);
    assert.ok(hits.length <= 2);
    for (const hit of hits) {
      assert.equal(typeof hit.knowledge.name, "string");
      assert.ok(hit.distance === null || typeof hit.distance === "number");
    }
  } catch (error) {
    assert.ok(isSemanticUnavailable(error), "unexpected semantic search failure: " + String(error));
  }
});
