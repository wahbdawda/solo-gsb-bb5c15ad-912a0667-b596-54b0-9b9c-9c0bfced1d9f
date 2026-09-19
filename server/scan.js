"use strict";

/**
 * Historical-sample impact scan.
 *
 * Given the baseline schema, the current schema and a set of historical
 * samples, every sample is validated with Ajv against BOTH schemas and
 * classified into exactly one category:
 *
 *  - "both"         -> passes the baseline AND the current schema
 *  - "baselineOnly" -> passes the baseline, rejected by the current schema
 *                      (these are the samples an upgrade would break)
 *  - "currentOnly"  -> rejected by the baseline, passes the current schema
 *  - "neither"      -> fails both schemas
 *
 * The response carries the per-category counts plus one entry per sample
 * (its index into the submitted array, its category and both sides'
 * validation errors with JSON Pointer, keyword and message), so the UI can
 * group samples by category and expand any row to inspect why a side
 * rejected it. A scan is limited to MAX_SCAN_SAMPLES samples per request.
 */

const Ajv2020 = require("ajv/dist/2020").default;

const MAX_SCAN_SAMPLES = 200;

const CATEGORIES = ["both", "baselineOnly", "currentOnly", "neither"];

const ajv = new Ajv2020({ allErrors: true, strict: false });

function mapErrors(validate) {
  return (validate.errors || []).map((e) => ({
    path: e.instancePath || "",
    pointer: e.instancePath || "(root)",
    schemaPath: e.schemaPath,
    keyword: e.keyword,
    message: e.message,
    params: e.params,
  }));
}

function categorize(baselineValid, currentValid) {
  if (baselineValid && currentValid) return "both";
  if (baselineValid) return "baselineOnly";
  if (currentValid) return "currentOnly";
  return "neither";
}

/**
 * @returns {{ total: number,
 *            summary: { both: number, baselineOnly: number, currentOnly: number, neither: number },
 *            results: Array<{ index: number, category: string,
 *                            baseline: { valid: boolean, errors: object[] },
 *                            current: { valid: boolean, errors: object[] } }> }}
 */
function scanSamples({ baselineSchema, currentSchema, samples }) {
  let validateBaseline;
  let validateCurrent;
  try {
    validateBaseline = ajv.compile(baselineSchema);
    validateCurrent = ajv.compile(currentSchema);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  const summary = { both: 0, baselineOnly: 0, currentOnly: 0, neither: 0 };
  const results = samples.map((sample, index) => {
    const baselineValid = validateBaseline(sample);
    const currentValid = validateCurrent(sample);
    const category = categorize(baselineValid, currentValid);
    summary[category] += 1;
    return {
      index,
      category,
      baseline: { valid: baselineValid, errors: baselineValid ? [] : mapErrors(validateBaseline) },
      current: { valid: currentValid, errors: currentValid ? [] : mapErrors(validateCurrent) },
    };
  });

  return { total: samples.length, summary, results };
}

module.exports = { scanSamples, MAX_SCAN_SAMPLES, CATEGORIES };
