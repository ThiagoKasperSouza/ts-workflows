export type Side = 'n' | 'e' | 's' | 'w';

export type ShapeKind = 'rect' | 'ellipse' | 'diamond' | 'text' | 'terminal';

export interface Node {
  id: string;
  kind: ShapeKind;
  label: string;
  /** Espaço "content" (coordadas do canvas, já sem o pan/zoom). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Comando executado por nós do tipo `terminal`. Ausente nos demais tipos. */
  command?: string;
  /**
   * Variáveis do shell que este terminal expõe ao fluxo (ex.: `IDADE`, preenchida
   * por `read`). Só elas chegam à condição da decisão; o resto da sessão do shell
   * morre com o comando.
   */
  exposes?: string[];
  /**
   * Condição de um nó de decisão (losango), avaliada contra o exit code do
   * último terminal: `exit == 0`, `exit != 0`, `ok`, `fail`…
   */
  condition?: string;
}

export interface Anchor {
  nodeId: string;
  side: Side;
}

export interface Edge {
  id: string;
  from: Anchor;
  to: Anchor;
}

export interface Page {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
}

export type Selection =
  | {type: 'node'; id: string}
  | {type: 'edge'; id: string}
  | null;

export interface State {
  pages: Page[];
  activePageId: string;
  selection: Selection;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export const SIDES: readonly Side[] = ['n', 'e', 's', 'w'] as const;

/** handle nomeado de aresta; usado para destacar origem/destino no contorno. */
export const DEFAULT_SIZE: Record<ShapeKind, {w: number; h: number}> = {
  rect: {w: 168, h: 84},
  ellipse: {w: 168, h: 92},
  diamond: {w: 176, h: 104},
  text: {w: 160, h: 56},
  terminal: {w: 208, h: 96},
};

export const SHAPE_LABEL: Record<ShapeKind, string> = {
  rect: 'Processo',
  ellipse: 'Início / Fim',
  diamond: 'Decisão',
  text: 'Texto',
  terminal: 'Terminal',
};

/** Comando inicial de um nó terminal recién-criado — algo que já roda. */
export const TERMINAL_DEFAULT_COMMAND = 'echo "hello do fluxo"';

/** Condição inicial de um losango recém-criado. */
export const TERMINAL_DEFAULT_CONDITION = 'exit == 0';

let seq = 0;

export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function createNode(kind: ShapeKind, x: number, y: number): Node {
  const {w, h} = DEFAULT_SIZE[kind];
  const node: Node = {
    id: uid('node'),
    kind,
    label: SHAPE_LABEL[kind],
    x: Math.round(x - w / 2),
    y: Math.round(y - h / 2),
    w,
    h,
  };
  if (kind === 'terminal') node.command = TERMINAL_DEFAULT_COMMAND;
  if (kind === 'diamond') node.condition = TERMINAL_DEFAULT_CONDITION;
  return node;
}

export function emptyPage(name = 'Página 1'): Page {
  return {id: uid('page'), name, nodes: [], edges: []};
}