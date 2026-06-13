import test from "node:test";
import assert from "node:assert/strict";
import router from "../src/host-router.js";

test("md.2utf.sakus.org defaults to Markdown output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><head><title>例</title></head><body><h1>本文</h1></body></html>",
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

  try {
    const target = encodeURIComponent("https://example.jp/page.html");
    const response = await router.fetch(
      new Request(`https://md.2utf.sakus.org/?url=${target}`),
    );

    assert.match(response.headers.get("content-type"), /text\/markdown/);
    assert.match(await response.text(), /# 本文/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit format overrides the Markdown subdomain default", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><body><p>HTML出力</p></body></html>",
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

  try {
    const target = encodeURIComponent("https://example.jp/page.html");
    const response = await router.fetch(
      new Request(`https://md.2utf.sakus.org/?url=${target}&format=html`),
    );

    assert.match(response.headers.get("content-type"), /text\/html/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
