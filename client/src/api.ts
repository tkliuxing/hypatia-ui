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

export interface Relationship {
  subject: string;
  predicate: string;
  object: string;
  createdAt: string;
  direction: "incoming" | "outgoing" | "both";
  content: KnowledgeContent;
}

export interface Shelf {
  name: string;
  path: string;
  connected: boolean;
}

export interface KnowledgePage {
  items: Knowledge[];
  total: number;
  page: number;
  limit: number;
}

export interface Impact {
  knowledge: Knowledge;
  relationships: Relationship[];
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "Request failed.");
  }
  return body as T;
}

export function getShelves(): Promise<{ shelves: Shelf[] }> {
  return request("/api/shelves");
}

export function getKnowledgePage(params: { shelf: string; q: string; tag: string; scope: string; page?: number; limit?: number }): Promise<KnowledgePage> {
  const search = new URLSearchParams();
  search.set("shelf", params.shelf);
  if (params.q) search.set("q", params.q);
  if (params.tag) search.set("tag", params.tag);
  if (params.scope) search.set("scope", params.scope);
  search.set("page", String(params.page || 1));
  search.set("limit", String(params.limit || 50));
  return request("/api/knowledge?" + search.toString());
}

export function getImpact(shelf: string, name: string): Promise<Impact> {
  const search = new URLSearchParams({ shelf });
  return request("/api/knowledge/" + encodeURIComponent(name) + "/impact?" + search.toString());
}

export function deleteKnowledge(shelf: string, name: string, deleteRelations: boolean, acknowledgedName: string): Promise<{ name: string; deletedRelations: number; retainedRelations: number }> {
  const search = new URLSearchParams({ shelf });
  return request("/api/knowledge/" + encodeURIComponent(name) + "?" + search.toString(), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deleteRelations, acknowledgedName })
  });
}
