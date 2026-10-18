import {DragDropManager, Droppable} from '@dnd-kit/dom';

import './style.css';

import {loadStore} from './store';
import {createNode, type Node, type ShapeKind} from './types';
import {ViewportController} from './viewport';
import {EdgeLayer} from './edges';
import {NodeLayer, WORLD, CANVAS_ID, NODE_DRAG_TYPE, PALETTE_DRAG_TYPE} from './nodes';
import {Sidebar} from './sidebar';
import {TerminalConsole} from './console';
import {ConnectorController} from './connectors';
import {addNode, deleteSelection, moveNode, renameNode, replaceAllPages} from './commands';
import {exportJson, exportSvg, isDocument} from './io';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <aside class="sidebar"></aside>
  <main class="workspace">
    <header class="toolbar">
      <div class="toolbar-group">
        <button type="button" data-action="undo" title="Desfazer (Ctrl+Z)">↶</button>
        <button type="button" data-action="redo" title="Refazer (Ctrl+Shift+Z)">↷</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="zoom-out" title="Reduzir zoom (−)">−</button>
        <span class="zoom-label" data-zoom>100%</span>
        <button type="button" data-action="zoom-in" title="Ampliar zoom (+)">+</button>
        <button type="button" data-action="zoom-reset" title="Restaurar zoom (0)">⟲</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="export-json" title="Exportar JSON">⤓ JSON</button>
        <button type="button" data-action="export-svg" title="Exportar SVG">⤓ SVG</button>
        <button type="button" data-action="import" title="Importar JSON">⤒ Importar</button>
      </div>
      <p class="hint">Paleta → canvas para criar · arraste entre bolinhas para ligar · nó terminal: duplo clique edita o comando, Ctrl+Enter executa · Delete remove a seleção · roda = pan · Ctrl+roda = zoom</p>
    </header>
    <div class="surface" data-empty="true">
      <div class="layer" data-empty="true"></div>
    </div>
    <section class="run-console" data-console hidden></section>
  </main>
  <div class="toast" data-toast hidden></div>
  <input type="file" accept=".json,application/json" hidden data-file />`;

const surface = app.querySelector<HTMLDivElement>('.surface')!;
const layer = app.querySelector<HTMLDivElement>('.layer')!;
const sidebarRoot = app.querySelector<HTMLElement>('.sidebar')!;
const consoleRoot = app.querySelector<HTMLElement>('[data-console]')!;
const toast = app.querySelector<HTMLDivElement>('[data-toast]')!;
const fileInput = app.querySelector<HTMLInputElement>('[data-file]')!;
const zoomLabel = app.querySelector<HTMLElement>('[data-zoom]')!;

const store = loadStore();
const manager = new DragDropManager();

// O SVG precisa vir antes dos nós no DOM para renderizar atrás deles.
const edgeLayer = new EdgeLayer(layer);

const viewport = new ViewportController(surface, layer, () => updateZoomLabel());

const runConsole = new TerminalConsole(consoleRoot, {store, onError: showToast});

const nodeLayer = new NodeLayer(manager, layer, {
  onSelect: (selection) => {
    store.update(
      (draft) => {
        draft.selection = selection;
      },
      {history: false},
    );
  },
  onRename: (node) => {
    const next = window.prompt('Rótulo do nó', node.label);
    if (next) renameNode(store, node.id, next);
  },
  onEditCommand: (node) => {
    // seleciona o nó e joga o foco no campo de comando do painel
    store.update(
      (draft) => {
        draft.selection = {type: 'node', id: node.id};
      },
      {history: false},
    );
    consoleRoot.querySelector<HTMLTextAreaElement>('.run-console-input')?.focus();
  },
});

const sidebar = new Sidebar(sidebarRoot, manager, {
  store,
  onDropShape: (kind: ShapeKind) => {
    const center = viewport.viewportCenter();
    addNode(store, createNode(kind, center.x, center.y));
  },
});

// O controlador e o droppable do canvas existem pelo tempo de vida da aplicação;
// o manager mantém as referências, então basta criá-los.
new ConnectorController(manager, {
  store,
  edgeLayer,
  viewport,
  onInvalid: showToast,
});

/**
 * Alvo de drop da paleta. Aceita apenas `palette`: cada tipo de arrasto tem um
 * conjunto de alvos disjuntos, o que elimina ambiguidade de colisão entre
 * "soltar um item no canvas" e "soltar um conector numa porta".
 */
new Droppable(
  {
    id: CANVAS_ID,
    element: layer,
    accept: PALETTE_DRAG_TYPE,
  },
  manager,
);

// ---------------------------------------------------------------------------
// arrasto de nós e da paleta
// ---------------------------------------------------------------------------

const clampToWorld = (node: Node, x: number, y: number) => ({
  x: Math.min(WORLD.width - node.w, Math.max(0, Math.round(x))),
  y: Math.min(WORLD.height - node.h, Math.max(0, Math.round(y))),
});

manager.monitor.addEventListener('dragmove', (event) => {
  const source = event.operation.source;
  if (source?.type !== NODE_DRAG_TYPE) return;
  const nodeId = (source.data as {nodeId?: string} | undefined)?.nodeId;
  if (!nodeId) return;

  const {transform} = event.operation;
  // `transform` vem em pixels de viewport; o store é em espaço de conteúdo
  const dx = transform.x / viewport.viewport.zoom;
  const dy = transform.y / viewport.viewport.zoom;

  // as arestas seguem o nó ao vivo, sem tocar no store (que só muda no dragend)
  const page = store.activePage();
  edgeLayer.render(
    page.edges,
    page.nodes,
    store.get().selection?.type === 'edge' ? store.get().selection!.id : null,
    {nodeId, dx, dy},
  );
});

manager.monitor.addEventListener('dragend', (event) => {
  const source = event.operation.source;
  if (!source) return;

  if (source.type === NODE_DRAG_TYPE) {
    const nodeId = (source.data as {nodeId?: string} | undefined)?.nodeId;
    const node = nodeId ? store.activePage().nodes.find((item) => item.id === nodeId) : undefined;
    if (!node) return;
    const {transform} = event.operation;
    const next = clampToWorld(
      node,
      node.x + transform.x / viewport.viewport.zoom,
      node.y + transform.y / viewport.viewport.zoom,
    );
    if (next.x !== node.x || next.y !== node.y) moveNode(store, node.id, next.x, next.y);
    return;
  }

  if (source.type === PALETTE_DRAG_TYPE) {
    if (event.operation.target?.id !== CANVAS_ID) return;
    const kind = (source.data as {kind?: ShapeKind} | undefined)?.kind;
    if (!kind) return;
    const {current} = event.operation.position;
    const point = viewport.clientToContent(current.x, current.y);
    addNode(store, createNode(kind, point.x, point.y));
  }
});

// ---------------------------------------------------------------------------
// clique em aresta, teclado e toolbar
// ---------------------------------------------------------------------------

edgeLayer.svg.addEventListener('click', (event) => {
  const edgeId = (event.target as HTMLElement).dataset?.edgeId;
  if (!edgeId) return;
  event.stopPropagation();
  store.update(
    (draft) => {
      draft.selection = {type: 'edge', id: edgeId};
    },
    {history: false},
  );
});

layer.addEventListener('click', (event) => {
  if (event.target !== layer) return; // clique no vazio limpa a seleção
  store.update(
    (draft) => {
      draft.selection = null;
    },
    {history: false},
  );
});

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing =
    target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;
  const meta = event.ctrlKey || event.metaKey;
  // Ctrl+Z dentro de um campo de texto é undo do texto, não do diagrama
  if (meta && !typing && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) store.redo();
    else store.undo();
    return;
  }
  if (meta && event.key.toLowerCase() === 'y') {
    if (typing) return;
    event.preventDefault();
    store.redo();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (typing) return;
    event.preventDefault();
    deleteSelection(store);
    return;
  }
  if (typing) return;
  if (event.key === '0' && !meta) {
    viewport.reset();
    return;
  }
  if (event.key === '+' || event.key === '=') {
    zoomCenter(1.2);
    return;
  }
  if (event.key === '-') zoomCenter(1 / 1.2);
});

const zoomCenter = (factor: number) => {
  const rect = surface.getBoundingClientRect();
  viewport.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
};

app.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).dataset?.action;
  if (!action) return;
  switch (action) {
    case 'undo':
      store.undo();
      break;
    case 'redo':
      store.redo();
      break;
    case 'zoom-in':
      zoomCenter(1.2);
      break;
    case 'zoom-out':
      zoomCenter(1 / 1.2);
      break;
    case 'zoom-reset':
      viewport.reset();
      break;
    case 'export-json':
      exportJson(store.get());
      break;
    case 'export-svg':
      exportSvg(store.activePage());
      break;
    case 'import':
      fileInput.click();
      break;
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    if (!isDocument(parsed)) {
      showToast('Arquivo inválido: não é um documento dnd-graph');
      return;
    }
    replaceAllPages(store, parsed.pages, parsed.activePageId);
    showToast(`Importado: ${parsed.pages.length} página(s)`);
  } catch {
    showToast('Não foi possível ler o arquivo');
  }
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function updateZoomLabel(): void {
  const {zoom, x, y} = viewport.viewport;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  // o retícula do canvas acompanha pan/zoom para não "descolar" do conteúdo
  surface.style.setProperty('--grid', `${24 * zoom}px`);
  surface.style.setProperty('--grid-x', `${x}px`);
  surface.style.setProperty('--grid-y', `${y}px`);
}

function render(): void {
  const state = store.get();
  const page = store.activePage();

  nodeLayer.render(page, state.selection);
  edgeLayer.render(
    page.edges,
    page.nodes,
    state.selection?.type === 'edge' ? state.selection.id : null,
  );
  sidebar.render(page, state.pages, state.selection);

  const button = (action: string) =>
    app.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  button('undo')!.disabled = !store.canUndo();
  button('redo')!.disabled = !store.canRedo();

  // o painel pertence ao nó terminal selecionado
  runConsole.retain(new Set(page.nodes.map((node) => node.id)));
  runConsole.sync(
    state.selection?.type === 'node'
      ? (page.nodes.find((node) => node.id === state.selection!.id) ?? null)
      : null,
  );
}

let toastTimer = 0;

function showToast(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
  toast.dataset.visible = 'true';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.dataset.visible = 'false';
    window.setTimeout(() => {
      toast.hidden = true;
    }, 200);
  }, 2200);
}

store.subscribe(render);
updateZoomLabel();
render();

if (import.meta.env.DEV) {
  // gancho de inspeção para depurar arrasto/connector no console do browser
  Object.assign(window, {__dnd: {manager, store, viewport, edgeLayer}});
}