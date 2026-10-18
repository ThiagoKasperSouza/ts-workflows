import {DragDropManager, Draggable, PointerSensor, PointerActivationConstraints} from '@dnd-kit/dom';

import type {Store} from './store';
import type {ExecutionEngine, WorkflowRun} from './execution';
import {branchLabel} from './execution';
import {branchOf, conditionOf} from './engine';
import type {Node, Page, Selection, ShapeKind, Side} from './types';
import {SHAPE_LABEL} from './types';
import {
  addPage,
  removeEdge,
  removeNode,
  removePage,
  renameNode,
  renamePage,
  select,
  setActivePage,
  setNodeCondition,
} from './commands';
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
  private readonly runsEl: HTMLElement;
  private readonly paletteDraggables: Draggable[] = [];
  /** Execução expandida no histórico (só uma por vez). */
  private expandedRunId: string | null = null;

  constructor(
    root: HTMLElement,
    manager: DragDropManager,
    private readonly deps: {
      store: Store;
      engine: ExecutionEngine;
      /** Consultado a cada render: o painel esconde ações de edição no modo execução. */
      isEdit: () => boolean;
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
      <section class="panel">
        <h2 class="panel-title">Execuções <small>clique no nó início para rodar</small></h2>
        <div class="runs"></div>
      </section>
      <section class="panel panel-grow">
        <h2 class="panel-title">Diagrama</h2>
        <div class="outline"></div>
      </section>`;

    this.pagesEl = root.querySelector('.pages')!;
    this.paletteEl = root.querySelector('.palette')!;
    this.runsEl = root.querySelector('.runs')!;
    this.outlineEl = root.querySelector('.outline')!;

    for (const kind of KINDS) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.dataset.kind = kind;
      item.innerHTML = `<span class="palette-shape shape-${kind}"></span><span class="palette-label">${SHAPE_LABEL[kind]}</span>`;
      item.addEventListener('click', () => {
        if (!this.deps.isEdit()) return;
        this.deps.onDropShape(kind);
      });
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

  /** No modo de execução a paleta não cria nada: o canvas só roda. */
  setInteractive(on: boolean): void {
    for (const draggable of this.paletteDraggables) draggable.disabled = !on;
    this.paletteEl.dataset.locked = on ? 'false' : 'true';
  }

  render(page: Page, pages: readonly Page[], selection: Selection): void {
    this.renderPages(pages, page.id);
    this.renderRuns(this.deps.engine.snapshot().history);
    this.renderOutline(page, selection);
  }

  /**
   * Renomear e editar a condição ficam em um método só porque os dois são
   * "editor de texto do nó" — e assim o comportamento fica igual para todos os
   * tipos, em vez de depender de qual duplo clique o usuário lembrar.
   */
  private renameNode(node: Node): void {
    if (!this.deps.isEdit()) return;
    const next = window.prompt('Nome do nó', node.label);
    if (next) renameNode(this.deps.store, node.id, next);
  }

  private editCondition(node: Node): void {
    const next = window.prompt(
      'Condição (exit == 0, exit != 0, ok, fail…)',
      conditionOf(node),
    );
    if (next !== null) setNodeCondition(this.deps.store, node.id, next);
  }

  /**
   * Histórico de execuções. Cada linha mostra o resultado e abre a lista de
   * passos; clicar num passo seleciona o nó no canvas.
   */
  private renderRuns(runs: readonly WorkflowRun[]): void {
    this.runsEl.replaceChildren();

    if (runs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'outline-empty';
      empty.textContent = 'Nenhuma execução ainda.';
      this.runsEl.appendChild(empty);
      return;
    }

    for (const run of runs) {
      const row = document.createElement('div');
      row.className = 'run-row';
      row.dataset.status = run.status;

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'run-head';
      const duration = run.endedAt ? `${run.endedAt - run.startedAt} ms` : '…';
      const time = new Date(run.startedAt).toLocaleTimeString('pt-BR');
      head.innerHTML =
        `<span class="run-dot" aria-hidden="true"></span>` +
        `<span class="run-name">${escapeText(run.startLabel)}</span>` +
        `<span class="run-meta">${time} · ${duration}</span>`;
      head.addEventListener('click', () => {
        this.expandedRunId = this.expandedRunId === run.id ? null : run.id;
        this.renderRuns(runs);
      });
      row.appendChild(head);
      this.runsEl.appendChild(row);

      if (this.expandedRunId !== run.id) continue;

      const steps = document.createElement('div');
      steps.className = 'run-steps';
      run.steps.forEach((step, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'run-step';
        item.dataset.status = step.status;
        const detail = step.detail ? ` — ${escapeText(step.detail)}` : '';
        item.innerHTML =
          `<span class="run-step-index">${index + 1}</span>` +
          `<span class="run-step-label">${escapeText(step.label)}</span>` +
          `<span class="run-step-detail">${detail}</span>`;
        item.addEventListener('click', () => this.deps.engine.revealStep(run, index));
        steps.appendChild(item);
      });
      if (run.error) {
        const error = document.createElement('p');
        error.className = 'run-error';
        error.textContent = run.error;
        steps.appendChild(error);
      }
      row.appendChild(steps);
      this.runsEl.appendChild(row);
    }
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
      row.dataset.run = this.deps.engine.nodeState(node.id);

      const swatch = document.createElement('span');
      swatch.className = `outline-swatch shape-${node.kind}`;
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'outline-label';
      label.textContent = node.label;
      label.addEventListener('click', () => select(this.deps.store, {type: 'node', id: node.id}));
      // Renomear por aqui funciona para **todo** tipo de nó, inclusive os que
      // têm comportamento próprio (terminal, losango).
      label.addEventListener('dblclick', () => this.renameNode(node));
      label.title = 'Clique seleciona · duplo clique renomeia';

      const rowActions = document.createElement('span');
      rowActions.className = 'outline-actions';

      if (node.kind === 'diamond') {
        // No modo de execução a condição é só informação; no de edição, um
        // botão que abre o editor. Nada de edição escondida num clique.
        const condition = document.createElement(
          this.deps.isEdit() ? 'button' : 'span',
        );
        condition.className = 'outline-condition';
        condition.textContent = conditionOf(node);
        if (this.deps.isEdit()) {
          (condition as HTMLButtonElement).type = 'button';
          condition.title = 'Editar a condição do losango';
          condition.addEventListener('click', () => this.editCondition(node));
        }
        rowActions.appendChild(condition);
      }

      if (this.deps.isEdit()) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'outline-remove';
        remove.textContent = '✕';
        remove.title = 'Excluir nó';
        remove.addEventListener('click', () => removeNode(this.deps.store, node.id));
        rowActions.appendChild(remove);
      }
      row.append(swatch, label, rowActions);
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

        // A lateral da saída diz o lado: direita = sim, esquerda = não.
        const branch = from.kind === 'diamond' ? branchOf(edge) : null;

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'outline-label';
        const badge = branch
          ? `<span class="outline-branch" data-branch="${branch}">${branchLabel(branch)}</span>`
          : '';
        label.innerHTML =
          `${badge}${escapeText(from.label)} <span class="outline-sides">[${SIDE_LABEL[edge.from.side]}→${SIDE_LABEL[edge.to.side]}]</span> ${escapeText(to.label)}`;
        label.addEventListener('click', () => select(this.deps.store, {type: 'edge', id: edge.id}));

        const rowActions = document.createElement('span');
        rowActions.className = 'outline-actions';

        if (this.deps.isEdit()) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'outline-remove';
          remove.textContent = '✕';
          remove.title = 'Excluir conexão';
          remove.addEventListener('click', () => removeEdge(this.deps.store, edge.id));
          rowActions.appendChild(remove);
        }

        row.append(label, rowActions);
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