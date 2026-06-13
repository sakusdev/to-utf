const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
const RAW = new Set(["script","style","template","textarea"]);
const SKIP = new Set(["head","script","style","template"]);

export function parseHtml(html) {
  const root = node("root", "#document", 0);
  const stack = [root];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { addText(stack.at(-1), html.slice(i), i); break; }
    if (lt > i) addText(stack.at(-1), html.slice(i, lt), i);

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      addText(stack.at(-1), html.slice(lt + 9, end < 0 ? html.length : end), lt + 9);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = tagEnd(html, lt + 2);
      if (end < 0) break;
      const name = html.slice(lt + 2, end).match(/^\s*([\w:-]+)/)?.[1]?.toLowerCase();
      if (name) close(stack, name);
      i = end + 1;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = tagEnd(html, lt + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    const end = tagEnd(html, lt + 1);
    if (end < 0) { addText(stack.at(-1), html.slice(lt), lt); break; }
    const rawTag = html.slice(lt + 1, end);
    const match = rawTag.match(/^\s*([\w:-]+)/);
    if (!match) { addText(stack.at(-1), "<", lt); i = lt + 1; continue; }

    const tagName = match[1].toLowerCase();
    const el = node("element", tagName, lt, attributes(rawTag.slice(match[0].length)));
    append(stack.at(-1), el);
    i = end + 1;
    const selfClosing = VOID.has(tagName) || /\/\s*$/.test(rawTag);

    if (RAW.has(tagName) && !selfClosing) {
      const marker = `</${tagName}`;
      const start = html.toLowerCase().indexOf(marker, i);
      const finish = start < 0 ? -1 : tagEnd(html, start + marker.length);
      addText(el, html.slice(i, start < 0 ? html.length : start), i, false);
      i = finish < 0 ? html.length : finish + 1;
    } else if (!selfClosing) stack.push(el);
  }
  return root;
}

function node(type, tagName, startIndex, attrs = Object.create(null)) {
  return { type, tagName, startIndex, attributes: attrs, value: "", parent: null, children: [] };
}
function append(parent, child) { child.parent = parent; parent.children.push(child); }
function addText(parent, value, startIndex, decode = true) {
  if (!value) return;
  const n = node("text", null, startIndex);
  n.value = decode ? decodeEntities(value) : value;
  append(parent, n);
}
function tagEnd(html, start) {
  let quote = null;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}
function close(stack, tagName) {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    if (stack[i].tagName === tagName) { stack.length = i; return; }
  }
}
function attributes(source) {
  const out = Object.create(null);
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(re)) out[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  return out;
}

export function decodeEntities(value) {
  const named = { amp:"&", apos:"'", gt:">", lt:"<", quot:'"', nbsp:"\u00a0", copy:"©", reg:"®", yen:"¥", hellip:"…", mdash:"—", ndash:"–" };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\w]+);?/gi, (full, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? full;
    const hex = entity[1]?.toLowerCase() === "x";
    const cp = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    try { return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full; } catch { return full; }
  });
}

export function walk(root, visitor) {
  if (visitor(root) === false) return;
  for (const child of root.children || []) walk(child, visitor);
}
export function findFirst(root, predicate) {
  let found = null;
  walk(root, (n) => { if (found) return false; if (predicate(n)) { found = n; return false; } return true; });
  return found;
}
export function hasAncestor(n, tag, stop = null) {
  for (let p = n.parent; p && p !== stop; p = p.parent) if (p.tagName === tag) return true;
  return false;
}
export function ignored(n) { return n.type === "element" && SKIP.has(n.tagName); }
export function hidden(n) {
  if (n.type !== "element") return false;
  if (Object.hasOwn(n.attributes, "hidden") || (n.attributes["aria-hidden"] || "").toLowerCase() === "true") return true;
  return /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(n.attributes.style || "");
}
export function plainText(root, preserve = false) {
  let out = "";
  walk(root, (n) => {
    if (n !== root && (ignored(n) || hidden(n))) return false;
    if (n.type === "text") out += n.value;
    else if (n.tagName === "br") out += "\n";
    return true;
  });
  return preserve ? out : normalizeSpace(out);
}
export function normalizeSpace(value) {
  return value.replace(/\r\n?/g, "\n").replace(/[\t\f\v ]+/g, " ").replace(/\n+/g, " ")
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。！？）」』】])/gu, "$1")
    .replace(/([「『【（]) +/g, "$1").replace(/\u00a0/g, " ").trim();
}
export function nodePath(n) {
  const parts = [];
  for (let cur = n; cur?.type === "element" && parts.length < 8; cur = cur.parent) {
    let part = cur.tagName;
    if (cur.attributes.id) { part += `#${cur.attributes.id.replace(/[^\w-]/g, "_")}`; parts.unshift(part); break; }
    const peers = cur.parent?.children.filter((x) => x.type === "element" && x.tagName === cur.tagName) || [];
    if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(cur) + 1})`;
    parts.unshift(part);
  }
  return parts.join(" > ");
}
