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
  getRelationships,
  normalizeKnowledge,
  parseShelves,
  queryHypatia,
  runHypatia,
  type Knowledge,
  type Relationship
} from "./hypatia.js";

const app = express();
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDirectory, "..");
let mutationTail: Promise<void> = Promise.resolve();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

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

function pageValue(request: Request): number {
  const parsed = Number.parseInt(queryValue(request, "page", "1"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function limitValue(request: Request): number {
  const parsed = Number.parseInt(queryValue(request, "limit", "50"), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function queueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

async function findImpact(shelf: string, name: string): Promise<{ knowledge: Knowledge; relationships: Relationship[] } | null> {
  const results = await Promise.all([getKnowledge(shelf, name), getRelationships(shelf, name)]);
  const knowledge = results[0];
  return knowledge ? { knowledge, relationships: results[1] } : null;
}

app.get("/api/health", asyncRoute(async (_request, response) => {
  const result = await runHypatia(["--version"]);
  response.json({ status: "ready", version: result.stdout.trim() });
}));

app.get("/api/shelves", asyncRoute(async (_request, response) => {
  const result = await runHypatia(["list"]);
  response.json({ shelves: parseShelves(result.stdout) });
}));

app.get("/api/knowledge", asyncRoute(async (request, response) => {
  const shelf = queryValue(request, "shelf", "default");
  const search = queryValue(request, "q");
  const tag = queryValue(request, "tag");
  const scope = queryValue(request, "scope");
  const page = pageValue(request);
  const limit = limitValue(request);
  const rows = await queryHypatia(shelf, buildKnowledgeQuery(search));
  const filtered = filterKnowledge(rows.map(normalizeKnowledge), tag, scope);
  const offset = (page - 1) * limit;

  response.json({
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    page,
    limit
  });
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
        await deleteStatement(shelf, relationship);
        deletedRelations += 1;
      }
    }
    await deleteKnowledge(shelf, name);
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
  const status = error instanceof HypatiaCliError ? 502 : 500;
  response.status(status).json({ error: message });
});

export function startServer(port = configuredPort()) {
  return app.listen(port, "127.0.0.1", () => {
    console.log("Hypatia Archive API listening at http://127.0.0.1:" + port);
  });
}

const launchedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (launchedFile === fileURLToPath(import.meta.url)) {
  startServer();
}
