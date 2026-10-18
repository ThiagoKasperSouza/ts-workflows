import {DragDropManager, Droppable} from '@dnd-kit/dom';

import './style.css';

import {loadStore, type Store} from './store';
import {createNode, type Node, type Selection, type ShapeKind} from './types';
import {ViewportController} from './viewport';
import {EdgeLayer} from './edges';
import {NodeLayer, WORLD, CANVAS_ID, NODE_DRAG_TYPE, PALETTE_DRAG_TYPE} from './nodes';
import {Sidebar} from './sidebar';
import {NodeInspector} from './console';
import {TerminalWindows, terminalWindowDocument} from './terminal-window';
import {ExecutionEngine, type ExecutionSnapshot} from './execution';
import {isStartNode} from './engine';
import {ModeController, MODE_LABEL} from './mode';
import {ConnectorController} from './connectors';
import {
  addNode,
  deleteSelection,
  moveNode,
  renameNode,
  replaceAllPages,
} from './commands';
import {exportJson, exportSvg, isDocument} from './io';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <aside class="sidebar"></aside>
  <main class="workspace">
    <header class="toolbar">
      <div class="toolbar-group">
        <button type="button" data-action="toggle-mode" class="mode-toggle" title="Alternar edição / execução (E)">
          <span class="mode-dot"></span><span data-mode-label>Edição</span>
        </button>
      </div>
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
        <button type="button" data-action="run-flow" title="Executar o fluxo a partir do nó início selecionado" hidden>▶ Executar fluxo</button>
        <button type="button" data-action="cancel-flow" title="Cancelar a execução em andamento" hidden>■ Cancelar</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="export-json" title="Exportar JSON">⤓ JSON</button>
        <button type="button" data-action="export-svg" title="Exportar SVG">⤓ SVG</button>
        <button type="button" data-action="import" title="Importar JSON">⤒ Importar</button>
      </div>
      <p class="hint" data-hint>Paleta → canvas para criar · arraste entre bolinhas para ligar · duplo clique: terminal edita comando, losango edita condição · Delete remove a seleção · roda = pan · Ctrl+roda = zoom</p>
    </header>
    <div class="surface" data-empty="true">
      <div class="layer" data-empty="true"></div>
    </div>
    <section class="node-inspector" data-inspector hidden></section>
  </main>
  <div class="toast" data-toast hidden></div>
  <input type="file" accept=".json,application/json" hidden data-file />`;

const surface = app.querySelector<HTMLDivElement>('.surface')!;
const layer = app.querySelector<HTMLDivElement>('.layer')!;
const sidebarRoot = app.querySelector<HTMLElement>('.sidebar')!;
const inspectorRoot = app.querySelector<HTMLElement>('[data-inspector]')!;
const toast = app.querySelector<HTMLDivElement>('[data-toast]')!;
const fileInput = app.querySelector<HTMLInputElement>('[data-file]')!;
const zoomLabel = app.querySelector<HTMLElement>('[data-zoom]')!;

const store = loadStore();
const manager = new DragDropManager();

/** Último snapshot do motor de workflow (null antes da primeira execução). */
let latestExecution: ExecutionSnapshot | null = null;

// O SVG precisa vir antes dos nós no DOM para renderizar atrás deles.
const edgeLayer = new EdgeLayer(layer);

const viewport = new ViewportController(surface, layer, () => updateZoomLabel());

const windows = new TerminalWindows();
const engine = new ExecutionEngine({store, sink: windows, onToast: showToast});

const mode = new ModeController(app, () => render());

const inspector = new NodeInspector(inspectorRoot, {store, engine, onError: showToast});

const nodeLayer = new NodeLayer(manager, layer, {
  onSelect: (selection) => {
    // No modo de execução, clicar no nó de início dispara o fluxo; no modo de
    // edição o mesmo clique apenas seleciona (para poder ligar e configurar).
    if (selection?.type === 'node' && !mode.isEdit) {
      const page = store.activePage();
      const node = page.nodes.find((item) => item.id === selection.id);
      if (node && isStartNode(page, node)) {
        store.update(
          (draft) => {
            draft.selection = selection;
          },
          {history: false},
        );
        void engine.run(node.id);
        return;
      }
    }
    store.update(
      (draft) => {
        draft.selection = selection;
      },
      {history: false},
    );
  },
  onRename: (node) => {
    if (!mode.isEdit) return;
    const next = window.prompt('Nome do nó', node.label);
    if (next) renameNode(store, node.id, next);
  },
});

const sidebar = new Sidebar(sidebarRoot, manager, {
  store,
  engine,
  isEdit: () => mode.isEdit,
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
  onNotice: showToast,
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
    if (typing || !mode.isEdit) return;
    event.preventDefault();
    deleteSelection(store);
    return;
  }
  if (typing) return;
  if (event.key === '0' && !meta) {
    viewport.reset();
    return;
  }
  if (event.key.toLowerCase() === 'e') {
    mode.toggle();
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
  // `closest` e não `target`: os botões têm filhos (o ponto do toggle, o
  // <kbd> do atalho) e o clique neles precisa valer como o botão.
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset
    .action;
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
    case 'run-flow': {
      const start = selectedStartNode(store.activePage(), store.get().selection);
      if (start) void engine.run(start.id);
      break;
    }
    case 'cancel-flow':
      void engine.cancel();
      break;
    case 'toggle-mode':
      mode.toggle();
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
  const execution = latestExecution;

  // O rastro fica depois do fim da execução de propósito: o desenho do caminho
  // percorrido é a informação mais útil depois que o fluxo rodou.
  nodeLayer.render(page, state.selection, execution?.nodeStates, mode.isEdit);
  edgeLayer.render(
    page.edges,
    page.nodes,
    state.selection?.type === 'edge' ? state.selection.id : null,
    undefined,
    execution?.currentRun
      ? {active: execution.activeEdges, current: execution.currentEdge}
      : undefined,
  );
  sidebar.render(page, state.pages, state.selection);
  sidebar.setInteractive(mode.isEdit);
  inspector.sync(selectedNode(page, state.selection));
  inspector.paintState();
  applyMode();

  const button = (action: string) =>
    app.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  button('undo')!.disabled = !store.canUndo() || !mode.isEdit;
  button('redo')!.disabled = !store.canRedo() || !mode.isEdit;
  button('run-flow')!.hidden = mode.isEdit || !selectedStartNode(page, state.selection);
  button('cancel-flow')!.hidden = execution?.currentRun?.status !== 'running';
}

/** Reflete o modo na UI: rótulo do toggle, dica contextual e trancas. */
function applyMode(): void {
  app.querySelector<HTMLElement>('[data-mode-label]')!.textContent = MODE_LABEL[mode.mode];
  app.querySelector<HTMLElement>('[data-hint]')!.innerHTML =
    mode.mode === 'edit'
      ? 'Arraste da paleta para criar · <strong>duplo clique</strong> renomeia · ligação: arraste entre as bolinhas · losango: <strong>entrada por cima</strong>, <strong>direita = sim</strong>, <strong>esquerda = não</strong> · comando e condição se editam na barra lateral · <strong>E</strong> vai para execução'
      : 'Clique no nó <strong>início</strong> para executar o fluxo · <strong>E</strong> volta para edição';
  inspector.setInteractive(mode.isEdit);
}

const selectedNode = (
  page: ReturnType<Store['activePage']>,
  selection: Selection,
): Node | null =>
  selection?.type === 'node' ? (page.nodes.find((node) => node.id === selection.id) ?? null) : null;

/** O botão "Executar fluxo" só aparece quando a seleção é um nó de início. */
const selectedStartNode = (
  page: ReturnType<Store['activePage']>,
  selection: Selection,
): Node | null => {
  const node = selectedNode(page, selection);
  return node && isStartNode(page, node) ? node : null;
};

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
// O motor vive fora do store, então tem o próprio render: highlights, histórico
// e botões da toolbar são atualizados a cada evento de execução.
engine.subscribe((snapshot) => {
  latestExecution = snapshot;
  render();
});
updateZoomLabel();
render();

if (import.meta.env.DEV) {
  // gancho de inspeção para depurar arrasto/connector no console do browser
  Object.assign(window, {
    __dnd: {manager, store, viewport, edgeLayer, engine, windows, terminalWindowDocument},
  });
}