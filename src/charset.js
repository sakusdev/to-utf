const SUPPORTED_ENCODINGS = new Set([
  "utf-8",
  "shift_jis",
  "euc-jp",
  "iso-2022-jp",
]);

export function detectAndDecode(contentType, bytes) {
  const headerLabel = normalizeCharset(extractHeaderCharset(contentType));
  const metaLabel = normalizeCharset(extractMetaCharset(bytes));
  const bomLabel = normalizeCharset(detectBom(bytes));
  const declared = bomLabel || headerLabel || metaLabel;

  const candidates = unique([
    declared,
    headerLabel,
    metaLabel,
    "utf-8",
    "shift_jis",
    "euc-jp",
    "iso-2022-jp",
  ]).filter(Boolean);

  let best = null;

  for (const charset of candidates) {
    const result = decodeCandidate(bytes, charset);
    if (!result) continue;

    let score = scoreDecodedText(result.text);
    if (charset === headerLabel) score += 50;
    if (charset === metaLabel) score += 80;
    if (headerLabel && headerLabel === metaLabel && charset === headerLabel) score += 35;
    if (charset === bomLabel) score += 1000;
    if (charset === "utf-8" && result.fatalSuccess) score += 35;
    if (charset === "utf-8" && result.fatalSuccess && containsJapanese(result.text)) score += 160;
    if (charset === "shift_jis" && containsJapanese(result.text)) score += 18;
    if (result.fatalSuccess) score += 20;

    if (!best || score > best.score) {
      best = {
        charset,
        text: stripBom(result.text),
        score,
        fatalSuccess: result.fatalSuccess,
      };
    }
  }

  if (!best) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      text: stripBom(text),
      charset: "utf-8",
      declaredCharset: declared,
      confidence: "low",
    };
  }

  const confidence = best.score >= 160 ? "high" : best.score >= 40 ? "medium" : "low";

  return {
    text: best.text,
    charset: best.charset,
    declaredCharset: declared,
    confidence,
  };
}

export function normalizeCharset(value) {
  if (!value) return null;
  const charset = String(value).trim().toLowerCase().replaceAll("_", "-");

  if (["shift-jis", "sjis", "x-sjis", "windows-31j", "ms-kanji", "cp932"].includes(charset)) {
    return "shift_jis";
  }
  if (["utf8", "utf-8"].includes(charset)) return "utf-8";
  if (["euc-jp", "eucjp", "x-euc-jp"].includes(charset)) return "euc-jp";
  if (["iso-2022-jp", "jis", "csiso2022jp"].includes(charset)) return "iso-2022-jp";

  return SUPPORTED_ENCODINGS.has(charset) ? charset : null;
}

function extractHeaderCharset(contentType = "") {
  const match = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return match?.[1] || null;
}

function extractMetaCharset(bytes) {
  const sample = asciiView(bytes.subarray(0, Math.min(bytes.byteLength, 16384)));
  const direct = sample.match(/<meta\b[^>]*?charset\s*=\s*["']?([^;"'\s/>]+)/i);
  if (direct) return direct[1];

  const httpEquiv = sample.match(
    /<meta\b[^>]*?content\s*=\s*["'][^"']*?charset\s*=\s*([^;"'\s/>]+)/i,
  );
  return httpEquiv?.[1] || null;
}

function detectBom(bytes) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  return null;
}

function decodeCandidate(bytes, charset) {
  try {
    const text = new TextDecoder(charset, { fatal: true }).decode(bytes);
    return { text, fatalSuccess: true };
  } catch {
    try {
      const text = new TextDecoder(charset, { fatal: false }).decode(bytes);
      return { text, fatalSuccess: false };
    } catch {
      return null;
    }
  }
}

function scoreDecodedText(text) {
  let score = 0;
  const replacements = countMatches(text, /\uFFFD/g);
  const controls = countMatches(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g);
  const mojibake = countMatches(text, /(?:縺[\x80-\uFFFF]|繧[\x80-\uFFFF]|譁[\x80-\uFFFF]|蜿[\x80-\uFFFF]|逕[\x80-\uFFFF])/g);
  const japanese = countMatches(text, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);

  score -= replacements * 500;
  score -= controls * 30;
  score -= mojibake * 20;
  score += Math.min(japanese, 300) * 0.25;

  if (/<!doctype\s+html|<html\b|<body\b|<title\b/i.test(text)) score += 30;
  if (/<\/?[a-z][^>]*>/i.test(text)) score += 10;
  if (/^[\x00-\x7F]*$/.test(text)) score += 5;

  return score;
}

function asciiView(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    output += value < 0x80 ? String.fromCharCode(value) : " ";
  }
  return output;
}

function containsJapanese(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function countMatches(text, pattern) {
  return text.match(pattern)?.length || 0;
}

function unique(values) {
  return [...new Set(values)];
}
