import type {DragDropManager, Draggable} from '@dnd-kit/dom';

import type {EdgeLayer} from './edges';
import {nodeAnchor} from './edges';
import type {Store} from './store';
import type {Anchor, Side} from './types';
import {addEdge, connectionError} from './commands';
import {CONNECTOR_DRAG_TYPE} from './nodes';
import type {ViewportController} from './viewport';

const OPPOSITE: Record<Side, Side> = {n: 's', s: 'n', e: 'w', w: 'e'};

function anchorData(source: Draggable | null): Anchor | null {
  const data = source?.data as Anchor | undefined;
  if (!data || typeof data.nodeId !== 'string' || typeof data.side !== 'string') return null;
  return data;
}

/**
 * Arrasto do conector.
 *
 * A porta de origem já é um `Draggable` de tipo `connector` e toda porta é um
 * `Droppable` que aceita `connector`. Isso faz o dnd-kit cuidar de toda a
 * detecção de colisão: no `dragend`, `operation.target` já É a porta de destino
 * — não existe hit-test manual aqui.
 */
export class ConnectorController {
  private origin: Anchor | null = null;
  private canceled = false;

  constructor(
    private readonly manager: DragDropManager,
    private readonly deps: {
      store: Store;
      edgeLayer: EdgeLayer;
      viewport: ViewportController;
      onInvalid: (reason: string) => void;
    },
  ) {
    const {monitor} = manager;
    monitor.addEventListener('dragstart', this.onDragStart);
    monitor.addEventListener('dragmove', this.onDragMove);
    monitor.addEventListener('dragover', this.onDragOver);
    monitor.addEventListener('dragend', this.onDragEnd);
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    const {monitor} = this.manager;
    monitor.removeEventListener('dragstart', this.onDragStart);
    monitor.removeEventListener('dragmove', this.onDragMove);
    monitor.removeEventListener('dragover', this.onDragOver);
    monitor.removeEventListener('dragend', this.onDragEnd);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private isConnector(source: Draggable | null): boolean {
    return source?.type === CONNECTOR_DRAG_TYPE;
  }

  private markPort(anchor: Anchor | null, active: boolean): void {
    if (!anchor) return;
    const port = this.manager.registry.droppables.get(`port:${anchor.nodeId}:${anchor.side}`);
    port?.element?.toggleAttribute('data-active', active);
  }

  private onDragStart = (event: {operation: {source: Draggable | null}}): void => {
    if (!this.isConnector(event.operation.source)) return;
    this.origin = anchorData(event.operation.source);
    this.canceled = false;
    this.markPort(this.origin, true);
  };

  private onDragMove = (event: {
    operation: {source: Draggable | null; position: {current: {x: number; y: number}}};
  }): void => {
    const origin = this.origin;
    if (!origin || !this.isConnector(event.operation.source)) return;
    const node = this.deps.store.activePage().nodes.find((item) => item.id === origin.nodeId);
    if (!node) return;

    const from = nodeAnchor(node, origin.side);
    const cursor = event.operation.position.current;
    const to = this.deps.viewport.clientToContent(cursor.x, cursor.y);
    // a curva sai do cursor na direção oposta à origem, para o fio "sair" da
    // lateral do nó em vez de mergulhar nele
    this.deps.edgeLayer.drawTemp(from, origin.side, to, OPPOSITE[origin.side]);
  };

  private onDragOver = (event: {
    operation: {source: Draggable | null; target: {element?: Element} | null};
  }): void => {
    const origin = this.origin;
    if (!origin || !this.isConnector(event.operation.source)) return;
    const target = event.operation.target?.element;
    const hovered = target?.closest?.('[data-port]') ?? null;
    for (const port of this.deps.edgeLayer.layer.querySelectorAll('[data-port]')) {
      port.toggleAttribute('data-hover', port === hovered);
    }
  };

  private onDragEnd = (event: {
    operation: {source: Draggable | null; target: {data?: unknown} | null; canceled: boolean};
  }): void => {
    const origin = this.origin;
    if (!origin || !this.isConnector(event.operation.source)) return;

    this.origin = null;
    this.markPort(origin, false);
    for (const port of this.deps.edgeLayer.layer.querySelectorAll('[data-port]')) {
      port.removeAttribute('data-hover');
    }
    this.deps.edgeLayer.clearTemp();

    if (event.operation.canceled || this.canceled) return;

    const target = anchorData(event.operation.target as Draggable | null);
    if (!target) return; // solto no vazio: descarta o fio

    const page = this.deps.store.activePage();
    const reason = connectionError(page, origin, target);
    if (reason) {
      this.deps.onInvalid(reason);
      return;
    }
    addEdge(this.deps.store, origin, target);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.origin) return;
    this.canceled = true;
    this.manager.dragOperation.canceled = true;
  };
}