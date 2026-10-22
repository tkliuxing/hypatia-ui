import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TAG_OPTIONS, tagOptions } from "../client/src/tagOptions.js";

const ROSTER = { shelf: "a", tags: ["work-unit", "memory", "Memory-Old", "rule", ""] };

test("tag options narrow the roster by a case-insensitive substring", () => {
  assert.deepEqual(tagOptions(ROSTER, "a", "mem"), ["memory", "Memory-Old"]);
  assert.deepEqual(tagOptions(ROSTER, "a", "  UNIT "), ["work-unit"]);
  assert.deepEqual(tagOptions(ROSTER, "a", " "), ["memory", "Memory-Old", "rule", "work-unit"]);
});

test("tag options never offer another shelf's roster", () => {
  assert.deepEqual(tagOptions(ROSTER, "b", ""), []);
  assert.deepEqual(tagOptions(null, "a", ""), []);
  assert.deepEqual(tagOptions({ shelf: "a", tags: null }, "a", ""), []);
});

test("tag options drop empty values and cap the list", () => {
  assert.deepEqual(tagOptions({ shelf: "a", tags: ["", "b"] }, "a", ""), ["b"]);
  const many = { shelf: "a", tags: Array.from({ length: 80 }, (_, index) => "tag-" + String(index).padStart(2, "0")) };
  assert.equal(tagOptions(many, "a", "").length, MAX_TAG_OPTIONS);
  assert.equal(tagOptions(many, "a", "", 3).length, 3);
});
