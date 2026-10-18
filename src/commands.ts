import type {Store} from './store';
import type {Anchor, Edge, Node, Page, Selection} from './types';
import {emptyPage, uid} from './types';

function activePage(draft: {pages: Page[]; activePageId: string}): Page {
  return draft.pages.find((page) => page.id === draft.activePageId) ?? draft.pages[0]!;
}

export function addNode(store: Store, node: Node): void {
  store.update((draft) => {
    activePage(draft).nodes.push(node);
  });
}

export function moveNode(store: Store, nodeId: string, x: number, y: number): void {
  store.update((draft) => {
    const node = activePage(draft).nodes.find((item) => item.id === nodeId);
    if (node) {
      node.x = x;
      node.y = y;
    }
  });
}

export function renameNode(store: Store, nodeId: string, label: string): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  store.update((draft) => {
    const node = activePage(draft).nodes.find((item) => item.id === nodeId);
    if (node) node.label = trimmed;
  });
}

/**
 * Grava o comando de um nó terminal.
 *
 * `history: false` enquanto o usuário digita (o painel de console usa isso para
 * não encher o undo a cada tecla); a primeira tecla de cada sessão de edição já
 * cria o ponto de restauração, então um Ctrl+Z devolve o comando anterior.
 */
export function setNodeCommand(store: Store, nodeId: string, command: string, history = true): void {
  store.update(
    (draft) => {
      const node = activePage(draft).nodes.find((item) => item.id === nodeId);
      if (node) node.command = command;
    },
    {history},
  );
}

/** Remover um nó leva junto todas as arestas que o tocam. */
export function removeNode(store: Store, nodeId: string): void {
  store.update((draft) => {
    const page = activePage(draft);
    page.nodes = page.nodes.filter((node) => node.id !== nodeId);
    page.edges = page.edges.filter(
      (edge) => edge.from.nodeId !== nodeId && edge.to.nodeId !== nodeId,
    );
    if (draft.selection?.type === 'node' && draft.selection.id === nodeId) {
      draft.selection = null;
    }
  });
}

export function removeEdge(store: Store, edgeId: string): void {
  store.update((draft) => {
    const page = activePage(draft);
    page.edges = page.edges.filter((edge) => edge.id !== edgeId);
    if (draft.selection?.type === 'edge' && draft.selection.id === edgeId) {
      draft.selection = null;
    }
  });
}

const sameAnchor = (a: Anchor, b: Anchor): boolean => a.nodeId === b.nodeId && a.side === b.side;

/**
 * Regras de validade de uma ligação. Centralizadas para que a UI e o
 * `dragend` do conector nunca discordem entre si.
 */
export function connectionError(page: Page, from: Anchor, to: Anchor): string | null {
  if (from.nodeId === to.nodeId) return 'Não é possível ligar um nó a si mesmo';
  const exists = (id: string) => page.nodes.some((node) => node.id === id);
  if (!exists(from.nodeId) || !exists(to.nodeId)) return 'Nó inexistente';
  const duplicate = page.edges.some(
    (edge) =>
      (sameAnchor(edge.from, from) && sameAnchor(edge.to, to)) ||
      (sameAnchor(edge.from, to) && sameAnchor(edge.to, from)),
  );
  if (duplicate) return 'Essa conexão já existe';
  return null;
}

export function addEdge(store: Store, from: Anchor, to: Anchor): boolean {
  const page = store.activePage();
  if (connectionError(page, from, to)) return false;
  const edge: Edge = {id: uid('edge'), from: {...from}, to: {...to}};
  store.update((draft) => {
    activePage(draft).edges.push(edge);
  });
  return true;
}

export function select(store: Store, selection: Selection): void {
  store.update(
    (draft) => {
      draft.selection = selection;
    },
    {history: false},
  );
}

export function deleteSelection(store: Store): void {
  const {selection} = store.get();
  if (!selection) return;
  if (selection.type === 'node') removeNode(store, selection.id);
  else removeEdge(store, selection.id);
}

// ---------------------------------------------------------------------------
// páginas
// ---------------------------------------------------------------------------

export function addPage(store: Store, name?: string): void {
  // nome padrão sequencial: a nova página não pode repetir "Página 1"
  const taken = new Set(store.get().pages.map((page) => page.name));
  let label = name?.trim();
  if (!label) {
    let index = store.get().pages.length + 1;
    while (taken.has(`Página ${index}`)) index += 1;
    label = `Página ${index}`;
  }
  const page = emptyPage(label);
  store.update((draft) => {
    draft.pages.push(page);
    draft.activePageId = page.id;
    draft.selection = null;
  });
}

export function setActivePage(store: Store, pageId: string): void {
  if (store.get().pages.some((page) => page.id === pageId)) {
    store.update(
      (draft) => {
        draft.activePageId = pageId;
        draft.selection = null;
      },
      {history: false},
    );
  }
}

export function renamePage(store: Store, pageId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  store.update((draft) => {
    const page = draft.pages.find((item) => item.id === pageId);
    if (page) page.name = trimmed;
  });
}

/** Remove uma página; a última página nunca é removida. */
export function removePage(store: Store, pageId: string): void {
  if (store.get().pages.length <= 1) return;
  store.update((draft) => {
    const index = draft.pages.findIndex((page) => page.id === pageId);
    if (index === -1) return;
    draft.pages.splice(index, 1);
    if (draft.activePageId === pageId) {
      draft.activePageId = draft.pages[Math.max(0, index - 1)]!.id;
    }
    draft.selection = null;
  });
}

export function replaceAllPages(store: Store, pages: Page[], activePageId: string): void {
  if (pages.length === 0) return;
  store.update(
    (draft) => {
      draft.pages = pages;
      draft.activePageId = pages.some((page) => page.id === activePageId)
        ? activePageId
        : pages[0]!.id;
      draft.selection = null;
    },
    {history: false},
  );
}