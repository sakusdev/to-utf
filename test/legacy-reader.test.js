import test from "node:test";
import assert from "node:assert/strict";
import { detectAndDecode } from "../src/charset.js";
import { convertLegacyHtml } from "../src/legacy-reader.js";

test("decodes Windows-31J compatible Shift_JIS", () => {
  const bytes = new Uint8Array([0x93, 0xfa, 0x96, 0x7b]);
  const decoded = detectAndDecode("text/plain; charset=Shift_JIS", bytes);
  assert.equal(decoded.text, "日本");
  assert.equal(decoded.charset, "shift_jis");
});

test("converts ruby, definitions and absolute links", () => {
  const html = `<!doctype html><html><head><title>例</title></head><body>
    <h1>資料</h1>
    <p><ruby>衆議院<rt>しゅうぎいん</rt></ruby>の<a href="../about">案内</a></p>
    <dl><dt>会期</dt><dd>百五十日間</dd></dl>
  </body></html>`;
  const result = convertLegacyHtml(html, "https://example.jp/docs/page.html", "complete");
  assert.match(result.markdown, /衆議院（しゅうぎいん）/);
  assert.match(result.markdown, /\[案内\]\(https:\/\/example\.jp\/about\)/);
  assert.match(result.markdown, /\*\*会期\*\*/);
  assert.match(result.markdown, /: 百五十日間/);
});

test("keeps complex tables as HTML and exposes a grid", () => {
  const html = `<html><body><table>
    <tr><th rowspan="2">都道府県</th><th colspan="2">人口</th></tr>
    <tr><th>男</th><th>女</th></tr>
    <tr><td>東京</td><td>1</td><td>2</td></tr>
  </table></body></html>`;
  const result = convertLegacyHtml(html, "https://example.jp/stats", "complete");
  assert.match(result.markdown, /<table>/);
  const table = result.blocks.find((block) => block.type === "table");
  assert.ok(table);
  assert.equal(table.table.complex, true);
  assert.deepEqual(table.table.rows[2], ["東京", "1", "2"]);
});

test("article mode selects the main article", () => {
  const paragraphs = Array.from({ length: 8 }, (_, index) => `<p>これは本文の段落${index + 1}です。議会に関する詳しい説明を掲載しています。</p>`).join("");
  const html = `<html><body>
    <nav><a href="/1">ホーム</a><a href="/2">一覧</a></nav>
    <div id="main-content"><h1>議会資料</h1>${paragraphs}</div>
    <footer>著作権情報</footer>
  </body></html>`;
  const result = convertLegacyHtml(html, "https://example.jp/page", "article");
  assert.equal(result.modeApplied, "article");
  assert.match(result.markdown, /議会資料/);
  assert.doesNotMatch(result.markdown, /著作権情報/);
});

test("article mode falls back without silently dropping small pages", () => {
  const html = `<html><body><nav>案内</nav><p>短い告知です。</p><footer>連絡先</footer></body></html>`;
  const result = convertLegacyHtml(html, "https://example.jp/notice", "article");
  assert.equal(result.modeApplied, "complete");
  assert.equal(result.warnings.length, 1);
  assert.match(result.markdown, /短い告知です/);
  assert.match(result.markdown, /連絡先/);
});

test("prefers valid Japanese UTF-8 over a misleading Shift_JIS header", () => {
  const bytes = new TextEncoder().encode("<html><body>日本語の本文です。</body></html>");
  const decoded = detectAndDecode("text/html; charset=Shift_JIS", bytes);
  assert.equal(decoded.charset, "utf-8");
  assert.match(decoded.text, /日本語/);
});
