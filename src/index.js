import { detectAndDecode } from "./charset.js";
import { convertLegacyHtml } from "./legacy-reader.js";

const VERSION = "2.0.0";
const MAX_REDIRECTS = 5;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const SERVICE_PARAMS = new Set(["url", "format", "mode"]);

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return optionsResponse();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("GET / HEAD のみ対応しています。", 405, { Allow: "GET, HEAD, OPTIONS" });
    }

    const requestUrl = new URL(request.url);
    const options = parseOptions(requestUrl);
    const rawTarget = getTargetUrl(requestUrl);

    if (!rawTarget) return landingPage(requestUrl.origin);

    let target;
    try {
      target = new URL(rawTarget);
      validateTarget(target);
    } catch (error) {
      return errorResponse(`URLが不正です。\n\n${errorMessage(error)}`, 400, options.format);
    }

    try {
      const { response, finalUrl } = await fetchWithSafeRedirects(target, request.method);
      return await transformResponse({
        response,
        finalUrl,
        requestedUrl: target,
        proxyOrigin: requestUrl.origin,
        method: request.method,
        options,
      });
    } catch (error) {
      return errorResponse(`取得または変換に失敗しました。\n\n${errorMessage(error)}`, 502, options.format);
    }
  },
};

function parseOptions(requestUrl) {
  const requestedFormat = (requestUrl.searchParams.get("format") || "html").toLowerCase();
  const requestedMode = (requestUrl.searchParams.get("mode") || "complete").toLowerCase();
  const format = requestedFormat === "md" ? "markdown" : requestedFormat;

  return {
    format: ["html", "markdown", "json"].includes(format) ? format : "html",
    mode: ["complete", "article", "raw"].includes(requestedMode) ? requestedMode : "complete",
  };
}

function getTargetUrl(requestUrl) {
  const queryTarget = requestUrl.searchParams.get("url");
  if (queryTarget) return queryTarget;

  let path;
  try {
    path = decodeURIComponent(requestUrl.pathname.slice(1));
  } catch {
    return null;
  }

  if (!path.startsWith("http://") && !path.startsWith("https://")) return null;

  const target = new URL(path);
  for (const [name, value] of requestUrl.searchParams) {
    if (!SERVICE_PARAMS.has(name)) target.searchParams.append(name, value);
  }
  return target.href;
}

function validateTarget(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("http または https のURLだけ利用できます。");
  }
  if (url.username || url.password) throw new Error("認証情報を含むURLは利用できません。");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "::1" ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw new Error("ローカル・プライベートネットワークにはアクセスできません。");
  }

  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("80番・443番ポートのみ利用できます。");
  }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((value) => value < 0 || value > 255)) return false;

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname) {
  const value = hostname.toLowerCase();
  return (
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(?:1[6-9]|2\d|3[01])\./.test(value)
  );
}

async function fetchWithSafeRedirects(initialUrl, method) {
  let currentUrl = initialUrl;

  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    validateTarget(currentUrl);
    const response = await fetch(currentUrl, {
      method,
      redirect: "manual",
      headers: {
        Accept: "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": `2utf/${VERSION}`,
      },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) throw new Error("Locationのないリダイレクトが返されました。");
    currentUrl = new URL(location, currentUrl);
  }

  throw new Error("リダイレクト回数が多すぎます。");
}

async function transformResponse({ response, finalUrl, requestedUrl, proxyOrigin, method, options }) {
  const originalType = response.headers.get("content-type") || "application/octet-stream";
  const mime = originalType.split(";", 1)[0].trim().toLowerCase();

  if (method === "HEAD") {
    const outputType = options.format === "json"
      ? "application/json; charset=utf-8"
      : options.format === "markdown"
        ? "text/markdown; charset=utf-8"
        : originalType;
    return new Response(null, {
      status: response.status,
      headers: outputHeaders(response.headers, outputType, finalUrl),
    });
  }

  const likelyText = isTextMime(mime) || looksTextualByPath(finalUrl.pathname);
  if (!likelyText && options.format === "html") {
    return new Response(response.body, {
      status: response.status,
      headers: outputHeaders(response.headers, originalType, finalUrl),
    });
  }
  if (!likelyText) throw new Error("Markdown化できないバイナリ形式です。");

  const bytes = await readLimitedBody(response, MAX_TEXT_BYTES);
  const decoded = detectAndDecode(originalType, bytes);
  const isHtml = isHtmlMime(mime) || looksLikeHtml(decoded.text);

  if (options.format === "html") {
    let body = decoded.text;
    if (isHtml) body = rewriteHtml(body, finalUrl, proxyOrigin);
    const outputMime = isHtml ? "text/html" : isTextMime(mime) ? mime : "text/plain";
    const contentType = `${outputMime}; charset=utf-8`;
    const headers = outputHeaders(response.headers, contentType, finalUrl, decoded);
    return new Response(body, { status: response.status, headers });
  }

  const reader = isHtml
    ? convertLegacyHtml(decoded.text, finalUrl.href, options.mode)
    : plainTextReader(decoded.text, finalUrl.href, options.mode);

  const metadata = {
    converter: `2utf/${VERSION}`,
    source: {
      requestedUrl: requestedUrl.href,
      finalUrl: finalUrl.href,
      status: response.status,
      contentType: originalType,
      charset: decoded.charset,
      declaredCharset: decoded.declaredCharset,
      charsetConfidence: decoded.confidence,
    },
    extraction: {
      modeRequested: reader.modeRequested,
      modeApplied: reader.modeApplied,
      warnings: reader.warnings,
    },
    title: reader.title,
  };

  const contentType = options.format === "json"
    ? "application/json; charset=utf-8"
    : "text/markdown; charset=utf-8";
  const headers = outputHeaders(response.headers, contentType, finalUrl, decoded);
  headers.set("x-2utf-extraction-mode", reader.modeApplied);
  if (reader.warnings.length) headers.set("x-2utf-warning", encodeURIComponent(reader.warnings.join(" ")));

  if (options.format === "json") {
    return new Response(JSON.stringify({ ...metadata, markdown: reader.markdown, blocks: reader.blocks }, null, 2), {
      status: 200,
      headers,
    });
  }

  const warningPrefix = reader.warnings.length
    ? reader.warnings.map((warning) => `> [!WARNING]\n> ${warning}`).join("\n\n") + "\n\n"
    : "";
  return new Response(`${warningPrefix}${reader.markdown}`, { status: 200, headers });
}

async function readLimitedBody(response, limit) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > limit) throw new Error(`本文が大きすぎます（上限 ${limit / 1024 / 1024} MiB）。`);
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`本文が大きすぎます（上限 ${limit / 1024 / 1024} MiB）。`);
    }
    chunks.push(value);
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function plainTextReader(text, source, mode) {
  const markdown = [
    "---",
    'title: ""',
    `source: ${JSON.stringify(source)}`,
    `mode: ${mode}`,
    "---",
    "",
    text.trim() || "（本文を抽出できませんでした）",
    "",
  ].join("\n");

  return {
    title: "",
    markdown,
    blocks: text.trim() ? [{ type: "text", text: text.trim(), markdown: text.trim(), selector: "", sourceIndex: 0 }] : [],
    warnings: [],
    modeRequested: mode,
    modeApplied: mode,
  };
}

function rewriteHtml(html, finalUrl, proxyOrigin) {
  html = html.replace(
    /(<meta\b[^>]*?charset\s*=\s*)["']?[^\s"'/>;]+["']?/gi,
    '$1"utf-8"',
  );
  html = html.replace(
    /(<meta\b[^>]*?content\s*=\s*["'][^"']*?charset\s*=\s*)[^;\s"']+/gi,
    "$1utf-8",
  );

  html = html.replace(/\b(href|action)\s*=\s*(["'])(.*?)\2/gi, (match, attr, quote, value) => {
    if (/^(?:#|javascript:|mailto:|tel:|data:)/i.test(value)) return match;
    try {
      const absolute = new URL(value, finalUrl);
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return match;
      const proxied = `${proxyOrigin}/?url=${encodeURIComponent(absolute.href)}`;
      return `${attr}=${quote}${proxied}${quote}`;
    } catch {
      return match;
    }
  });

  const baseTag = `<base href="${escapeHtml(finalUrl.href)}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${baseTag}`);
  }
  return baseTag + html;
}

function isTextMime(mime) {
  return (
    mime.startsWith("text/") ||
    mime === "application/xhtml+xml" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/json"
  );
}

function isHtmlMime(mime) {
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function looksTextualByPath(pathname) {
  return /\.(?:html?|shtml?|xhtml|txt|xml|json|js|css|cgi|pl|php|asp|aspx|nsf)$/i.test(pathname);
}

function looksLikeHtml(text) {
  return /<!doctype\s+html|<html\b|<head\b|<body\b|<title\b|<frameset\b/i.test(text.slice(0, 16384));
}

function outputHeaders(source, contentType, finalUrl, decoded = null) {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cache-control", "public, max-age=300");
  headers.set("access-control-allow-origin", "*");
  headers.set("x-2utf-version", VERSION);
  headers.set("x-2utf-source", finalUrl.href.slice(0, 1024));
  if (decoded) {
    headers.set("x-2utf-original-encoding", decoded.charset);
    headers.set("x-2utf-charset-confidence", decoded.confidence);
  }

  const language = source.get("content-language");
  const modified = source.get("last-modified");
  if (language) headers.set("content-language", language);
  if (modified) headers.set("last-modified", modified);
  return headers;
}

function landingPage(origin) {
  const example = "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/topics/hyokei260609.html";
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>2utf Legacy Web Reader</title>
  <style>
    :root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:780px;margin:64px auto;padding:0 20px;line-height:1.7}
    form{display:grid;grid-template-columns:1fr auto auto auto;gap:8px}input,select,button{padding:11px;font-size:16px}code{overflow-wrap:anywhere}
    @media(max-width:700px){form{grid-template-columns:1fr}button{width:100%}}
  </style>
</head>
<body>
  <h1>2utf Legacy Web Reader</h1>
  <p>Shift_JIS・EUC-JP・ISO-2022-JPなどの古い日本語WebをUTF-8またはAI向けMarkdownへ変換します。</p>
  <form method="get" action="/">
    <input name="url" type="url" placeholder="https://example.jp/old-page.html" required>
    <select name="format" aria-label="出力形式">
      <option value="html">UTF-8 HTML</option>
      <option value="markdown">Markdown</option>
      <option value="json">JSON + 出典ブロック</option>
    </select>
    <select name="mode" aria-label="抽出モード">
      <option value="complete">完全</option>
      <option value="article">本文</option>
      <option value="raw">Raw</option>
    </select>
    <button type="submit">変換</button>
  </form>
  <h2>API</h2>
  <p><code>${escapeHtml(origin)}/?url=${encodeURIComponent(example)}&amp;format=markdown&amp;mode=complete</code></p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Accept, Content-Type",
      "access-control-max-age": "86400",
    },
  });
}

function errorResponse(message, status, format) {
  if (format === "json") {
    return new Response(JSON.stringify({ error: message, status }, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      },
    });
  }
  return textResponse(message, status);
}

function textResponse(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
