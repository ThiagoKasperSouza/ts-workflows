import type {Node, Page, State} from './types';
import {nodeAnchor, wirePath} from './edges';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FORMAT = 'dnd-graph';
const VERSION = 1;

export interface Document {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  pages: Page[];
  activePageId: string;
}

export function toDocument(state: State): Document {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    pages: state.pages,
    activePageId: state.activePageId,
  };
}

function safeFileName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'diagrama';
}

function download(fileName: string, mime: string, content: string): void {
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const anchorEl = document.createElement('a');
  anchorEl.href = url;
  anchorEl.download = fileName;
  anchorEl.click();
  URL.revokeObjectURL(url);
}

export function exportJson(state: State): void {
  const doc = toDocument(state);
  const page = state.pages.find((item) => item.id === state.activePageId) ?? state.pages[0]!;
  download(`${safeFileName(page.name)}.dndgraph.json`, 'application/json', JSON.stringify(doc, null, 2));
}

const escapeXml = (value: string): string =>
  value.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });

function bounds(page: Page): {x: number; y: number; w: number; h: number} {
  if (page.nodes.length === 0) return {x: 0, y: 0, w: 800, h: 600};
  const minX = Math.min(...page.nodes.map((node) => node.x));
  const minY = Math.min(...page.nodes.map((node) => node.y));
  const maxX = Math.max(...page.nodes.map((node) => node.x + node.w));
  const maxY = Math.max(...page.nodes.map((node) => node.y + node.h));
  const pad = 80;
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}

function shapeMarkup(node: Node): string {
  const {x, y, w, h} = node;
  const fill = '#ffffff';
  const stroke = '#334155';
  switch (node.kind) {
    case 'rect':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    case 'ellipse':
      return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    case 'diamond':
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
    case 'text':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="6 4"/>`;
case 'terminal':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#0f172a" stroke="#0f172a" stroke-width="2"/>`;
    case 'ai':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#f5f3ff" stroke="#6d28d9" stroke-width="2"/>`;
  }
}

/** Export visual: um SVG autocontido, com as mesmas curvas do editor. */
export function exportSvg(page: Page): void {
  const box = bounds(page);
  const byId = new Map(page.nodes.map((node) => [node.id, node]));

  const edges = page.edges
    .map((edge) => {
      const from = byId.get(edge.from.nodeId);
      const to = byId.get(edge.to.nodeId);
      if (!from || !to) return '';
      const a = nodeAnchor(from, edge.from.side);
      const b = nodeAnchor(to, edge.to.side);
      return `<path d="${wirePath(a, edge.from.side, b, edge.to.side)}" fill="none" stroke="#475569" stroke-width="2" marker-end="url(#arrow)"/>`;
    })
    .join('\n');

  const nodes = page.nodes
    .map(
      (node) => `${shapeMarkup(node)}
    <text x="${node.x + node.w / 2}" y="${node.y + node.h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="14" fill="#0f172a">${escapeXml(node.label)}</text>`,
    )
    .join('\n');

  const svg = `<svg xmlns="${SVG_NS}" width="${Math.ceil(box.w)}" height="${Math.ceil(box.h)}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#ffffff"/>
  ${edges}
  ${nodes}
</svg>`;

  download(`${safeFileName(page.name)}.svg`, 'image/svg+xml', svg);
}

export function isDocument(value: unknown): value is Document {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {format?: unknown; pages?: unknown};
  return candidate.format === FORMAT && Array.isArray(candidate.pages);
}