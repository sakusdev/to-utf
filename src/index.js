const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("GET / HEAD のみ対応しています。", 405, {
        Allow: "GET, HEAD",
      });
    }

    const requestUrl = new URL(request.url);
    const rawTarget = getTargetUrl(requestUrl);

    if (!rawTarget) {
      return landingPage(requestUrl.origin);
    }

    let target;
    try {
      target = new URL(rawTarget);
      validateTarget(target);
    } catch (error) {
      return textResponse(`URLが不正です。\n\n${errorMessage(error)}`, 400);
    }

    try {
      const { response, finalUrl } = await fetchWithSafeRedirects(target, request.method);
      return await convertResponse(response, finalUrl, requestUrl.origin, request.method);
    } catch (error) {
      return textResponse(`取得または変換に失敗しました。\n\n${errorMessage(error)}`, 502);
    }
  },
};

function getTargetUrl(requestUrl) {
  const queryTarget = requestUrl.searchParams.get("url");
  if (queryTarget) return queryTarget;

  const path = decodeURIComponent(requestUrl.pathname.slice(1));
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path + requestUrl.search;
  }

  return null;
}

function validateTarget(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("http または https のURLだけ利用できます。");
  }

  if (url.username || url.password) {
    throw new Error("認証情報を含むURLは利用できません。");
  }

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
    value.startsWith("::ffff:192.168.")
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
        "User-Agent": "utf8convert.sakus.org/1.0",
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

async function convertResponse(response, finalUrl, proxyOrigin, method) {
  const originalType = response.headers.get("content-type") || "application/octet-stream";
  const mime = originalType.split(";", 1)[0].trim().toLowerCase();
  const isConvertible =
    mime.startsWith("text/") ||
    mime === "application/xhtml+xml" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/json";

  if (method === "HEAD") {
    return new Response(null, {
      status: response.status,
      headers: safeHeaders(response.headers, originalType),
    });
  }

  if (!isConvertible) {
    const headers = safeHeaders(response.headers, originalType);
    return new Response(response.body, { status: response.status, headers });
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_HTML_BYTES) {
    throw new Error(`本文が大きすぎます（上限 ${MAX_HTML_BYTES / 1024 / 1024} MiB）。`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_HTML_BYTES) {
    throw new Error(`本文が大きすぎます（上限 ${MAX_HTML_BYTES / 1024 / 1024} MiB）。`);
  }

  const charset = detectCharset(originalType, bytes);
  const decoder = new TextDecoder(charset, { fatal: false });
  let body = decoder.decode(bytes);

  if (mime === "text/html" || mime === "application/xhtml+xml") {
    body = rewriteHtml(body, finalUrl, proxyOrigin);
  }

  const headers = safeHeaders(response.headers, `${mime}; charset=utf-8`);
  headers.delete("content-length");
  headers.set("x-utf8convert-source", finalUrl.href);
  headers.set("x-utf8convert-original-encoding", charset);

  return new Response(body, {
    status: response.status,
    headers,
  });
}

function detectCharset(contentType, bytes) {
  const headerMatch = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  if (headerMatch) return normalizeCharset(headerMatch[1]);

  const sample = new TextDecoder("windows-1252").decode(bytes.slice(0, 4096));
  const metaMatch = sample.match(/charset\s*=\s*["']?([^;"'\s/>]+)/i);
  if (metaMatch) return normalizeCharset(metaMatch[1]);

  return "shift_jis";
}

function normalizeCharset(value) {
  const charset = value.trim().toLowerCase().replaceAll("_", "-");

  if (["shift-jis", "sjis", "x-sjis", "windows-31j", "ms-kanji", "cp932"].includes(charset)) {
    return "shift_jis";
  }
  if (["utf8", "utf-8"].includes(charset)) return "utf-8";
  if (["euc-jp", "eucjp"].includes(charset)) return "euc-jp";
  if (["iso-2022-jp", "jis"].includes(charset)) return "iso-2022-jp";

  return charset;
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

  const baseTag = `<base href="${escapeHtml(finalUrl.href)}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${baseTag}`);
  } else {
    html = baseTag + html;
  }

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

  return html;
}

function safeHeaders(source, contentType) {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cache-control", "public, max-age=300");

  const allowed = ["content-language", "etag", "last-modified"];
  for (const name of allowed) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }

  return headers;
}

function landingPage(origin) {
  const example = "http://example.com/old-page.html";
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>UTF-8 Convert</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:720px;margin:64px auto;padding:0 20px;line-height:1.7}
    form{display:flex;gap:8px}input{flex:1;padding:12px;font-size:16px}button{padding:12px 18px}
    code{overflow-wrap:anywhere}
  </style>
</head>
<body>
  <h1>Shift_JIS → UTF-8</h1>
  <p>古いWebページを取得し、UTF-8へ変換して表示します。</p>
  <form method="get" action="/">
    <input name="url" type="url" placeholder="https://example.com/page.html" required>
    <button type="submit">変換</button>
  </form>
  <p>API形式: <code>${escapeHtml(origin)}/?url=${encodeURIComponent(example)}</code></p>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function textResponse(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
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
