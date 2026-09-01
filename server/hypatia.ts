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
  return {
    data: asString(source.data),
    format: asString(source.format) || "markdown",
    tags: asStringArray(source.tags),
    scopes: asStringArray(source.scopes),
    figures: asStringArray(source.figures)
  };
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
    subject: asString(value.subject),
    predicate: asString(value.predicate),
    object: asString(value.object),
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

export function runHypatia(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const run = commandTail.then(() => executeHypatia(args), () => executeHypatia(args));
  commandTail = run.then(() => undefined, () => undefined);
  return run;
}

export async function queryHypatia(shelf: string, jse: unknown): Promise<JsonRecord[]> {
  const result = await runHypatia(["query", JSON.stringify(jse), "--shelf", shelf]);
  return parseCliRows(result.stdout);
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

export async function getKnowledge(shelf: string, name: string): Promise<Knowledge | null> {
  const result = await runHypatia(["knowledge-get", name, "--shelf", shelf]);
  const row = parseCliObject(result.stdout);
  return row ? normalizeKnowledge(row) : null;
}

function relationshipKey(statement: Statement): string {
  return [statement.subject, statement.predicate, statement.object].join("\u0000");
}

export async function getRelationships(shelf: string, name: string): Promise<Relationship[]> {
  const results = await Promise.all([
    queryHypatia(shelf, ["$statement", ["$triple", name, "$*", "$*"]]),
    queryHypatia(shelf, ["$statement", ["$triple", "$*", "$*", name]])
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
