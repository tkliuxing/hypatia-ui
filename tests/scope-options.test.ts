import assert from "node:assert/strict";
import test from "node:test";
import type { Knowledge } from "../client/src/api.js";
import { GLOBAL_SCOPE_TOKEN, scopeOptions } from "../client/src/scopeOptions.js";

function record(name: string, scopes: string[]): Knowledge {
  return { name, createdAt: "", content: { data: "", format: "markdown", tags: [], scopes, figures: [] } };
}

const PAGE = [record("one", ["page-b", ""]), record("two", ["page-a", "page-b"])];
const FROM_PAGE = { values: ["page-a", "page-b"], hasGlobal: true };

test("scope options come from the shelf roster when the CLI can list scopes", () => {
  assert.deepEqual(scopeOptions({ shelf: "a", scopes: ["zeta", "alpha"] }, "a", PAGE, ""), { values: ["alpha", "zeta"], hasGlobal: false });
  assert.deepEqual(scopeOptions({ shelf: "a", scopes: ["", "alpha"] }, "a", PAGE, ""), { values: ["alpha"], hasGlobal: true });
  assert.deepEqual(scopeOptions({ shelf: "a", scopes: [] }, "a", PAGE, ""), { values: [], hasGlobal: false });
});

test("scope options fall back to the rows on the page without a usable roster", () => {
  assert.deepEqual(scopeOptions({ shelf: "a", scopes: null }, "a", PAGE, ""), FROM_PAGE);
  assert.deepEqual(scopeOptions(null, "a", PAGE, ""), FROM_PAGE);
});

test("scope options never offer the roster of another shelf", () => {
  assert.deepEqual(scopeOptions({ shelf: "a", scopes: ["alpha"] }, "b", PAGE, ""), FROM_PAGE);
});

test("the selected scope stays selectable when the source does not name it", () => {
  assert.deepEqual(scopeOptions({ shelf: "a", scopes: ["alpha"] }, "a", [], "gone"), { values: ["alpha", "gone"], hasGlobal: false });
  assert.deepEqual(scopeOptions({ shelf: "a", scopes: ["alpha"] }, "a", [], GLOBAL_SCOPE_TOKEN), { values: ["alpha"], hasGlobal: true });
  assert.deepEqual(scopeOptions(null, "a", PAGE, "gone"), { values: ["gone", "page-a", "page-b"], hasGlobal: true });
});
