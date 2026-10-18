import {DragDropManager, Draggable, Droppable, Feedback, PointerSensor, PointerActivationConstraints} from '@dnd-kit/dom';

import type {Node, Page, Point, Selection, ShapeKind, Side} from './types';
import {SIDES} from './types';
import {isStartNode} from './engine';

export const NODE_DRAG_TYPE = 'node';
export const CONNECTOR_DRAG_TYPE = 'connector';
export const PALETTE_DRAG_TYPE = 'palette';

/** Identificadores usados para distinguir a origem do arrasto. */
export const portId = (nodeId: string, side: Side): string => `port:${nodeId}:${side}`;
export const nodeDragId = (nodeId: string): string => `node:${nodeId}`;
export const CANVAS_ID = 'canvas';

/** Limites do "mundo" — o canvas é maior que a viewport e pode ser percorrido. */
export const WORLD = {width: 6000, height: 4000};

/**
 * O sensor das portas ativa no primeiro pixel: arrastar a partir de uma porta
 * precisa começar a desenhar o fio imediatamente, sem limiar de distância.
 */
const ConnectorSensor = PointerSensor.configure({
  activationConstraints(event) {
    if (event.pointerType === 'touch') {
      return [new PointerActivationConstraints.Delay({value: 150, tolerance: 8})];
    }
    return [new PointerActivationConstraints.Distance({value: 0})];
  },
});

/** Os nós exigem 3px de deslocamento para distinguir clique de arrasto. */
const NodeSensor = PointerSensor.configure({
  activationConstraints: (event) =>
    event.pointerType === 'touch'
      ? [new PointerActivationConstraints.Delay({value: 180, tolerance: 6})]
      : [new PointerActivationConstraints.Distance({value: 3})],
});

const shape = (kind: ShapeKind): string => `shape-${kind}`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

class PortView {
  readonly el: HTMLButtonElement;
  readonly draggable: Draggable;
  readonly droppable: Droppable;

  constructor(
    manager: DragDropManager,
    readonly nodeId: string,
    readonly side: Side,
    parent: HTMLElement,
    /**
     * `true` quando esta porta não pode iniciar uma ligação — no losango, as
     * laterais de cima e de baixo são só de entrada, porque as duas saídas
     * (direita = sim, esquerda = não) têm lado reservado.
     */
    readonly sourceOnlyBlocked = false,
  ) {
    this.el = el('button', `port port-${side}`);
    this.el.type = 'button';
    this.el.dataset.port = '';
    this.el.dataset.side = side;
    this.el.setAttribute('aria-label', `Conector ${side.toUpperCase()}`);
    parent.appendChild(this.el);

    const id = portId(nodeId, side);

    this.draggable = new Draggable(
      {
        id,
        element: this.el,
        type: CONNECTOR_DRAG_TYPE,
        data: {nodeId, side},
        sensors: [ConnectorSensor],
        disabled: sourceOnlyBlocked,
        plugins: [
          // 'none' NÃO pode ser usado aqui: o plugin Feedback sai cedo nesse
          // caso e nunca publica `dragOperation.shape`, e `computeCollisions`
          // aborta sem shape — a porta de destino nunca seria detectada.
          Feedback.configure({feedback: 'move', dropAnimation: null}),
        ],
      },
      manager,
    );

    this.droppable = new Droppable(
      {
        id,
        element: this.el,
        // o `data` precisa existir também no droppable: é dele que o
        // `dragend` lê qual nó/lado é o destino da ligação
        data: {nodeId, side},
        // a própria porta de origem acompanha o cursor durante o arrasto e por
        // isso colidiria com ela mesma (distância ~0 ⇒ maior valor). Rejeitar
        // qualquer arrasto originado no mesmo nó elimina essa ambiguidade e
        // já impede a auto-conexão na camada de colisão.
        accept: (source) => (source.data as {nodeId?: string} | undefined)?.nodeId !== nodeId,
        // a porta é pequena e fica dentro do canvas; precisa ganhar a colisão
        collisionPriority: 10,
      },
      manager,
    );
  }

  destroy(): void {
    this.draggable.destroy();
    this.droppable.destroy();
    this.el.remove();
  }

  /** Modo de execução: sem arrasto de porta, ninguém liga nada por acidente. */
  setInteractive(on: boolean): void {
    this.draggable.disabled = !on || this.sourceOnlyBlocked;
    this.droppable.disabled = !on;
  }
}

export class NodeView {
  readonly el: HTMLElement;
  readonly bodyEl: HTMLElement;
  readonly draggable: Draggable;
  private readonly ports = new Map<Side, PortView>();

  private pointerDownAt: Point | null = null;

  constructor(
    manager: DragDropManager,
    node: Node,
    private readonly handlers: {
      onSelect: (selection: Selection) => void;
      onRename: (node: Node) => void;
    },
  ) {
    this.el = el('div', 'node');
    this.el.dataset.nodeId = node.id;

    // O corpo é o handle do nó. As portas são IRMÃS do corpo, nunca filhas:
    // o sensor do nó só faz bind de pointerdown no handle, então arrastar a
    // partir de uma porta nunca move o nó — sem precisar de preventActivation.
    this.bodyEl = el('div', `node-body ${shape(node.kind)}`);
    this.bodyEl.dataset.role = 'body';
    this.el.appendChild(this.bodyEl);

    for (const side of SIDES) {
      // no losango, n/s são entradas; e/w são as duas saídas (sim/não)
      const blocked = node.kind === 'diamond' && (side === 'n' || side === 's');
      this.ports.set(side, new PortView(manager, node.id, side, this.el, blocked));
    }

    this.el.addEventListener('pointerdown', (event) => {
      this.pointerDownAt = {x: event.clientX, y: event.clientY};
    });
    this.el.addEventListener('click', (event) => {
      const start = this.pointerDownAt;
      this.pointerDownAt = null;
      if (start) {
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved > 4) return; // foi arrasto, não clique
      }
      event.stopPropagation();
      this.handlers.onSelect({type: 'node', id: node.id});
    });
    this.bodyEl.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      // Duplo clique é sempre "renomear", para qualquer tipo de nó. Comando e
      // condição têm controles próprios (painel do terminal e a etiqueta de
      // condição na barra lateral) — especializar o duplo clique por tipo fazia o
      // losango ficar sem nenhum jeito de trocar o nome pela interface.
      this.handlers.onRename(node);
    });

    this.draggable = new Draggable(
      {
        id: nodeDragId(node.id),
        element: this.el,
        handle: this.bodyEl,
        type: NODE_DRAG_TYPE,
        data: {nodeId: node.id},
        sensors: [NodeSensor],
      },
      manager,
    );

    this.apply(node);
  }

  /** Espelho do modelo no DOM. Só mexe no que mudou. */
  apply(node: Node): void {
    this.el.dataset.kind = node.kind;
    this.el.style.width = `${node.w}px`;
    this.el.style.height = `${node.h}px`;
    // `transform` (e não a propriedade `translate`) é a posição de repouso: o
    // plugin Feedback do dnd-kit usa `translate` para o delta do arrasto e
    // preserva o `transform` original, então os dois não competem.
    this.el.style.transform = `translate(${node.x}px, ${node.y}px)`;
    const label = this.bodyEl.firstElementChild as HTMLElement | null;
    if (label?.textContent !== node.label) {
      if (label) label.textContent = node.label;
      else this.bodyEl.appendChild(el('span', 'node-label')).textContent = node.label;
    }
    this.applyCommand(node);
    this.applyDecisionHints(node);
    this.bodyEl.className = `node-body ${shape(node.kind)}`;
  }

  /**
   * Nós terminal mostram o comando sob o rótulo — o diagrama já informa o que
   * o passo executa, sem precisar selecionar o nó. O elemento é criado uma vez
   * e reaproveitado; só o texto muda.
   */
  private applyCommand(node: Node): void {
    let preview = this.bodyEl.querySelector<HTMLElement>('.node-command');
    if (node.kind !== 'terminal') {
      preview?.remove();
      return;
    }
    if (!preview) {
      preview = el('span', 'node-command');
      this.bodyEl.appendChild(preview);
    }
    const text = node.command?.trim() || '(sem comando)';
    if (preview.textContent !== text) preview.textContent = text;
    preview.title = node.command ?? '';
  }

  /**
   * O losango diz no próprio corpo para que lado é qual: sem isso o usuário só
   * descobre qual saída é o "sim" depois de rodar o fluxo.
   */
  private applyDecisionHints(node: Node): void {
    const hints = this.bodyEl.querySelector<HTMLElement>('.node-hints');
    if (node.kind !== 'diamond') {
      hints?.remove();
      return;
    }
    if (!hints) {
      const box = el('span', 'node-hints');
      box.append(
        Object.assign(el('span', 'node-hint is-false'), {textContent: 'não'}),
        Object.assign(el('span', 'node-hint is-true'), {textContent: 'sim'}),
      );
      this.bodyEl.appendChild(box);
    }
  }

  private runState: string | null = null;

  setSelected(selected: boolean): void {
    this.el.dataset.selected = selected ? 'true' : 'false';
  }

  /**
   * Estado da execução (running/ok/error/skipped) desenhado no nó. Vai no
   * `dataset` para o CSS fazer o destaque — nada de criar elementos novos, que
   * quebrariam o handle de arrasto do dnd-kit.
   */
  setRunState(state: string | null): void {
    if (this.runState === state) return;
    this.runState = state;
    if (state) this.el.dataset.run = state;
    else delete this.el.dataset.run;
  }

  /**
   * Marca o nó de início (elipse sem entrada, com saída). Só interessa no modo
   * de execução, onde clicar nele dispara o fluxo — o cursor e o ▶ vêm do CSS.
   */
  setStart(start: boolean): void {
    if (start) this.el.dataset.start = 'true';
    else delete this.el.dataset.start;
  }

  /**
   * Modo edição: habilita arrasto do nó e das portas. No modo de execução o nó
   * fica travado no lugar — mexer no desenho não faz sentido enquanto o fluxo
   * roda.
   */
  setInteractive(on: boolean): void {
    this.draggable.disabled = !on;
    for (const port of this.ports.values()) port.setInteractive(on);
  }

  /** `portId` → `{nodeId, side}` das portas deste nó, para validar arestas. */
  destroy(): void {
    for (const port of this.ports.values()) port.destroy();
    this.ports.clear();
    this.draggable.destroy();
    this.el.remove();
  }
}

export class NodeLayer {
  private readonly views = new Map<string, NodeView>();

  constructor(
    private readonly manager: DragDropManager,
    private readonly host: HTMLElement,
    private readonly handlers: {
      onSelect: (selection: Selection) => void;
      onRename: (node: Node) => void;
    },
  ) {}

  /** Reconciliação por id: nós existentes são reaproveitados, nunca recriados. */
  render(
    page: Page,
    selection: Selection,
    runStates?: ReadonlyMap<string, string>,
    interactive = true,
  ): void {
    const seen = new Set<string>();

    for (const node of page.nodes) {
      seen.add(node.id);
      let view = this.views.get(node.id);
      if (!view) {
        view = new NodeView(this.manager, node, this.handlers);
        this.views.set(node.id, view);
        this.host.appendChild(view.el);
      }
      view.apply(node);
      view.setSelected(selection?.type === 'node' && selection.id === node.id);
      view.setRunState(runStates?.get(node.id) ?? null);
      view.setInteractive(interactive);
      view.setStart(isStartNode(page, node));
    }

    for (const [id, view] of [...this.views]) {
      if (seen.has(id)) continue;
      view.destroy();
      this.views.delete(id);
    }
  }

  /** Ids das portas vivas — usado para decidir se uma aresta ainda é válida. */
  clear(): void {
    for (const view of this.views.values()) view.destroy();
    this.views.clear();
  }
}