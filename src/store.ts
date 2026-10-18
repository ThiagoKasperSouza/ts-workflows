import {emptyPage, type Page, type State} from './types';

const KEY = 'dnd-diagram:v1';

export type Listener = (state: State) => void;

export interface CommitOptions {
  /**
   * `false` para mudanças que não devem entrar no histórico
   * (troca de página, seleção, movimentações feitas durante um drag contínuo).
   */
  history?: boolean;
}

const clone = <T,>(value: T): T => structuredClone(value);

/**
 * Store minimalista com pub/sub, snapshots de undo/redo e persistência
 * automática em localStorage.
 */
export class Store {
  private state: State;
  private listeners = new Set<Listener>();
  private past: State[] = [];
  private future: State[] = [];
  private saveTimer: number | undefined;

  constructor(initial: State) {
    this.state = initial;
  }

  get(): State {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Aplica uma mutação e, por padrão, registra um ponto de undo. */
  update(recipe: (draft: State) => void, options: CommitOptions = {}): void {
    const history = options.history ?? true;
    if (history) {
      this.past.push(clone(this.state));
      if (this.past.length > 100) this.past.shift();
      this.future = [];
    }
    const draft = clone(this.state);
    recipe(draft);
    this.state = draft;
    this.emit();
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(clone(this.state));
    this.state = previous;
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(clone(this.state));
    this.state = next;
    this.emit();
  }

  activePage(): Page {
    return (
      this.state.pages.find((page) => page.id === this.state.activePageId) ??
      this.state.pages[0]!
    );
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.state);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 300) as unknown as number;
  }

  save(): void {
    try {
      const {pages, activePageId} = this.state;
      localStorage.setItem(KEY, JSON.stringify({pages, activePageId}));
    } catch {
      // quota/ modo privado — a aplicação continua funcionando em memória
    }
  }
}

function isState(value: unknown): value is State {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {pages?: unknown; activePageId?: unknown};
  return Array.isArray(candidate.pages) && typeof candidate.activePageId === 'string';
}

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isState(parsed) && parsed.pages.length > 0) {
        const hasActive = parsed.pages.some((page) => page.id === parsed.activePageId);
        return new Store({
          ...parsed,
          activePageId: hasActive ? parsed.activePageId : parsed.pages[0]!.id,
          selection: null,
        });
      }
    }
  } catch {
    // JSON corrompido: começa limpo
  }
  const page = emptyPage();
  return new Store({pages: [page], activePageId: page.id, selection: null});
}