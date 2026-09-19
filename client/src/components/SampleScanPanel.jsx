import { useMemo, useState } from "react";
import { scanSamples } from "../api.js";
import { DEFAULT_SCAN_SAMPLES } from "../defaultSamples.js";

// Mirrors MAX_SCAN_SAMPLES on the server; checked before sending so the
// user gets the same message without a round trip.
const MAX_SCAN_SAMPLES = 200;

const CATEGORY_META = {
  both: { label: "两版均通过", chip: "scan-cat scan-cat--both" },
  baselineOnly: { label: "仅基线通过", chip: "scan-cat scan-cat--baseline" },
  currentOnly: { label: "仅当前通过", chip: "scan-cat scan-cat--current" },
  neither: { label: "两版均失败", chip: "scan-cat scan-cat--neither" },
};

// Summary chips follow the canonical order; the detail groups put the
// upgrade-blocking category (baselineOnly) first.
const SUMMARY_ORDER = ["both", "baselineOnly", "currentOnly", "neither"];
const GROUP_ORDER = ["baselineOnly", "currentOnly", "neither", "both"];

function ScanSide({ label, result }) {
  return (
    <div className={`ce-side ${result.valid ? "ce-side--ok" : "ce-side--err"}`}>
      <div className="ce-side__head">
        <span className={`ce-badge ${result.valid ? "ce-badge--ok" : "ce-badge--err"}`}>
          {result.valid ? "✓ 通过" : "✗ 拒绝"}
        </span>
        <span className="ce-side__label">{label}</span>
      </div>
      {!result.valid && result.errors.length > 0 && (
        <ul className="ce-errors">
          {result.errors.map((e, i) => (
            <li key={i} className="ce-error">
              <div className="ce-error__head">
                <code className="ce-error__pointer">{e.pointer}</code>
                <span className="flag flag--keyword">{e.keyword}</span>
              </div>
              <div className="ce-error__msg">{e.message}</div>
              <div className="ce-error__meta">
                规则：<code>{e.schemaPath}</code>
                {e.params && Object.keys(e.params).length > 0 && (
                  <>
                    {" "}
                    · 参数：<code>{JSON.stringify(e.params)}</code>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SampleScanPanel({ baselineSchema, currentSchema }) {
  const [text, setText] = useState(DEFAULT_SCAN_SAMPLES);
  const [inputError, setInputError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // The report together with the exact sample array it was computed from,
  // so later edits to the textarea never corrupt index -> sample mapping.
  const [scan, setScan] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  async function runScan() {
    setError(null);
    setScan(null);
    setExpanded(new Set());
    let samples;
    try {
      samples = JSON.parse(text);
    } catch (e) {
      setInputError(`JSON 解析失败：${e.message}`);
      return;
    }
    if (!Array.isArray(samples)) {
      setInputError("输入必须是一个 JSON 数组，每个元素为一份历史样本。");
      return;
    }
    if (samples.length > MAX_SCAN_SAMPLES) {
      setInputError(
        `单次最多扫描 ${MAX_SCAN_SAMPLES} 条样本（当前 ${samples.length} 条），请分批粘贴。`
      );
      return;
    }
    setInputError(null);
    setBusy(true);
    try {
      const report = await scanSamples(baselineSchema, currentSchema, samples);
      setScan({ report, samples });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleRow(index) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const groups = useMemo(() => {
    if (!scan) return [];
    const byCategory = new Map(GROUP_ORDER.map((c) => [c, []]));
    for (const row of scan.report.results) byCategory.get(row.category).push(row);
    return GROUP_ORDER.map((c) => [c, byCategory.get(c)]).filter(([, rows]) => rows.length > 0);
  }, [scan]);

  return (
    <div className="sample-scan">
      <div className="sample-scan__head">
        <span className="panel-label">样本影响扫描</span>
        <span className="panel__meta">
          粘贴历史样本 JSON 数组，用基线与当前两版 Schema 分别校验并归类（单次最多{" "}
          {MAX_SCAN_SAMPLES} 条）
        </span>
      </div>

      <textarea
        className={`code-input ${inputError ? "code-input--err" : ""}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={8}
        placeholder='[{"id": 1}, {"id": 2}]'
      />
      {inputError && <div className="parse-error">{inputError}</div>}

      <div className="actions">
        <button type="button" className="btn btn--primary" onClick={runScan} disabled={busy}>
          {busy ? "扫描中…" : "开始扫描"}
        </button>
      </div>

      {error && <div className="alert alert--err">{error}</div>}

      {scan && (
        <div className="scan-result">
          <div className="scan-summary">
            {SUMMARY_ORDER.map((c) => (
              <span key={c} className={CATEGORY_META[c].chip}>
                {scan.report.summary[c]} {CATEGORY_META[c].label}
              </span>
            ))}
            <span className="panel__meta">共 {scan.report.total} 条</span>
          </div>

          {scan.report.summary.baselineOnly > 0 && (
            <div className="alert alert--err">
              ✗ {scan.report.summary.baselineOnly} 条历史样本仅基线通过，按当前 Schema
              上线后将校验失败。
            </div>
          )}
          {scan.report.summary.baselineOnly === 0 && scan.report.total > 0 && (
            <div className="alert alert--ok">✓ 所有基线可接受的样本在当前 Schema 下仍可通过。</div>
          )}

          <div className="scan-groups">
            {groups.map(([category, rows]) => (
              <div key={category} className="scan-group">
                <div className="scan-group__head">
                  <span className={CATEGORY_META[category].chip}>
                    {CATEGORY_META[category].label}
                  </span>
                  <span className="panel__meta">
                    {rows.length} 条 · 样本索引{" "}
                    {rows.map((r) => `#${r.index}`).join("、")}
                  </span>
                </div>
                <ul className="scan-rows">
                  {rows.map((row) => {
                    const isOpen = expanded.has(row.index);
                    return (
                      <li key={row.index} className="scan-row">
                        <button
                          type="button"
                          className="scan-row__head"
                          onClick={() => toggleRow(row.index)}
                          aria-expanded={isOpen}
                        >
                          <span className={`tree-toggle ${isOpen ? "" : "tree-toggle--leaf"}`}>
                            {isOpen ? "▾" : "▸"}
                          </span>
                          <code className="scan-row__index">#{row.index}</code>
                          <span className="scan-row__preview">
                            {JSON.stringify(scan.samples[row.index])}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="scan-row__body">
                            <pre className="ce-sample">
                              {JSON.stringify(scan.samples[row.index], null, 2)}
                            </pre>
                            <ScanSide label="基线 Schema" result={row.baseline} />
                            <ScanSide label="当前 Schema" result={row.current} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
