"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function post(pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test("GET /api/health", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("POST /api/infer returns schema, paths and count", async () => {
  const { status, data } = await post("/api/infer", {
    samples: [{ id: 1, tag: "x" }, { id: 2 }],
  });
  assert.equal(status, 200);
  assert.equal(data.sampleCount, 2);
  assert.equal(data.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(data.schema.required, ["id"]);
  assert.equal(typeof data.paths, "object");
});

test("POST /api/infer rejects missing samples", async () => {
  const { status, data } = await post("/api/infer", { samples: [] });
  assert.equal(status, 400);
  assert.match(data.error, /samples/);
});

test("POST /api/validate reports JSON Pointers for errors", async () => {
  const { data: inferred } = await post("/api/infer", {
    samples: [{ id: 1, user: { name: "a" } }],
  });
  const ok = await post("/api/validate", {
    schema: inferred.schema,
    sample: { id: 2, user: { name: "b" } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.valid, true);
  assert.deepEqual(ok.data.errors, []);

  const bad = await post("/api/validate", {
    schema: inferred.schema,
    sample: { id: "oops", user: {} },
  });
  assert.equal(bad.data.valid, false);
  const paths = bad.data.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ["/id", "/user"]);
  const idErr = bad.data.errors.find((e) => e.path === "/id");
  assert.equal(idErr.keyword, "type");
  assert.equal(idErr.pointer, "/id");
});

test("POST /api/validate rejects an invalid schema", async () => {
  const { status, data } = await post("/api/validate", {
    schema: { type: "not-a-type" },
    sample: 1,
  });
  assert.equal(status, 422);
  assert.match(data.error, /Invalid schema/);
});

test("POST /api/diff classifies changes per perspective", async () => {
  const oldS = (
    await post("/api/infer", { samples: [{ id: 1, name: "a" }] })
  ).data.schema;
  const newS = (await post("/api/infer", { samples: [{ id: 1 }] })).data.schema;

  const res = await post("/api/diff", { oldSchema: oldS, newSchema: newS, perspective: "response" });
  assert.equal(res.status, 200);
  assert.equal(res.data.perspective, "response");
  const removed = res.data.changes.find((c) => c.kind === "property-removed");
  assert.equal(removed.pointer, "/properties/name");
  assert.equal(removed.severity, "breaking");
  assert.equal(res.data.summary.breaking, 1);
  assert.ok(removed.oldRule && removed.newRule && removed.reason);

  const req = await post("/api/diff", { oldSchema: oldS, newSchema: newS, perspective: "request" });
  assert.equal(req.data.changes.find((c) => c.kind === "property-removed").severity, "info");
  assert.equal(req.data.summary.breaking, 0);
});

test("POST /api/diff defaults to the request perspective", async () => {
  const { status, data } = await post("/api/diff", { oldSchema: {}, newSchema: {} });
  assert.equal(status, 200);
  assert.equal(data.perspective, "request");
  assert.deepEqual(data.changes, []);
  assert.deepEqual(data.summary, { breaking: 0, compatible: 0, info: 0 });
});

test("POST /api/diff validates its input", async () => {
  const missing = await post("/api/diff", { oldSchema: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /newSchema/);

  const badPerspective = await post("/api/diff", {
    oldSchema: {},
    newSchema: {},
    perspective: "sideways",
  });
  assert.equal(badPerspective.status, 400);
  assert.match(badPerspective.data.error, /perspective/);
});

test("POST /api/counterexample builds a request witness verified on both sides", async () => {
  const oldS = (
    await post("/api/infer", { samples: [{ id: 1, phone: null }, { id: 2, phone: "x" }] })
  ).data.schema;
  const newS = (await post("/api/infer", { samples: [{ id: 1, phone: "x" }] })).data.schema;

  const res = await post("/api/counterexample", {
    oldSchema: oldS,
    newSchema: newS,
    perspective: "request",
    kind: "type",
    pointer: "/properties/phone",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.constructible, true);
  assert.equal(res.data.perspective, "request");
  assert.deepEqual(res.data.sample, { id: 0, phone: null });
  assert.equal(res.data.oldResult.valid, true);
  assert.deepEqual(res.data.oldResult.errors, []);
  assert.equal(res.data.newResult.valid, false);
  assert.ok(res.data.newResult.errors.length > 0);
  assert.equal(res.data.newResult.errors[0].pointer, "/phone");
});

test("POST /api/counterexample covers response direction and items changes", async () => {
  const oldS = (await post("/api/infer", { samples: [{ xs: [1] }] })).data.schema;
  const newS = (await post("/api/infer", { samples: [{ xs: [] }] })).data.schema;
  const res = await post("/api/counterexample", {
    oldSchema: oldS,
    newSchema: newS,
    perspective: "response",
    kind: "items-removed",
    pointer: "/properties/xs/items",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.constructible, true);
  assert.equal(res.data.newResult.valid, true);
  assert.equal(res.data.oldResult.valid, false);
  assert.equal(res.data.oldResult.errors[0].path, "/xs/0");
});

test("POST /api/counterexample returns a reason when no witness exists", async () => {
  const oldS = {
    type: "object",
    properties: { phone: { type: ["null", "string"], enum: ["x"] } },
    required: ["phone"],
  };
  const newS = {
    type: "object",
    properties: { phone: { type: "string", enum: ["x"] } },
    required: ["phone"],
  };
  const res = await post("/api/counterexample", {
    oldSchema: oldS,
    newSchema: newS,
    perspective: "request",
    kind: "type",
    pointer: "/properties/phone",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.constructible, false);
  assert.ok(typeof res.data.reason === "string" && res.data.reason.length > 0);
  assert.equal(res.data.sample, undefined);
});

test("POST /api/counterexample validates its input", async () => {
  const missingSchema = await post("/api/counterexample", { oldSchema: {} });
  assert.equal(missingSchema.status, 400);
  assert.match(missingSchema.data.error, /newSchema/);

  const badPerspective = await post("/api/counterexample", {
    oldSchema: {},
    newSchema: {},
    perspective: "nope",
    kind: "type",
    pointer: "",
  });
  assert.equal(badPerspective.status, 400);
  assert.match(badPerspective.data.error, /perspective/);

  const missingKind = await post("/api/counterexample", {
    oldSchema: {},
    newSchema: {},
    pointer: "",
  });
  assert.equal(missingKind.status, 400);
  assert.match(missingKind.data.error, /kind/);

  const badPointer = await post("/api/counterexample", {
    oldSchema: {},
    newSchema: {},
    kind: "type",
    pointer: "bad",
  });
  assert.equal(badPointer.status, 400);
  assert.match(badPointer.data.error, /JSON Pointer/);

  const badKind = await post("/api/counterexample", {
    oldSchema: {},
    newSchema: {},
    kind: "nope",
    pointer: "",
  });
  assert.equal(badKind.status, 400);
  assert.match(badKind.data.error, /暂不支持/);
});

test("POST /api/counterexample rejects an invalid schema with 422", async () => {
  const res = await post("/api/counterexample", {
    oldSchema: { type: "not-a-type" },
    newSchema: {},
    kind: "type",
    pointer: "",
  });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /Invalid schema/);
});

test("POST /api/scan-samples classifies samples against both schemas", async () => {
  const baseline = (await post("/api/infer", { samples: [{ id: 1, name: "a" }] })).data.schema;
  const current = (
    await post("/api/infer", { samples: [{ id: 1, name: "a", email: "a@x.com" }] })
  ).data.schema;

  const res = await post("/api/scan-samples", {
    baselineSchema: baseline,
    currentSchema: current,
    samples: [
      { id: 2, name: "b", email: "b@x.com" }, // both
      { id: 3, name: "c" }, // baselineOnly
      { id: "oops", name: "d" }, // neither
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 3);
  assert.deepEqual(res.data.summary, { both: 1, baselineOnly: 1, currentOnly: 0, neither: 1 });
  assert.deepEqual(
    res.data.results.map((r) => [r.index, r.category]),
    [
      [0, "both"],
      [1, "baselineOnly"],
      [2, "neither"],
    ]
  );
  const breaking = res.data.results[1];
  assert.equal(breaking.baseline.valid, true);
  assert.deepEqual(breaking.baseline.errors, []);
  assert.equal(breaking.current.valid, false);
  assert.equal(breaking.current.errors[0].keyword, "required");
  assert.equal(breaking.current.errors[0].params.missingProperty, "email");
});

test("POST /api/scan-samples rejects a non-array samples payload", async () => {
  const missing = await post("/api/scan-samples", { baselineSchema: {}, currentSchema: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /samples/);

  const notArray = await post("/api/scan-samples", {
    baselineSchema: {},
    currentSchema: {},
    samples: { id: 1 },
  });
  assert.equal(notArray.status, 400);
  assert.match(notArray.data.error, /'samples' array/);
});

test("POST /api/scan-samples enforces the 200-sample limit", async () => {
  const over = await post("/api/scan-samples", {
    baselineSchema: {},
    currentSchema: {},
    samples: Array.from({ length: 201 }, (_, i) => ({ i })),
  });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /200/);
  assert.match(over.data.error, /201/);

  const atLimit = await post("/api/scan-samples", {
    baselineSchema: {},
    currentSchema: {},
    samples: Array.from({ length: 200 }, (_, i) => ({ i })),
  });
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.data.total, 200);
  assert.equal(atLimit.data.summary.both, 200);
});

test("POST /api/scan-samples validates schemas and reports 422 on invalid ones", async () => {
  const missing = await post("/api/scan-samples", { currentSchema: {}, samples: [] });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /baselineSchema/);

  const invalid = await post("/api/scan-samples", {
    baselineSchema: {},
    currentSchema: { type: "not-a-type" },
    samples: [{}],
  });
  assert.equal(invalid.status, 422);
  assert.match(invalid.data.error, /Invalid schema/);
});

test("malformed JSON body gets a JSON 400", async () => {
  const res = await fetch(`${base}/api/infer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

test("unknown API route returns JSON 404", async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.ok(data.error);
});
