"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferSchema } = require("../infer");
const { scanSamples, MAX_SCAN_SAMPLES, CATEGORIES } = require("../scan");

const baseline = inferSchema([{ id: 1, name: "a" }, { id: 2, name: "b" }]).schema;
const current = inferSchema([{ id: 1, name: "a", email: "a@x.com" }]).schema;

test("every sample lands in exactly one of the four categories", () => {
  const report = scanSamples({
    baselineSchema: baseline,
    currentSchema: current,
    samples: [
      { id: 3, name: "c", email: "c@x.com" }, // both
      { id: 4, name: "d" }, // baselineOnly: missing the newly required email
      { id: "oops", name: "e", email: "e@x.com" }, // neither: id type fails both
      { id: "oops", name: "f" }, // neither
    ],
  });
  assert.equal(report.total, 4);
  assert.deepEqual(Object.keys(report.summary).sort(), [...CATEGORIES].sort());
  const categories = report.results.map((r) => r.category);
  for (const category of categories) {
    assert.ok(CATEGORIES.includes(category), `unknown category ${category}`);
  }
  const sum = CATEGORIES.reduce((acc, c) => acc + report.summary[c], 0);
  assert.equal(sum, report.total);
});

test("classifies all four categories with correct counts and indices", () => {
  const report = scanSamples({
    baselineSchema: baseline,
    currentSchema: current,
    samples: [
      { id: 3, name: "c", email: "c@x.com" }, // both
      { id: 4, name: "d" }, // baselineOnly
      { id: 5, name: "e", email: "e@x.com" }, // both
      { id: "oops", name: "f" }, // neither (id type fails both)
    ],
  });
  assert.deepEqual(report.summary, { both: 2, baselineOnly: 1, currentOnly: 0, neither: 1 });
  assert.deepEqual(
    report.results.map((r) => [r.index, r.category]),
    [
      [0, "both"],
      [1, "baselineOnly"],
      [2, "both"],
      [3, "neither"],
    ]
  );
});

test("a sample only the current schema accepts is currentOnly", () => {
  // Baseline requires `name` to be a string; current (inferred from a null
  // sighting) also accepts null -> null passes current only.
  const widened = inferSchema([{ id: 1, name: "a" }, { id: 2, name: null }]).schema;
  const report = scanSamples({
    baselineSchema: baseline,
    currentSchema: widened,
    samples: [{ id: 3, name: null }],
  });
  assert.deepEqual(report.summary, { both: 0, baselineOnly: 0, currentOnly: 1, neither: 0 });
  assert.equal(report.results[0].category, "currentOnly");
  assert.equal(report.results[0].baseline.valid, false);
  assert.equal(report.results[0].current.valid, true);
});

test("failing sides carry JSON Pointer, keyword and message; passing sides are empty", () => {
  const report = scanSamples({
    baselineSchema: baseline,
    currentSchema: current,
    samples: [{ id: 3, name: "c" }],
  });
  const [row] = report.results;
  assert.equal(row.category, "baselineOnly");
  assert.deepEqual(row.baseline, { valid: true, errors: [] });
  assert.equal(row.current.valid, false);
  const err = row.current.errors[0];
  assert.equal(err.pointer, "(root)");
  assert.equal(err.keyword, "required");
  assert.ok(typeof err.message === "string" && err.message.length > 0);
  assert.equal(err.params.missingProperty, "email");
  assert.ok(err.schemaPath.startsWith("#/"));
});

test("type errors report the instance JSON Pointer", () => {
  const report = scanSamples({
    baselineSchema: baseline,
    currentSchema: current,
    samples: [{ id: "oops", name: "c", email: "c@x.com" }],
  });
  const [row] = report.results;
  assert.equal(row.category, "neither");
  const idErr = row.baseline.errors.find((e) => e.path === "/id");
  assert.ok(idErr, "baseline must report the /id type error");
  assert.equal(idErr.keyword, "type");
  assert.equal(idErr.pointer, "/id");
});

test("an empty sample set scans to all-zero counts", () => {
  const report = scanSamples({ baselineSchema: baseline, currentSchema: current, samples: [] });
  assert.equal(report.total, 0);
  assert.deepEqual(report.summary, { both: 0, baselineOnly: 0, currentOnly: 0, neither: 0 });
  assert.deepEqual(report.results, []);
});

test("the documented limit is 200 samples per scan", () => {
  assert.equal(MAX_SCAN_SAMPLES, 200);
});

test("an invalid schema throws a 422-style error", () => {
  assert.throws(
    () =>
      scanSamples({
        baselineSchema: { type: "not-a-type" },
        currentSchema: current,
        samples: [{}],
      }),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /Invalid schema/);
      return true;
    }
  );
});
