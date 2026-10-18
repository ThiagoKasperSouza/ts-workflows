import type {Point, Viewport} from './types';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Pan/zoom do canvas.
 *
 * O `layer` recebe `transform: translate(x, y) scale(zoom)` com
 * `transform-origin: 0 0`. Como o `getBoundingClientRect()` de um elemento
 * já devolvido devolvolve a caixa pós-transform, dividir por `zoom` basta para
 * sair do espaço de viewport para o de conteúdo.
 */
export class ViewportController {
  readonly viewport: Viewport = {x: 0, y: 0, zoom: 1};

  private panning: {pointerId: number; startX: number; startY: number; originX: number; originY: number} | null =
    null;

  constructor(
    private readonly surface: HTMLElement,
    private readonly layer: HTMLElement,
    private readonly onChange: () => void,
  ) {
    surface.addEventListener('wheel', this.onWheel, {passive: false});
    surface.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    // escreve a transform sem emitir onChange: durante a construção quem
    // construiu este controller ainda não terminou de avaliar a variável que o
    // guarda, então disparar o callback aqui causaria um ReferenceError (TDZ)
    this.writeTransform();
  }

  clientToContent(clientX: number, clientY: number): Point {
    const rect = this.layer.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / this.viewport.zoom,
      y: (clientY - rect.top) / this.viewport.zoom,
    };
  }

  contentToClient(x: number, y: number): Point {
    const rect = this.layer.getBoundingClientRect();
    return {
      x: rect.left + x * this.viewport.zoom,
      y: rect.top + y * this.viewport.zoom,
    };
  }

  /** Centro da área visível, em espaço de conteúdo. */
  viewportCenter(): Point {
    const rect = this.surface.getBoundingClientRect();
    return this.clientToContent(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /** `factor` > 1 amplia. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    const before = this.clientToContent(clientX, clientY);
    this.viewport.zoom = clampZoom(this.viewport.zoom * factor);
    const after = this.clientToContent(clientX, clientY);
    // mantém o ponto sob o cursor ancorado
    this.viewport.x += (after.x - before.x) * this.viewport.zoom;
    this.viewport.y += (after.y - before.y) * this.viewport.zoom;
    this.apply();
  }

  reset(): void {
    this.viewport.x = 0;
    this.viewport.y = 0;
    this.viewport.zoom = 1;
    this.apply();
  }

  apply(): void {
    this.writeTransform();
    this.onChange();
  }

  private writeTransform(): void {
    const {x, y, zoom} = this.viewport;
    this.layer.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      this.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.002));
      return;
    }
    this.viewport.x -= event.deltaX;
    this.viewport.y -= event.deltaY;
    this.apply();
  };

  private onPointerDown = (event: PointerEvent): void => {
    // botão do meio, ou botão esquerdo em área vazia do canvas
    const isBackground =
      event.target === this.surface || (event.target as HTMLElement)?.dataset?.empty === 'true';
    if (event.button !== 1 && !(event.button === 0 && isBackground)) return;
    this.panning = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: this.viewport.x,
      originY: this.viewport.y,
    };
    this.surface.dataset.panning = 'true';
  };

  private onPointerMove = (event: PointerEvent): void => {
    const panning = this.panning;
    if (!panning || panning.pointerId !== event.pointerId) return;
    this.viewport.x = panning.originX + (event.clientX - panning.startX);
    this.viewport.y = panning.originY + (event.clientY - panning.startY);
    this.apply();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.panning || this.panning.pointerId !== event.pointerId) return;
    this.panning = null;
    delete this.surface.dataset.panning;
  };
}