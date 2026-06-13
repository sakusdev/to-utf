import { parseHtml, walk, findFirst, hasAncestor, ignored, hidden, plainText, normalizeSpace, nodePath } from "./html-parser.js";
import { tableData, tableMarkdown } from "./table.js";

const BLOCK = new Set(["address","article","aside","blockquote","body","dd","details","div","dl","dt","fieldset","figcaption","figure","footer","form","h1","h2","h3","h4","h5","h6","header","hr","li","main","nav","ol","p","pre","section","summary","table","ul"]);
const PROVENANCE = new Set(["h1","h2","h3","h4","h5","h6","p","li","dt","dd","blockquote","pre","figcaption","table"]);
const BAD = /(?:nav|menu|sidebar|footer|header|breadcrumb|utility|advert|banner|related|social|share|copyright)/i;
const GOOD = /(?:main|content|article|entry|post|body|honbun|kiji|contents?)/i;

export function convertLegacyHtml(html, baseUrl, requestedMode = "complete") {
  const document = parseHtml(html);
  const title = titleOf(document);
  const selected = selectScope(document, requestedMode);
  const context = { baseUrl: new URL(baseUrl), mode: selected.modeApplied };
  const body = normalizeMarkdown(renderChildren(selected.scope, context));
  const markdown = [
    "---",
    `title: ${JSON.stringify(title || "")}`,
    `source: ${JSON.stringify(baseUrl)}`,
    `mode: ${selected.modeApplied}`,
    "---",
    "",
    body || "（本文を抽出できませんでした）",
    "",
  ].join("\n");

  return {
    title,
    markdown,
    blocks: blocksOf(selected.scope, context),
    warnings: selected.warnings,
    modeRequested: requestedMode,
    modeApplied: selected.modeApplied,
  };
}

function selectScope(document, requested) {
  const mode = ["complete","article","raw"].includes(requested) ? requested : "complete";
  if (mode !== "article") return { scope: document, modeApplied: mode, warnings: [] };

  const candidates = [];
  walk(document, (n) => {
    if (n.type !== "element" || !["main","article","section","div","td","body"].includes(n.tagName)) return;
    const m = metrics(n);
    if (m.text < 120) return;
    const hint = `${n.attributes.id || ""} ${n.attributes.class || ""}`;
    let score = m.text - m.links * 1.8 + m.paragraphs * 70 + m.headings * 35 + m.punctuation * 3;
    if (n.tagName === "main") score += 500;
    if (n.tagName === "article") score += 420;
    if (GOOD.test(hint)) score += 220;
    if (BAD.test(hint)) score -= 700;
    candidates.push({ n, m, score });
  });
  candidates.sort((a, b) => b.score - a.score || a.n.startIndex - b.n.startIndex);
  const best = candidates[0];
  if (!best || best.score < 320 || best.m.text < 220 || best.n.tagName === "body") {
    return { scope: document, modeApplied: "complete", warnings: ["本文領域を高信頼で特定できなかったため、ページ全体を出力しました。"] };
  }
  return { scope: best.n, modeApplied: "article", warnings: [] };
}

function metrics(root) {
  const m = { text: 0, links: 0, paragraphs: 0, headings: 0, punctuation: 0 };
  walk(root, (n) => {
    if (ignored(n) || hidden(n)) return false;
    if (n.type === "text") {
      const text = normalizeSpace(n.value);
      m.text += text.length;
      m.punctuation += text.match(/[。！？.!?]/g)?.length || 0;
      if (hasAncestor(n, "a", root)) m.links += text.length;
    } else if (n.tagName === "p") m.paragraphs += 1;
    else if (/^h[1-6]$/.test(n.tagName || "")) m.headings += 1;
    return true;
  });
  return m;
}

function renderChildren(n, ctx) { return n.children.map((c) => render(c, ctx)).join(""); }
function render(n, ctx) {
  if (n.type === "text") return escapeMd(japaneseSpace(n.value));
  if (n.type === "root") return renderChildren(n, ctx);
  if (n.type !== "element" || ignored(n) || hidden(n)) return "";
  const tag = n.tagName;
  const children = () => renderChildren(n, ctx);

  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${inline(children())}\n\n`;
  switch (tag) {
    case "p": return `\n\n${inline(children())}\n\n`;
    case "br": return "  \n";
    case "hr": return "\n\n---\n\n";
    case "strong": case "b": return wrap("**", children());
    case "em": case "i": return wrap("*", children());
    case "del": case "s": case "strike": return wrap("~~", children());
    case "code": return n.parent?.tagName === "pre" ? plainText(n, true) : codeSpan(plainText(n, true));
    case "pre": return codeBlock(n);
    case "a": return link(n, ctx);
    case "img": return image(n, ctx);
    case "ruby": return ruby(n, ctx);
    case "rt": case "rp": return "";
    case "blockquote": return quote(n, ctx);
    case "ul": return list(n, ctx, false);
    case "ol": return list(n, ctx, true);
    case "li": return inline(children());
    case "dl": return definitionList(n, ctx);
    case "dt": return `\n\n**${inline(children())}**\n`;
    case "dd": return `: ${inline(children())}\n`;
    case "table": return `\n\n${tableMarkdown(n, (cell) => renderChildren(cell, ctx)).markdown}\n\n`;
    case "iframe": case "frame": return frame(n, ctx);
    case "details": return details(n, ctx);
    case "input": return input(n);
    case "select": return select(n);
    case "textarea": return plainText(n, true);
    case "sup": return `<sup>${inline(children())}</sup>`;
    case "sub": return `<sub>${inline(children())}</sub>`;
    case "q": return `「${inline(children())}」`;
    default: {
      const content = children();
      if (BLOCK.has(tag)) return `\n\n${content}\n\n`;
      if (ctx.mode === "raw" && !["html","body","meta","link","base","title"].includes(tag)) return `<${tag}>${content}</${tag}>`;
      return content;
    }
  }
}

function link(n, ctx) {
  const label = inline(renderChildren(n, ctx)) || normalizeSpace(n.attributes.title || "");
  const href = absolute(n.attributes.href, ctx.baseUrl);
  if (!href || href === "javascript:") return label;
  return `[${label || href}](${safeUrl(href)}${n.attributes.title ? ` ${JSON.stringify(n.attributes.title)}` : ""})`;
}
function image(n, ctx) {
  const src = absolute(n.attributes.src, ctx.baseUrl);
  if (!src) return "";
  const alt = normalizeSpace(n.attributes.alt || n.attributes.title || filename(src) || "画像");
  return `![${escapeMd(alt)}](${safeUrl(src)})`;
}
function ruby(n, ctx) {
  const base = n.children.filter((c) => c.tagName !== "rt" && c.tagName !== "rp").map((c) => render(c, ctx)).join("");
  const reading = n.children.filter((c) => c.tagName === "rt").map((c) => plainText(c)).join("・");
  return reading ? `${inline(base)}（${reading}）` : base;
}
function codeBlock(n) {
  const value = plainText(n, true).replace(/^\n+|\n+$/g, "");
  const longest = Math.max(0, ...(value.match(/`+/g) || []).map((x) => x.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const language = findFirst(n, (x) => x.tagName === "code")?.attributes.class?.match(/language-([\w-]+)/)?.[1] || "";
  return `\n\n${fence}${language}\n${value}\n${fence}\n\n`;
}
function quote(n, ctx) {
  return `\n\n${normalizeMarkdown(renderChildren(n, ctx)).split("\n").map((x) => `> ${x}`).join("\n")}\n\n`;
}
function list(n, ctx, ordered, depth = 0) {
  const lines = [];
  const items = n.children.filter((x) => x.type === "element" && x.tagName === "li");
  items.forEach((item, index) => {
    const nested = item.children.filter((x) => x.type === "element" && (x.tagName === "ul" || x.tagName === "ol"));
    const main = item.children.filter((x) => !nested.includes(x)).map((x) => render(x, ctx)).join("");
    const prefix = `${"  ".repeat(depth)}${ordered ? `${index + 1}.` : "-"} `;
    const parts = inline(main).split("\n");
    lines.push(prefix + (parts[0] || ""));
    for (const extra of parts.slice(1)) lines.push(`${"  ".repeat(depth + 1)}${extra}`);
    for (const child of nested) lines.push(list(child, ctx, child.tagName === "ol", depth + 1).trimEnd());
  });
  const output = lines.join("\n");
  return depth ? output : `\n\n${output}\n\n`;
}
function definitionList(n, ctx) {
  const lines = [];
  for (const c of n.children) {
    if (c.tagName === "dt") lines.push(`**${inline(renderChildren(c, ctx))}**`);
    if (c.tagName === "dd") lines.push(`: ${inline(renderChildren(c, ctx))}`);
  }
  return `\n\n${lines.join("\n")}\n\n`;
}
function details(n, ctx) {
  const summary = n.children.find((x) => x.tagName === "summary");
  const title = summary ? inline(renderChildren(summary, ctx)) : "詳細";
  const body = n.children.filter((x) => x !== summary).map((x) => render(x, ctx)).join("");
  return `\n\n### ${title}\n\n${body}\n\n`;
}
function frame(n, ctx) {
  const src = absolute(n.attributes.src, ctx.baseUrl);
  return src ? `\n\n[${escapeMd(normalizeSpace(n.attributes.title || n.attributes.name || "埋め込みページ"))}](${safeUrl(src)})\n\n` : "";
}
function input(n) {
  const type = (n.attributes.type || "text").toLowerCase();
  if (["hidden","submit","button","reset","image"].includes(type)) return "";
  if (type === "checkbox") return Object.hasOwn(n.attributes, "checked") ? "[x]" : "[ ]";
  if (type === "radio") return Object.hasOwn(n.attributes, "checked") ? "(●)" : "( )";
  return escapeMd(normalizeSpace(n.attributes.value || n.attributes.placeholder || ""));
}
function select(n) {
  const option = findFirst(n, (x) => x.tagName === "option" && Object.hasOwn(x.attributes, "selected")) || findFirst(n, (x) => x.tagName === "option");
  return option ? escapeMd(plainText(option)) : "";
}

function blocksOf(scope, ctx) {
  const blocks = [];
  walk(scope, (n) => {
    if (n.type !== "element" || ignored(n) || hidden(n) || !PROVENANCE.has(n.tagName)) return;
    if (n.tagName !== "table" && hasAncestor(n, "table", scope)) return;
    const text = plainText(n);
    if (!text) return;
    const block = { type: blockType(n.tagName), text, markdown: normalizeMarkdown(render(n, ctx)), selector: nodePath(n), sourceIndex: n.startIndex };
    if (n.tagName === "table") {
      const data = tableData(n);
      block.table = { rows: data.rows, width: data.width, complex: data.complex, hasHeader: data.hasHeader };
    }
    blocks.push(block);
  });
  return blocks;
}
function blockType(tag) {
  if (/^h[1-6]$/.test(tag)) return "heading";
  return ({ p:"paragraph", li:"list-item", dt:"term", dd:"definition", pre:"code" })[tag] || tag;
}
function titleOf(document) {
  const title = findFirst(document, (n) => n.tagName === "title");
  if (title && plainText(title)) return plainText(title);
  const h1 = findFirst(document, (n) => n.tagName === "h1");
  return h1 ? plainText(h1) : "";
}

function normalizeMarkdown(value) {
  const saved = [];
  let out = value.replace(/(`{3,})[^\n]*\n[\s\S]*?\n\1/g, (m) => { const key = `\u0000CODE${saved.length}\u0000`; saved.push(m); return key; });
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => saved[Number(i)]);
}
function inline(value) { return value.replace(/[ \t]*\n+[ \t]*/g, " ").replace(/[ \t]{2,}/g, " ").trim(); }
function japaneseSpace(value) {
  return value.replace(/\r\n?/g, "\n").replace(/[\t\f\v ]+/g, " ").replace(/\n+/g, " ")
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。！？）」』】])/gu, "$1")
    .replace(/([「『【（]) +/g, "$1").replace(/\u00a0/g, " ");
}
function absolute(value, base) {
  if (!value || /^data:/i.test(value)) return null;
  if (/^javascript:/i.test(value)) return "javascript:";
  try { return new URL(value.trim(), base).href; } catch { return null; }
}
function safeUrl(value) { return value.replaceAll("(", "%28").replaceAll(")", "%29").replaceAll(" ", "%20"); }
function escapeMd(value) { return value.replace(/([\\[\]`*_])/g, "\\$1"); }
function wrap(marker, value) { const content = inline(value); return content ? `${marker}${content}${marker}` : ""; }
function codeSpan(value) { const n = Math.max(0, ...(value.match(/`+/g) || []).map((x) => x.length)); const fence = "`".repeat(n + 1); const pad = value.startsWith("`") || value.endsWith("`") ? " " : ""; return `${fence}${pad}${value}${pad}${fence}`; }
function filename(url) { try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch { return ""; } }
