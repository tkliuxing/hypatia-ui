import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp, type HypatiaService } from "../server/index.js";
import { HypatiaCliError, type JsonRecord, type Knowledge, type Relationship } from "../server/hypatia.js";

const EMPTY_CONTENT = {
  data: "",
  format: "markdown",
  tags: [] as string[],
  scopes: [] as string[],
  figures: [] as string[]
};

function knowledge(name: string, tags: string[] = [], scopes: string[] = []): Knowledge {
  return {
    name,
    createdAt: "2026-01-01 12:00:00",
    content: { ...EMPTY_CONTENT, tags, scopes }
  };
}

function relationship(subject: string, predicate: string, object: string): Relationship {
  return {
    subject,
    predicate,
    object,
    createdAt: "2026-01-01 12:00:00",
    direction: "outgoing",
    content: EMPTY_CONTENT
  };
}

function cliRow(item: Knowledge): JsonRecord {
  return {
    name: item.name,
    created_at: item.createdAt,
    content: item.content
  };
}

interface FakeOptions {
  records?: Knowledge[];
  relationships?: Relationship[];
  calls?: string[];
  onDeleteKnowledge?: (name: string) => Promise<void>;
  runHypatia?: HypatiaService["runHypatia"];
}

function createFakeHypatia({
  records = [],
  relationships = [],
  calls = [],
  onDeleteKnowledge,
  runHypatia
}: FakeOptions = {}): HypatiaService {
  const byName = new Map(records.map((item) => [item.name, item]));

  return {
    runHypatia: runHypatia || (async (args) => ({
      stdout: args[0] === "list" ? "  default  /tmp/default  [connected]\n" : "1.0.0\n",
      stderr: ""
    })),
    queryHypatia: async (_shelf, query) => {
      const options = query as { limit?: number; offset?: number };
      const offset = options.offset || 0;
      const limit = options.limit || records.length;
      return records.slice(offset, offset + limit).map(cliRow);
    },
    searchKnowledgeKeys: async (_shelf, _search, limit, offset) => records.slice(offset, offset + limit).map((item) => item.name),
    getKnowledgeByNames: async (_shelf, names) => names.flatMap((name) => {
      const item = byName.get(name);
      return item ? [item] : [];
    }),
    getKnowledge: async (_shelf, name) => byName.get(name) || null,
    getRelationships: async (_shelf, name) => relationships.filter((item) => item.subject === name || item.object === name),
    deleteStatement: async (_shelf, item) => {
      calls.push("statement:" + item.subject + ":" + item.predicate + ":" + item.object);
    },
    deleteKnowledge: async (_shelf, name) => {
      calls.push("knowledge:" + name);
      await onDeleteKnowledge?.(name);
    }
  };
}

async function withServer(service: HypatiaService, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createApp(service).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  try {
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function requestJson(baseUrl: string, requestPath: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(baseUrl + requestPath, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("knowledge pages reject invalid and mismatched cursors", async () => {
  const service = createFakeHypatia({ records: [knowledge("Alpha"), knowledge("Beta"), knowledge("Gamma")] });

  await withServer(service, async (baseUrl) => {
    const first = await requestJson(baseUrl, "/api/knowledge?shelf=default&limit=1");
    assert.equal(first.status, 200);
    const firstPage = first.body as { items: Knowledge[]; nextCursor: string | null };
    assert.deepEqual(firstPage.items.map((item) => item.name), ["Alpha"]);
    assert.ok(firstPage.nextCursor);

    const second = await requestJson(baseUrl, "/api/knowledge?shelf=default&limit=1&cursor=" + encodeURIComponent(firstPage.nextCursor));
    assert.equal(second.status, 200);
    assert.deepEqual((second.body as { items: Knowledge[] }).items.map((item) => item.name), ["Beta"]);

    const invalid = await requestJson(baseUrl, "/api/knowledge?cursor=not-a-cursor");
    assert.equal(invalid.status, 400);
    assert.match(String(invalid.body.error), /cursor is invalid/i);

    const mismatched = await requestJson(baseUrl, "/api/knowledge?shelf=other&limit=1&cursor=" + encodeURIComponent(firstPage.nextCursor));
    assert.equal(mismatched.status, 400);
    assert.match(String(mismatched.body.error), /cursor is invalid/i);
  });
});

test("filtered pagination keeps the source offset across scan batches", async () => {
  const records = Array.from({ length: 201 }, (_, index) => knowledge("Entry " + index, index >= 199 ? ["keep"] : []));
  const service = createFakeHypatia({ records });

  await withServer(service, async (baseUrl) => {
    const first = await requestJson(baseUrl, "/api/knowledge?tag=keep&limit=1");
    assert.equal(first.status, 200);
    const firstPage = first.body as { items: Knowledge[]; nextCursor: string | null };
    assert.deepEqual(firstPage.items.map((item) => item.name), ["Entry 199"]);
    assert.ok(firstPage.nextCursor);
    const cursor = JSON.parse(Buffer.from(firstPage.nextCursor, "base64url").toString("utf8")) as { offset: number };
    assert.equal(cursor.offset, 200);

    const second = await requestJson(baseUrl, "/api/knowledge?tag=keep&limit=1&cursor=" + encodeURIComponent(firstPage.nextCursor));
    assert.equal(second.status, 200);
    const secondPage = second.body as { items: Knowledge[]; nextCursor: string | null };
    assert.deepEqual(secondPage.items.map((item) => item.name), ["Entry 200"]);
    assert.equal(secondPage.nextCursor, null);
  });
});

test("deletion requires exact confirmation and retains relationships by default", async () => {
  const calls: string[] = [];
  const service = createFakeHypatia({
    records: [knowledge("Alpha")],
    relationships: [relationship("Alpha", "links", "Beta"), relationship("Gamma", "links", "Alpha")],
    calls
  });

  await withServer(service, async (baseUrl) => {
    const rejected = await requestJson(baseUrl, "/api/knowledge/Alpha", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledgedName: "alpha", deleteRelations: true })
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(calls, []);

    const retained = await requestJson(baseUrl, "/api/knowledge/Alpha", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledgedName: "Alpha", deleteRelations: false })
    });
    assert.equal(retained.status, 200);
    assert.deepEqual(retained.body, { name: "Alpha", deletedRelations: 0, retainedRelations: 2 });
    assert.deepEqual(calls, ["knowledge:Alpha"]);

    calls.length = 0;
    const cleaned = await requestJson(baseUrl, "/api/knowledge/Alpha", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledgedName: "Alpha", deleteRelations: true })
    });
    assert.equal(cleaned.status, 200);
    assert.deepEqual(cleaned.body, { name: "Alpha", deletedRelations: 2, retainedRelations: 0 });
    assert.deepEqual(calls, [
      "statement:Alpha:links:Beta",
      "statement:Gamma:links:Alpha",
      "knowledge:Alpha"
    ]);
  });
});

test("deletions execute one mutation at a time", async () => {
  const calls: string[] = [];
  const service = createFakeHypatia({
    records: [knowledge("Alpha"), knowledge("Beta")],
    calls,
    onDeleteKnowledge: async (name) => {
      calls.push("start:" + name);
      await new Promise<void>((resolve) => setImmediate(resolve));
      calls.push("end:" + name);
    }
  });

  await withServer(service, async (baseUrl) => {
    const deleteRequest = (name: string) => requestJson(baseUrl, "/api/knowledge/" + name, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledgedName: name })
    });
    const [alpha, beta] = await Promise.all([deleteRequest("Alpha"), deleteRequest("Beta")]);
    assert.equal(alpha.status, 200);
    assert.equal(beta.status, 200);
    assert.deepEqual(calls, [
      "knowledge:Alpha",
      "start:Alpha",
      "end:Alpha",
      "knowledge:Beta",
      "start:Beta",
      "end:Beta"
    ]);
  });
});

test("graph keeps statement-only reference nodes and rejects absent entities", async () => {
  const service = createFakeHypatia({
    records: [knowledge("Alpha")],
    relationships: [relationship("Ghost entity", "mentions", "Alpha")]
  });

  await withServer(service, async (baseUrl) => {
    const graph = await requestJson(baseUrl, "/api/graph/node/Ghost%20entity");
    assert.equal(graph.status, 200);
    const graphBody = graph.body as { focus: string; nodes: Array<{ name: string; knowledge: Knowledge | null }>; edges: Array<{ id: string; source: string; target: string }> };
    assert.equal(graphBody.focus, "Ghost entity");
    assert.deepEqual(graphBody.nodes, [
      { id: "Ghost entity", name: "Ghost entity", knowledge: null },
      { id: "Alpha", name: "Alpha", knowledge: knowledge("Alpha") }
    ]);
    assert.deepEqual(graphBody.edges, [{ id: "Ghost%20entity%00mentions%00Alpha", source: "Ghost entity", target: "Alpha", predicate: "mentions", createdAt: "2026-01-01 12:00:00", content: EMPTY_CONTENT }]);

    const absent = await requestJson(baseUrl, "/api/graph/node/Unknown");
    assert.equal(absent.status, 404);
  });
});

test("knowledge pagination clamps limits and preserves ranked search order", async () => {
  const first = knowledge("First");
  const third = knowledge("Third");
  const service = createFakeHypatia({ records: [first, third] });
  const queryLimits: number[] = [];
  const originalQuery = service.queryHypatia;
  service.queryHypatia = async (shelf, query) => {
    queryLimits.push((query as { limit: number }).limit);
    return originalQuery(shelf, query);
  };
  service.searchKnowledgeKeys = async (_shelf, _search, limit, offset) => ["Third", "Missing", "First"].slice(offset, offset + limit);
  service.getKnowledgeByNames = async () => [first, third];

  await withServer(service, async (baseUrl) => {
    const minimum = await requestJson(baseUrl, "/api/knowledge?limit=0");
    assert.equal(minimum.status, 200);
    const maximum = await requestJson(baseUrl, "/api/knowledge?limit=1000");
    assert.equal(maximum.status, 200);
    assert.deepEqual(queryLimits, [2, 101]);

    const search = await requestJson(baseUrl, "/api/knowledge?q=ranked&limit=2");
    assert.equal(search.status, 200);
    assert.deepEqual((search.body as { items: Knowledge[] }).items.map((item) => item.name), ["Third", "First"]);
  });
});

test("missing impact and deletion targets return not found", async () => {
  await withServer(createFakeHypatia(), async (baseUrl) => {
    const impact = await requestJson(baseUrl, "/api/knowledge/Missing/impact");
    assert.equal(impact.status, 404);
    assert.deepEqual(impact.body, { error: "Knowledge entry was not found." });

    const deletion = await requestJson(baseUrl, "/api/knowledge/Missing", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledgedName: "Missing" })
    });
    assert.equal(deletion.status, 404);
    assert.deepEqual(deletion.body, { error: "Knowledge entry was not found." });
  });
});

test("Hypatia CLI failures become API gateway errors", async () => {
  const service = createFakeHypatia({
    runHypatia: async () => {
      throw new HypatiaCliError("Hypatia is unavailable.");
    }
  });

  await withServer(service, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/api/health");
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: "Hypatia is unavailable." });
  });
});
