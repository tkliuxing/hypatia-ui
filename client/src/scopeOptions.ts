import type { Knowledge } from "./api";

export const GLOBAL_SCOPE_TOKEN = "__global__";

// scopes is null when the CLI could not list them.
export interface ScopeRoster {
  shelf: string;
  scopes: string[] | null;
}

export interface ScopeOptions {
  values: string[];
  hasGlobal: boolean;
}

// The roster from `hypatia scope list` when it was read for this shelf, else
// the scopes of the rows on the page. The selected value is always offered, so
// the controlled select never holds a value missing from its own options.
export function scopeOptions(roster: ScopeRoster | null, shelf: string, items: readonly Knowledge[], selected: string): ScopeOptions {
  const shelfScopes = roster?.shelf === shelf ? roster.scopes : null;
  const source = shelfScopes ?? items.flatMap((item) => item.content.scopes);
  const values = new Set<string>();
  let hasGlobal = selected === GLOBAL_SCOPE_TOKEN;
  for (const scope of source) {
    if (scope === "") hasGlobal = true;
    else values.add(scope);
  }
  if (selected && selected !== GLOBAL_SCOPE_TOKEN) values.add(selected);
  return { values: [...values].sort((left, right) => left.localeCompare(right)), hasGlobal };
}
