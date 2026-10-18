import type {Edge, Node, Point, Side} from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';

const HANDLE_DIRECTION: Record<Side, Point> = {
  n: {x: 0, y: -1},
  e: {x: 1, y: 0},
  s: {x: 0, y: 1},
  w: {x: -1, y: 0},
};

export function nodeAnchor(node: Node, side: Side): Point {
  switch (side) {
    case 'n':
      return {x: node.x + node.w / 2, y: node.y};
    case 'e':
      return {x: node.x + node.w, y: node.y + node.h / 2};
    case 's':
      return {x: node.x + node.w / 2, y: node.y + node.h};
    case 'w':
      return {x: node.x, y: node.y + node.h / 2};
  }
}

export function anchor(node: Node | undefined, side: Side): Point | null {
  return node ? nodeAnchor(node, side) : null;
}

function handleFor(
  from: Point,
  fromSide: Side,
  to: Point,
  toSide: Side,
): [Point, Point] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const reach = Math.min(160, Math.max(40, distance * 0.4));
  const a = HANDLE_DIRECTION[fromSide];
  const b = HANDLE_DIRECTION[toSide];
  return [
    {x: from.x + a.x * reach, y: from.y + a.y * reach},
    {x: to.x + b.x * reach, y: to.y + b.y * reach},
  ];
}

/** Curva cúbica que sai perpendicular à lateral da porta. */
export function wirePath(
  from: Point,
  fromSide: Side,
  to: Point,
  toSide: Side,
): string {
  const [c1, c2] = handleFor(from, fromSide, to, toSide);
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

function createSvg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

export class EdgeLayer {
  readonly svg: SVGSVGElement;

  private readonly hitGroup = createSvg('g', {class: 'edge-hits'});
  private readonly lineGroup = createSvg('g', {class: 'edge-lines'});
  private readonly tempPath = createSvg('path', {class: 'edge-temp', fill: 'none'});

  constructor(readonly layer: HTMLElement) {
    this.svg = createSvg('svg', {class: 'edge-svg'});
    const defs = createSvg('defs', {});

    const arrow = createSvg('marker', {
      id: 'edge-arrow',
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '7',
      markerHeight: '7',
      orient: 'auto-start-reverse',
    });
    arrow.appendChild(createSvg('path', {d: 'M 0 1 L 10 5 L 0 9 z', class: 'edge-arrow-head'}));

    const arrowSelected = createSvg('marker', {
      id: 'edge-arrow-selected',
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '7',
      markerHeight: '7',
      orient: 'auto-start-reverse',
    });
    arrowSelected.appendChild(
      createSvg('path', {d: 'M 0 1 L 10 5 L 0 9 z', class: 'edge-arrow-head is-selected'}),
    );

    defs.append(arrow, arrowSelected);
    this.svg.append(defs, this.hitGroup, this.lineGroup, this.tempPath);
    layer.appendChild(this.svg);
    this.clearTemp();
  }

  clearTemp(): void {
    this.tempPath.setAttribute('d', '');
    this.tempPath.removeAttribute('stroke');
  }

  drawTemp(from: Point, fromSide: Side, to: Point, toSide: Side): void {
    this.tempPath.setAttribute('d', wirePath(from, fromSide, to, toSide));
    this.tempPath.setAttribute('stroke', '');
  }

  /**
   * `offset` desloca um nó específico: é como o arraste ao vivo de um nó é
   * refletido nas arestas sem tocar no store (que só muda no `dragend`).
   */
  render(
    edges: readonly Edge[],
    nodes: readonly Node[],
    selectedEdgeId: string | null,
    offset?: {nodeId: string; dx: number; dy: number},
  ): void {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    this.hitGroup.replaceChildren();
    this.lineGroup.replaceChildren();

    const resolve = (nodeId: string, side: Side): Point | null => {
      const node = byId.get(nodeId);
      const point = anchor(node, side);
      if (!point) return null;
      if (offset && nodeId === offset.nodeId) {
        return {x: point.x + offset.dx, y: point.y + offset.dy};
      }
      return point;
    };

    for (const edge of edges) {
      const from = resolve(edge.from.nodeId, edge.from.side);
      const to = resolve(edge.to.nodeId, edge.to.side);
      if (!from || !to) continue;

      const d = wirePath(from, edge.from.side, to, edge.to.side);
      const selected = edge.id === selectedEdgeId;

      const hit = createSvg('path', {d, class: 'edge-hit', fill: 'none'});
      hit.dataset.edgeId = edge.id;
      const line = createSvg('path', {
        d,
        class: selected ? 'edge is-selected' : 'edge',
        fill: 'none',
        'marker-end': selected ? 'url(#edge-arrow-selected)' : 'url(#edge-arrow)',
      });
      line.dataset.edgeId = edge.id;

      this.hitGroup.appendChild(hit);
      this.lineGroup.appendChild(line);
    }
  }
}