import {DragDropManager, Draggable, PointerSensor, PointerActivationConstraints} from '@dnd-kit/dom';

import type {Store} from './store';
import type {Page, Selection, ShapeKind, Side} from './types';
import {SHAPE_LABEL} from './types';
import {addPage, removeEdge, removeNode, removePage, renamePage, select, setActivePage} from './commands';
import {PALETTE_DRAG_TYPE} from './nodes';

const SIDE_LABEL: Record<Side, string> = {n: 'N', e: 'L', s: 'S', w: 'O'};

const KINDS: ShapeKind[] = ['rect', 'ellipse', 'diamond', 'text', 'terminal'];

/** Mesma distinção clique/arrasto usada nos nós do canvas. */
const PaletteSensor = PointerSensor.configure({
  activationConstraints: (event) =>
    event.pointerType === 'touch'
      ? [new PointerActivationConstraints.Delay({value: 180, tolerance: 6})]
      : [new PointerActivationConstraints.Distance({value: 3})],
});

export class Sidebar {
  private readonly paletteEl: HTMLElement;
  private readonly pagesEl: HTMLElement;
  private readonly outlineEl: HTMLElement;
  private readonly paletteDraggables: Draggable[] = [];

  constructor(
    root: HTMLElement,
    manager: DragDropManager,
    private readonly deps: {
      store: Store;
      onDropShape: (kind: ShapeKind) => void;
    },
  ) {
    root.classList.add('sidebar');
    root.innerHTML = `
      <section class="panel">
        <h2 class="panel-title">Páginas</h2>
        <div class="pages"></div>
      </section>
      <section class="panel">
        <h2 class="panel-title">Paleta <small>arraste para o canvas</small></h2>
        <div class="palette"></div>
      </section>
      <section class="panel panel-grow">
        <h2 class="panel-title">Diagrama</h2>
        <div class="outline"></div>
      </section>`;

    this.pagesEl = root.querySelector('.pages')!;
    this.paletteEl = root.querySelector('.palette')!;
    this.outlineEl = root.querySelector('.outline')!;

    for (const kind of KINDS) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.dataset.kind = kind;
      item.innerHTML = `<span class="palette-shape shape-${kind}"></span><span class="palette-label">${SHAPE_LABEL[kind]}</span>`;
      item.addEventListener('click', () => this.deps.onDropShape(kind));
      this.paletteEl.appendChild(item);

      this.paletteDraggables.push(
        new Draggable(
          {
            id: `palette:${kind}`,
            element: item,
            type: PALETTE_DRAG_TYPE,
            data: {kind},
            sensors: [PaletteSensor],
          },
          manager,
        ),
      );
    }
  }

  destroy(): void {
    for (const draggable of this.paletteDraggables) draggable.destroy();
  }

  render(page: Page, pages: readonly Page[], selection: Selection): void {
    this.renderPages(pages, page.id);
    this.renderOutline(page, selection);
  }

  private renderPages(pages: readonly Page[], activeId: string): void {
    this.pagesEl.replaceChildren();

    for (const page of pages) {
      const tab = document.createElement('div');
      tab.className = 'page-tab';
      tab.dataset.active = page.id === activeId ? 'true' : 'false';

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'page-name';
      name.textContent = page.name;
      name.addEventListener('click', () => setActivePage(this.deps.store, page.id));
      name.addEventListener('dblclick', () => {
        const next = window.prompt('Nome da página', page.name);
        if (next) renamePage(this.deps.store, page.id, next);
      });
      tab.appendChild(name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'page-remove';
      remove.textContent = '✕';
      remove.title = 'Excluir página';
      remove.disabled = pages.length <= 1;
      remove.addEventListener('click', () => {
        const total = this.deps.store.get().pages.length;
        if (total > 1 && window.confirm(`Excluir a página "${page.name}" e seu diagrama?`)) {
          removePage(this.deps.store, page.id);
        }
      });
      tab.appendChild(remove);

      this.pagesEl.appendChild(tab);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'page-add';
    add.textContent = '+ Nova página';
    add.addEventListener('click', () => addPage(this.deps.store));
    this.pagesEl.appendChild(add);
  }

  private renderOutline(page: Page, selection: Selection): void {
    this.outlineEl.replaceChildren();

    if (page.nodes.length === 0 && page.edges.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'outline-empty';
      empty.textContent = 'Arraste um item da paleta para começar.';
      this.outlineEl.appendChild(empty);
      return;
    }

    const nodeById = new Map(page.nodes.map((node) => [node.id, node]));
    const connected = new Set(
      page.edges.flatMap((edge) => [edge.from.nodeId, edge.to.nodeId]),
    );

    for (const node of page.nodes) {
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.dataset.active =
        selection?.type === 'node' && selection.id === node.id ? 'true' : 'false';
      row.dataset.connected = connected.has(node.id) ? 'true' : 'false';

      const swatch = document.createElement('span');
      swatch.className = `outline-swatch shape-${node.kind}`;
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'outline-label';
      label.textContent = node.label;
      label.addEventListener('click', () => select(this.deps.store, {type: 'node', id: node.id}));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'outline-remove';
      remove.textContent = '✕';
      remove.title = 'Excluir nó';
      remove.addEventListener('click', () => removeNode(this.deps.store, node.id));

      row.append(swatch, label, remove);
      this.outlineEl.appendChild(row);
    }

    if (page.edges.length > 0) {
      const heading = document.createElement('p');
      heading.className = 'outline-heading';
      heading.textContent = 'Conexões';
      this.outlineEl.appendChild(heading);

      for (const edge of page.edges) {
        const from = nodeById.get(edge.from.nodeId);
        const to = nodeById.get(edge.to.nodeId);
        if (!from || !to) continue;

        const row = document.createElement('div');
        row.className = 'outline-row is-edge';
        row.dataset.active =
          selection?.type === 'edge' && selection.id === edge.id ? 'true' : 'false';

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'outline-label';
        label.innerHTML = `${escapeText(from.label)} <span class="outline-sides">[${SIDE_LABEL[edge.from.side]}→${SIDE_LABEL[edge.to.side]}]</span> ${escapeText(to.label)}`;
        label.addEventListener('click', () => select(this.deps.store, {type: 'edge', id: edge.id}));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'outline-remove';
        remove.textContent = '✕';
        remove.title = 'Excluir conexão';
        remove.addEventListener('click', () => removeEdge(this.deps.store, edge.id));

        row.append(label, remove);
        this.outlineEl.appendChild(row);
      }
    }
  }
}

function escapeText(value: string): string {
  const span = document.createElement('span');
  span.textContent = value;
  return span.innerHTML;
}