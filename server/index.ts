import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HypatiaCliError,
  buildKnowledgeQuery,
  deleteKnowledge,
  deleteStatement,
  filterKnowledge,
  getKnowledge,
  getKnowledgeByNames,
  getRelationships,
  normalizeKnowledge,
  parseShelves,
  queryHypatia,
  runHypatia,
  searchKnowledgeKeys,
  type Knowledge,
  type Relationship
} from "./hypatia.js";

export interface HypatiaService {
  runHypatia: typeof runHypatia;
  queryHypatia: typeof queryHypatia;
  searchKnowledgeKeys: typeof searchKnowledgeKeys;
  getKnowledgeByNames: typeof getKnowledgeByNames;
  getKnowledge: typeof getKnowledge;
  getRelationships: typeof getRelationships;
  deleteStatement: typeof deleteStatement;
  deleteKnowledge: typeof deleteKnowledge;
}

const defaultHypatiaService: HypatiaService = {
  runHypatia,
  queryHypatia,
  searchKnowledgeKeys,
  getKnowledgeByNames,
  getKnowledge,
  getRelationships,
  deleteStatement,
  deleteKnowledge
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDirectory, "..");

function configuredPort(): number {
  const port = Number(process.env.PORT || 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535.");
  }
  return port;
}

function queryValue(request: Request, key: string, fallback = ""): string {
  const value = request.query[key];
  return typeof value === "string" ? value : fallback;
}

function paramValue(request: Request, key: string): string {
  const value = request.params[key];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

const SCAN_BATCH_SIZE = 200;
const GRAPH_RELATION_LIMIT = 60;

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

interface KnowledgeCursor {
  shelf: string;
  q: string;
  tag: string;
  scope: string;
  offset: number;
}

interface IndexedKnowledge {
  knowledge: Knowledge;
  nextOffset: number;
}

interface GraphNode {
  id: string;
  name: string;
  knowledge: Knowledge | null;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  predicate: string;
  createdAt: string;
  content: Relationship["content"];
}

function limitValue(request: Request): number {
  const parsed = Number.parseInt(queryValue(request, "limit", "50"), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
}

function encodeCursor(cursor: KnowledgeCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string, expected: Omit<KnowledgeCursor, "offset">): number {
  if (!value) return 0;

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<KnowledgeCursor>;
    const offset = parsed.offset;
    if (
      typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
      parsed.shelf !== expected.shelf || parsed.q !== expected.q ||
      parsed.tag !== expected.tag || parsed.scope !== expected.scope
    ) {
      throw new Error("Cursor does not match the current query.");
    }
    return offset;
  } catch {
    throw new RequestValidationError("The list cursor is invalid or belongs to a different query.");
  }
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function graphEdgeId(relationship: Relationship): string {
  return [relationship.subject, relationship.predicate, relationship.object].map(encodeURIComponent).join("%00");
}

export function createApp(hypatia: HypatiaService = defaultHypatiaService) {
  const app = express();
  let mutationTail: Promise<void> = Promise.resolve();

  function queueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function loadSourceBatch(shelf: string, search: string, offset: number, limit: number): Promise<{ rows: IndexedKnowledge[]; exhausted: boolean }> {
    if (search) {
      const names = await hypatia.searchKnowledgeKeys(shelf, search, limit, offset);
      const knowledgeByName = new Map((await hypatia.getKnowledgeByNames(shelf, names)).map((knowledge) => [knowledge.name, knowledge]));
      return {
        rows: names.flatMap((name, index) => {
          const knowledge = knowledgeByName.get(name);
          return knowledge ? [{ knowledge, nextOffset: offset + index + 1 }] : [];
        }),
        exhausted: names.length < limit
      };
    }

    const rows = await hypatia.queryHypatia(shelf, buildKnowledgeQuery("", { limit, offset }));
    return {
      rows: rows.map(normalizeKnowledge).map((knowledge, index) => ({ knowledge, nextOffset: offset + index + 1 })),
      exhausted: rows.length < limit
    };
  }

  async function loadKnowledgePage(
    shelf: string,
    search: string,
    tag: string,
    scope: string,
    limit: number,
    offset: number
  ): Promise<{ items: Knowledge[]; nextCursor: string | null }> {
    const selected: IndexedKnowledge[] = [];
    const sourceLimit = tag || scope ? SCAN_BATCH_SIZE : limit + 1;
    let sourceOffset = offset;

    while (selected.length <= limit) {
      const batch = await loadSourceBatch(shelf, search, sourceOffset, sourceLimit);
      const matchingNames = new Set(filterKnowledge(batch.rows.map((row) => row.knowledge), tag, scope).map((knowledge) => knowledge.name));

      for (const row of batch.rows) {
        if (!matchingNames.has(row.knowledge.name)) continue;
        selected.push(row);
        if (selected.length > limit) break;
      }

      if (selected.length > limit) {
        const items = selected.slice(0, limit);
        const last = items.at(-1);
        return {
          items: items.map((row) => row.knowledge),
          nextCursor: last ? encodeCursor({ shelf, q: search, tag, scope, offset: last.nextOffset }) : null
        };
      }

      if (batch.exhausted) {
        return { items: selected.map((row) => row.knowledge), nextCursor: null };
      }

      sourceOffset += sourceLimit;
    }

    return { items: [], nextCursor: null };
  }

  async function findImpact(shelf: string, name: string): Promise<{ knowledge: Knowledge; relationships: Relationship[] } | null> {
    const results = await Promise.all([hypatia.getKnowledge(shelf, name), hypatia.getRelationships(shelf, name)]);
    const knowledge = results[0];
    return knowledge ? { knowledge, relationships: results[1] } : null;
  }

  async function findGraphNode(shelf: string, name: string): Promise<{ focus: string; nodes: GraphNode[]; edges: GraphEdge[] } | null> {
    const relationships = await hypatia.getRelationships(shelf, name, GRAPH_RELATION_LIMIT);
    const names = [...new Set([name, ...relationships.flatMap((relationship) => [relationship.subject, relationship.object])])];
    const knowledgeByName = new Map((await hypatia.getKnowledgeByNames(shelf, names)).map((knowledge) => [knowledge.name, knowledge]));

    if (!knowledgeByName.has(name) && relationships.length === 0) return null;

    return {
      focus: name,
      nodes: names.map((nodeName) => ({ id: nodeName, name: nodeName, knowledge: knowledgeByName.get(nodeName) || null })),
      edges: relationships.map((relationship) => ({
        id: graphEdgeId(relationship),
        source: relationship.subject,
        target: relationship.object,
        predicate: relationship.predicate,
        createdAt: relationship.createdAt,
        content: relationship.content
      }))
    };
  }

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", asyncRoute(async (_request, response) => {
    const result = await hypatia.runHypatia(["--version"]);
    response.json({ status: "ready", version: result.stdout.trim() });
  }));

  app.get("/api/shelves", asyncRoute(async (_request, response) => {
    const result = await hypatia.runHypatia(["list"]);
    response.json({ shelves: parseShelves(result.stdout) });
  }));

  app.get("/api/knowledge", asyncRoute(async (request, response) => {
    const shelf = queryValue(request, "shelf", "default");
    const search = queryValue(request, "q");
    const tag = queryValue(request, "tag");
    const scope = queryValue(request, "scope");
    const limit = limitValue(request);
    const offset = decodeCursor(queryValue(request, "cursor"), { shelf, q: search, tag, scope });

    response.json(await loadKnowledgePage(shelf, search, tag, scope, limit, offset));
  }));

  app.get("/api/graph/node/:name", asyncRoute(async (request, response) => {
    const shelf = queryValue(request, "shelf", "default");
    const graphNode = await findGraphNode(shelf, paramValue(request, "name"));
    if (!graphNode) {
      response.status(404).json({ error: "Knowledge or graph entity was not found." });
      return;
    }
    response.json(graphNode);
  }));

  app.get("/api/knowledge/:name/impact", asyncRoute(async (request, response) => {
    const shelf = queryValue(request, "shelf", "default");
    const impact = await findImpact(shelf, paramValue(request, "name"));
    if (!impact) {
      response.status(404).json({ error: "Knowledge entry was not found." });
      return;
    }
    response.json(impact);
  }));

  app.delete("/api/knowledge/:name", asyncRoute(async (request, response) => {
    const shelf = queryValue(request, "shelf", "default");
    const name = paramValue(request, "name");
    const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
    const acknowledgedName = typeof body.acknowledgedName === "string" ? body.acknowledgedName : "";
    const deleteRelations = body.deleteRelations === true;

    if (acknowledgedName !== name) {
      response.status(400).json({ error: "Enter the exact knowledge name to confirm deletion." });
      return;
    }

    const result = await queueMutation(async () => {
      const impact = await findImpact(shelf, name);
      if (!impact) return null;

      let deletedRelations = 0;
      if (deleteRelations) {
        for (const relationship of impact.relationships) {
          await hypatia.deleteStatement(shelf, relationship);
          deletedRelations += 1;
        }
      }
      await hypatia.deleteKnowledge(shelf, name);
      return { deletedRelations, retainedRelations: deleteRelations ? 0 : impact.relationships.length };
    });

    if (!result) {
      response.status(404).json({ error: "Knowledge entry was not found." });
      return;
    }
    response.json({ name, ...result });
  }));

  if (process.env.NODE_ENV === "production") {
    const clientDist = path.join(appRoot, "dist");
    app.use(express.static(clientDist));
    app.get("/{*splat}", (_request, response) => response.sendFile(path.join(clientDist, "index.html")));
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = error instanceof RequestValidationError ? 400 : error instanceof HypatiaCliError ? 502 : 500;
    response.status(status).json({ error: message });
  });

  return app;
}

const app = createApp();

export function startServer(port = configuredPort()) {
  return app.listen(port, "127.0.0.1", () => {
    console.log("Hypatia Archive API listening at http://127.0.0.1:" + port);
  });
}

const launchedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (launchedFile === fileURLToPath(import.meta.url)) {
  startServer();
}
