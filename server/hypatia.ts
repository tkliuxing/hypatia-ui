import { spawn } from "node:child_process";

const NO_RESULTS = "No results found.";
const DEFAULT_TIMEOUT_MS = 20_000;
let commandTail: Promise<void> = Promise.resolve();

export type JsonRecord = Record<string, unknown>;

export interface KnowledgeContent {
  data: string;
  format: string;
  tags: string[];
  scopes: string[];
  figures: string[];
  // Only carried when the shelf says the entry is out of the vector index.
  // A missing field means the CLI did not report it, not that it is indexed.
  embed?: boolean;
}

export interface Knowledge {
  name: string;
  content: KnowledgeContent;
  createdAt: string;
}

export interface Statement {
  subject: string;
  predicate: string;
  object: string;
  createdAt: string;
  content: KnowledgeContent;
}

export interface Relationship extends Statement {
  direction: "incoming" | "outgoing" | "both";
}

export interface Shelf {
  name: string;
  path: string;
  connected: boolean;
}

export class HypatiaCliError extends Error {
  constructor(message: string, public readonly exitCode?: number | null) {
    super(message);
    this.name = "HypatiaCliError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeContent(value: unknown): KnowledgeContent {
  const source = isRecord(value) ? value : {};
  const content: KnowledgeContent = {
    data: asString(source.data),
    format: asString(source.format) || "markdown",
    tags: asStringArray(source.tags),
    scopes: asStringArray(source.scopes),
    figures: asStringArray(source.figures)
  };
  if (source.embed === false) content.embed = false;
  return content;
}

export function normalizeKnowledge(value: JsonRecord): Knowledge {
  return {
    name: asString(value.name),
    content: normalizeContent(value.content),
    createdAt: asString(value.created_at)
  };
}

export function normalizeStatement(value: JsonRecord): Statement {
  return {
    subject: asString(value.head) || asString(value.subject),
    predicate: asString(value.relation) || asString(value.predicate),
    object: asString(value.tail) || asString(value.object),
    createdAt: asString(value.created_at),
    content: normalizeContent(value.content)
  };
}

export function parseCliRows(stdout: string): JsonRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === NO_RESULTS) return [];

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new HypatiaCliError("Hypatia returned an unexpected query response.");
  }
  return parsed;
}

export function parseCliObject(stdout: string): JsonRecord | null {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === NO_RESULTS || /not found\.$/i.test(trimmed)) return null;

  const parsed: unknown = JSON.parse(trimmed);
  if (!isRecord(parsed)) {
    throw new HypatiaCliError("Hypatia returned an unexpected knowledge response.");
  }
  return parsed;
}

export function parseShelves(stdout: string): Shelf[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(.+?)\s{2,}(.+?)\s{2,}\[(connected|disconnected)\]$/);
      if (!match) return [];
      return [{ name: match[1], path: match[2], connected: match[3] === "connected" }];
    });
}

// `scope list --json` (or `tag list --json`): [{"value": ..., "entries": N}].
// The global scope stays the empty string, so a row without a string value is
// dropped rather than read as it.
export function parseValueList(stdout: string): string[] {
  return parseCliRows(stdout)
    .map((row) => row.value)
    .filter((value): value is string => typeof value === "string");
}

// The argument parser's refusal of a subcommand this CLI build predates.
export function isUnrecognizedSubcommand(error: unknown, subcommand: string): boolean {
  return error instanceof HypatiaCliError && error.message.includes("unrecognized subcommand '" + subcommand + "'");
}

export function buildKnowledgeQuery(search: string, options?: { limit: number; offset: number }): unknown {
  const value = search.trim();
  const conditions: unknown[] = value ? [["$search", value]] : [];

  if (!options) return ["$knowledge", ...conditions];
  return { $knowledge: conditions, limit: options.limit, offset: options.offset };
}

export function filterKnowledge(items: Knowledge[], tag: string, scope: string): Knowledge[] {
  const normalizedTag = tag.trim().toLocaleLowerCase();
  const normalizedScope = scope.trim();

  return items.filter((item) => {
    const tagMatches = !normalizedTag || item.content.tags.some((itemTag) => itemTag.toLocaleLowerCase().includes(normalizedTag));
    const scopeMatches = !normalizedScope || (normalizedScope === "__global__"
      ? item.content.scopes.includes("")
      : item.content.scopes.includes(normalizedScope));
    return tagMatches && scopeMatches;
  });
}

function executeHypatia(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const executable = process.env.HYPATIA_BIN || "hypatia";
  const configuredTimeout = Number(process.env.HYPATIA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new HypatiaCliError("Unable to start Hypatia: " + error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new HypatiaCliError("Hypatia did not respond before the request timeout.", code));
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout).trim() || "No diagnostic output was returned.";
        reject(new HypatiaCliError(detail, code));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// Hypatia's shelf store is safe for concurrent processes (SQLite runs WAL with
// a five-second busy timeout; PostgreSQL serializes on its own), so this queue
// is a throughput choice, not a correctness requirement. It stays because
// every command runs schema setup and an embedding-debt flush on open, both of
// which take a short write lock, and a cold `similar` call loads a model the
// next queued call would only load again.
export function runHypatia(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const run = commandTail.then(() => executeHypatia(args), () => executeHypatia(args));
  commandTail = run.then(() => undefined, () => undefined);
  return run;
}

export async function queryHypatia(shelf: string, jse: unknown): Promise<JsonRecord[]> {
  const result = await runHypatia(["query", JSON.stringify(jse), "--shelf", shelf]);
  return parseCliRows(result.stdout);
}

// Every scope a shelf uses, or null when the CLI predates `scope list`. The
// subcommand arrived with Hypatia 4.1.0, but a build from main can carry it
// while still reporting an older version, so support is detected from the
// refusal, not from --version. The plain listing prints the global scope as the
// label "(global)", so --json is read. The same command shape answers the tag
// roster; both count statements as well as knowledge entries.
export async function listScopes(shelf: string): Promise<string[] | null> {
  try {
    const result = await runHypatia(["scope", "list", "--json", "--shelf", shelf]);
    return parseValueList(result.stdout);
  } catch (error) {
    if (isUnrecognizedSubcommand(error, "scope")) return null;
    throw error;
  }
}

export async function listTags(shelf: string): Promise<string[] | null> {
  try {
    const result = await runHypatia(["tag", "list", "--json", "--shelf", shelf]);
    return parseValueList(result.stdout);
  } catch (error) {
    if (isUnrecognizedSubcommand(error, "tag")) return null;
    throw error;
  }
}

export async function searchKnowledgeKeys(shelf: string, search: string, limit: number, offset: number): Promise<string[]> {
  const result = await runHypatia([
    "search",
    search,
    "--catalog",
    "knowledge",
    "--limit",
    String(limit),
    "--offset",
    String(offset),
    "--shelf",
    shelf
  ]);
  return parseCliRows(result.stdout)
    .map((row) => asString(row.key))
    .filter(Boolean);
}

export async function getKnowledgeByNames(shelf: string, names: string[]): Promise<Knowledge[]> {
  const uniqueNames = [...new Set(names.filter(Boolean))];
  if (uniqueNames.length === 0) return [];

  const conditions: unknown[] = uniqueNames.map((name) => ["$eq", "name", name]);
  const condition = conditions.length === 1 ? conditions[0] : ["$or", ...conditions];
  const rows = await queryHypatia(shelf, {
    $knowledge: [condition],
    limit: uniqueNames.length,
    offset: 0
  });
  const byName = new Map(rows.map(normalizeKnowledge).map((knowledge) => [knowledge.name, knowledge]));
  return uniqueNames.flatMap((name) => {
    const knowledge = byName.get(name);
    return knowledge ? [knowledge] : [];
  });
}

export interface SimilarKnowledge {
  knowledge: Knowledge;
  distance: number | null;
}

// Session logs are the bulk of a memory shelf and match almost any query, so a
// semantic search over everything would return little else. Keyword search
// still reaches them; only the vector search skips them.
export const SEMANTIC_EXCLUDED_TAGS = ["message", "session", "summary", "hypatia-dream-run", "system"];

// The CLI reports "model unavailable" and exits non-zero when the shelf has no
// embedding model. That is a shelf state, not a broken request.
export function isSemanticUnavailable(error: unknown): boolean {
  return error instanceof HypatiaCliError && /model unavailable|semantic search is off/i.test(error.message);
}

// `similar` returns name, distance and content but no created_at, so the rows
// are resolved back through the normal knowledge read to keep one record shape.
// A `where` condition is applied by the CLI before it picks its nearest rows,
// which is the only way a scope filter can reach beyond the top candidates.
export async function findSimilarKnowledge(
  shelf: string,
  query: string,
  limit: number,
  options?: { where?: unknown }
): Promise<SimilarKnowledge[]> {
  const args = [
    "similar",
    query,
    "--target",
    "knowledge",
    "--limit",
    String(limit),
    "--exclude-tags",
    SEMANTIC_EXCLUDED_TAGS.join(",")
  ];
  if (options?.where) args.push("--where", JSON.stringify(options.where));
  args.push("--shelf", shelf);
  const result = await runHypatia(args);

  const distances = new Map<string, number | null>();
  for (const row of parseCliRows(result.stdout)) {
    const name = asString(row.name);
    if (!name || distances.has(name)) continue;
    distances.set(name, typeof row.distance === "number" ? row.distance : null);
  }

  const knowledge = await getKnowledgeByNames(shelf, [...distances.keys()]);
  const byName = new Map(knowledge.map((item) => [item.name, item]));
  return [...distances].flatMap(([name, distance]) => {
    const item = byName.get(name);
    return item ? [{ knowledge: item, distance }] : [];
  });
}

export async function getKnowledge(shelf: string, name: string): Promise<Knowledge | null> {
  const result = await runHypatia(["knowledge-get", name, "--shelf", shelf]);
  const row = parseCliObject(result.stdout);
  return row ? normalizeKnowledge(row) : null;
}

function relationshipKey(statement: Statement): string {
  return [statement.subject, statement.predicate, statement.object].join("\u0000");
}

export function buildStatementQuery(condition: unknown, limit?: number): unknown {
  if (!limit) return ["$statement", condition];
  return { $statement: [condition], limit, offset: 0 };
}

export async function getRelationships(shelf: string, name: string, limit?: number): Promise<Relationship[]> {
  const results = await Promise.all([
    queryHypatia(shelf, buildStatementQuery(["$triple", name, "$*", "$*"], limit)),
    queryHypatia(shelf, buildStatementQuery(["$triple", "$*", "$*", name], limit))
  ]);
  const relationships = new Map<string, Relationship>();

  for (const row of results[0]) {
    const statement = normalizeStatement(row);
    relationships.set(relationshipKey(statement), { ...statement, direction: "outgoing" });
  }
  for (const row of results[1]) {
    const statement = normalizeStatement(row);
    const key = relationshipKey(statement);
    const current = relationships.get(key);
    relationships.set(key, { ...statement, direction: current ? "both" : "incoming" });
  }

  return [...relationships.values()];
}

export async function deleteStatement(shelf: string, statement: Statement): Promise<void> {
  await runHypatia([
    "statement-delete",
    statement.subject,
    statement.predicate,
    statement.object,
    "--shelf",
    shelf
  ]);
}

export async function deleteKnowledge(shelf: string, name: string): Promise<void> {
  await runHypatia(["knowledge-delete", name, "--shelf", shelf]);
}
