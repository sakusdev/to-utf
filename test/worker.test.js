import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("Worker returns Markdown and JSON provenance", async () => {
  const originalFetch = globalThis.fetch;
  const source = `<html><head><title>議会</title></head><body><main><h1>議会</h1><p>日本語の本文です。</p></main></body></html>`;
  globalThis.fetch = async () => new Response(new TextEncoder().encode(source), {
    status: 200,
    headers: { "content-type": "text/html; charset=Shift_JIS" },
  });

  try {
    const target = encodeURIComponent("https://example.jp/legacy.html");
    const markdownResponse = await worker.fetch(new Request(`https://2utf.test/?url=${target}&format=markdown&mode=complete`));
    assert.equal(markdownResponse.status, 200);
    assert.match(markdownResponse.headers.get("content-type"), /text\/markdown/);
    assert.equal(markdownResponse.headers.get("x-2utf-original-encoding"), "utf-8");
    const markdown = await markdownResponse.text();
    assert.match(markdown, /# 議会/);
    assert.match(markdown, /日本語の本文です/);

    const jsonResponse = await worker.fetch(new Request(`https://2utf.test/?url=${target}&format=json&mode=complete`));
    const payload = await jsonResponse.json();
    assert.equal(payload.source.charset, "utf-8");
    assert.ok(payload.blocks.some((block) => block.type === "paragraph"));
    assert.ok(payload.blocks.some((block) => block.selector.includes("p")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker keeps UTF-8 HTML mode backward compatible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html><head><meta charset=Shift_JIS></head><body><a href=\"next.html\">次へ</a></body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  try {
    const target = encodeURIComponent("https://example.jp/old/index.html");
    const response = await worker.fetch(new Request(`https://2utf.test/?url=${target}`));
    const html = await response.text();
    assert.match(response.headers.get("content-type"), /text\/html; charset=utf-8/);
    assert.match(html, /<base href="https:\/\/example\.jp\/old\/index\.html">/);
    assert.match(html, /https:\/\/2utf\.test\/\?url=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
