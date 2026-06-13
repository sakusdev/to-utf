import { findFirst, plainText, normalizeSpace } from "./html-parser.js";

const BLOCK = new Set(["address","article","aside","blockquote","dd","div","dl","dt","fieldset","figure","form","h1","h2","h3","h4","h5","h6","li","main","nav","ol","p","pre","section","table","ul"]);

export function tableData(table) {
  const rowNodes = [];
  collectRows(table, table, rowNodes);
  const grid = [];
  let complex = false;
  let hasHeader = false;

  rowNodes.forEach((row, r) => {
    grid[r] ||= [];
    let c = 0;
    for (const cell of cells(row)) {
      while (grid[r][c] !== undefined) c += 1;
      const rowspan = span(cell.attributes.rowspan);
      const colspan = span(cell.attributes.colspan);
      const value = normalizeSpace(plainText(cell));
      if (r === 0 && cell.tagName === "th") hasHeader = true;
      if (rowspan > 1 || colspan > 1 || nestedBlock(cell)) complex = true;
      for (let dy = 0; dy < rowspan; dy += 1) {
        grid[r + dy] ||= [];
        for (let dx = 0; dx < colspan; dx += 1) grid[r + dy][c + dx] = dy === 0 && dx === 0 ? value : "";
      }
      c += colspan;
    }
  });

  const width = Math.max(0, ...grid.map((r) => r.length));
  if (width > 20 || grid.some((r) => r.length !== width)) complex = true;
  const rows = grid.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  return { rows, rowNodes, width, complex, hasHeader };
}

export function tableMarkdown(table, renderChildren) {
  const data = tableData(table);
  if (!data.rows.length) return { markdown: "", ...data };

  if (!data.complex && data.hasHeader) {
    const [header, ...body] = data.rows;
    const line = (row) => `| ${row.map((v) => clean(v).replaceAll("|", "\\|")).join(" | ")} |`;
    return {
      markdown: [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...body.map(line)].join("\n"),
      ...data,
    };
  }

  const lines = ["<table>"];
  for (const row of data.rowNodes) {
    lines.push("  <tr>");
    for (const cell of cells(row)) {
      const tag = cell.tagName === "th" ? "th" : "td";
      const attrs = [];
      const rs = span(cell.attributes.rowspan);
      const cs = span(cell.attributes.colspan);
      if (rs > 1) attrs.push(`rowspan="${rs}"`);
      if (cs > 1) attrs.push(`colspan="${cs}"`);
      lines.push(`    <${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${escapeHtml(clean(renderChildren(cell)))}</${tag}>`);
    }
    lines.push("  </tr>");
  }
  lines.push("</table>");
  return { markdown: lines.join("\n"), ...data };
}

function collectRows(root, node, out) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "table" && child !== root) continue;
    if (child.tagName === "tr") out.push(child);
    else collectRows(root, child, out);
  }
}
function cells(row) { return row.children.filter((n) => n.type === "element" && (n.tagName === "th" || n.tagName === "td")); }
function nestedBlock(cell) { return Boolean(findFirst(cell, (n) => n !== cell && n.type === "element" && BLOCK.has(n.tagName) && n.tagName !== "br")); }
function span(value) { const n = Number.parseInt(value || "1", 10); return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 1; }
function clean(value) { return value.replace(/[ \t]*\n+[ \t]*/g, " ").replace(/[ \t]{2,}/g, " ").trim(); }
function escapeHtml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
