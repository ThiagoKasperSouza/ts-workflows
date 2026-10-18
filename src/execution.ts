import {cancelRun, sendInput, streamRun, type RunEvent} from './api';
import {
  conditionOf,
  isDecision,
  isTerminal,
  nextStep,
  stepLabel,
  type Branch,
} from './engine';
import type {Store} from './store';
import {select} from './commands';
import type {Edge, Node, Page} from './types';
import {uid} from './types';
import type {TerminalLine} from './terminal-window';

/**
 * Runtime do motor de workflow: orquestra a travessia do grafo, guarda o
 * estado de execução para os highlights do canvas e mantém o histórico.
 *
 * O estado de execução NÃO vive no `store`: o store é o desenho (undo/redo,
 * localStorage), e uma execução é efêmera. Aqui fica só em memória, como o
 * buffer de saída do terminal.
 */

export type StepStatus = 'running' | 'ok' | 'error' | 'skipped' | 'canceled';

export interface StepResult {
  nodeId: string;
  label: string;
  kind: Node['kind'];
  status: StepStatus;
  exitCode: number | null;
  durationMs: number;
  detail: string;
  /** Variáveis que este terminal exportou (as declaradas em "expõe"). */
  vars: Record<string, string>;
}

export type RunStatus = 'running' | 'ok' | 'error' | 'canceled';

export interface WorkflowRun {
  id: string;
  pageId: string;
  pageName: string;
  startNodeId: string;
  startLabel: string;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  steps: StepResult[];
  /** Variáveis acumuladas pelos terminais da execução (vistas pelas decisões). */
  vars: Record<string, string>;
  /** Janela de terminal que recebe a saída desta execução. */
  windowKey: string;
  error: string | null;
}

/** Estado por nó para os highlights do canvas. */
export type NodeRunState = StepStatus | 'idle';

export interface ExecutionSnapshot {
  /** Execução em andamento (a mais recente). */
  currentRun: WorkflowRun | null;
  /** Estado por nó da execução em andamento. */
  nodeStates: ReadonlyMap<string, NodeRunState>;
  /** Arestas percorridas na execução em andamento. */
  activeEdges: ReadonlySet<string>;
  /** aresta "em avaliação" no instante, desenhada mais grossa. */
  currentEdge: string | null;
  history: readonly WorkflowRun[];
}

type Listener = (snapshot: ExecutionSnapshot) => void;

const HISTORY_LIMIT = 20;

/**
 * Janelas de terminal abertas por execução/nó. Cada execução do fluxo abre a
 * sua própria; a chave é o nome da janela, o que permite reusá-la.
 */
export interface TerminalSink {
  /**
   * Prepara a janela (deve ser chamado dentro de um gesto do usuário).
   * Devolve `false` se o navegador bloqueou o popup — a execução continua e a
   * saída fica disponível no buffer (é o que o painel do nó mostra).
   */
  ensure(key: string, title: string): boolean;
  line(key: string, stream: 'stdout' | 'stderr' | 'meta' | 'command', text: string): void;
  status(
    key: string,
    status: 'running' | 'ok' | 'error' | 'canceled',
    detail: string,
  ): void;
  /** Últimas linhas do buffer — fallback quando não há janela aberta. */
  lines(key: string, limit?: number): TerminalLine[];
  /**
   * Liga o campo de entrada de uma janela ao processo que está esperando.
   * `null` desliga (a execução daquele passo acabou).
   */
  setInputHandler(key: string, handler: ((data: string) => void) | null): void;
  clear(key: string): void;
  close(key: string): void;
  isOpen(key: string): boolean;
}

export class ExecutionEngine {
  private listeners = new Set<Listener>();
  private history: WorkflowRun[] = [];
  private currentRun: WorkflowRun | null = null;
  private nodeStates = new Map<string, NodeRunState>();
  private activeEdges = new Set<string>();
  private currentEdge: string | null = null;

  /** Abort da execução em andamento e do comando em voo. */
  private workflowAbort: AbortController | null = null;
  private currentStepAbort: AbortController | null = null;
  private currentRunId: string | null = null;

  constructor(
    private readonly deps: {
      store: Store;
      sink: TerminalSink;
      onToast: (message: string) => void;
    },
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): ExecutionSnapshot {
    return {
      currentRun: this.currentRun,
      nodeStates: this.nodeStates,
      activeEdges: this.activeEdges,
      currentEdge: this.currentEdge,
      history: this.history,
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.snapshot());
  }

  isRunning(): boolean {
    return this.currentRun?.status === 'running';
  }

  /** Cancela a execução em andamento (e o comando em voo). */
  async cancel(): Promise<void> {
    const run = this.currentRun;
    if (!run || run.status !== 'running') return;
    this.currentStepAbort?.abort();
    this.workflowAbort?.abort();
    if (this.currentRunId) await cancelRun(this.currentRunId);
    run.status = 'canceled';
    for (const step of run.steps) {
      if (step.status === 'running') {
        step.status = 'canceled';
        this.nodeStates.set(step.nodeId, 'canceled');
      }
    }
    this.deps.sink.status(run.windowKey, 'canceled', 'execução cancelada');
    this.deps.sink.line(run.windowKey, 'meta', 'execução cancelada');
    this.endRun(run, 'canceled');
  }

  /**
   * Executa o fluxo a partir de `startNode`. Só aceita nós de início
   * (elipse sem arestas de entrada) — quem valida isso é o chamador, que
   * decide se um clique deve disparar ou apenas selecionar.
   */
  async run(startNodeId: string): Promise<void> {
    if (this.isRunning()) {
      this.deps.onToast('Já existe uma execução em andamento — cancele antes de iniciar outra');
      return;
    }

    const page = this.deps.store.activePage();
    const start = page.nodes.find((node) => node.id === startNodeId);
    if (!start) return;

    const windowKey = `wf-run-${uid('w').slice(0, 8)}`;
    const run: WorkflowRun = {
      id: uid('run'),
      pageId: page.id,
      pageName: page.name,
      startNodeId: start.id,
      startLabel: start.label,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      steps: [],
      vars: {},
      windowKey,
      error: null,
    };

    this.workflowAbort = new AbortController();
    this.currentRun = run;
    this.nodeStates = new Map();
    this.activeEdges = new Set();
    this.currentEdge = null;

    this.history.unshift(run);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;

    // A janela precisa existir já no gesto do clique: abrir depois (depois de um
    // await) seria bloqueado como popup pelo browser.
    openTerminal(this.deps.sink, windowKey, `Fluxo · ${page.name}`, () =>
      this.deps.onToast(
        'O navegador bloqueou a janela do terminal — libere popups para este site. A saída aparece no painel de cada nó.',
      ),
    );
    this.deps.sink.status(windowKey, 'running', `iniciando em "${start.label}"`);
    this.deps.sink.line(windowKey, 'command', `$▶ ${start.label}`);

    this.emit();

    try {
      await this.walk(page, run, start);
      if (run.status === 'running') this.endRun(run, 'ok');
    } catch (error) {
      run.error = (error as Error).message;
      if (run.status !== 'canceled') {
        run.status = 'error';
        this.deps.sink.line(runKey(run), 'meta', `erro: ${run.error}`);
        this.endRun(run, 'error');
      }
    } finally {
      this.workflowAbort = null;
      this.currentStepAbort = null;
      this.currentRunId = null;
      this.currentEdge = null;
      this.emit();
    }
  }

  /**
   * Executa um único nó terminal, sem percorrer o fluxo — é o botão "Executar"
   * do painel do nó. A saída vai para a janela do próprio nó (que sobrevive a
   * reexecuções e à troca de seleção).
   */
  async runNode(nodeId: string): Promise<void> {
    if (this.isRunning()) {
      this.deps.onToast('Já existe uma execução em andamento — cancele antes de iniciar outra');
      return;
    }
    const page = this.deps.store.activePage();
    const node = page.nodes.find((item) => item.id === nodeId);
    if (!node) return;

    const windowKey = nodeWindowKey(node.id);
    const run: WorkflowRun = {
      id: uid('run'),
      pageId: page.id,
      pageName: page.name,
      startNodeId: node.id,
      startLabel: node.label,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      steps: [],
      vars: {},
      windowKey,
      error: null,
    };

    this.workflowAbort = new AbortController();
    this.currentRun = run;
    this.nodeStates = new Map();
    this.activeEdges = new Set();
    this.currentEdge = null;

    this.history.unshift(run);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;

    openTerminal(this.deps.sink, windowKey, `Terminal · ${node.label}`, () =>
      this.deps.onToast('Janela do terminal bloqueada pelo navegador — a saída aparece aqui no painel.'),
    );
    this.emit();

    try {
      const step = this.beginStep(run, node);
      this.emit();
      const outcome = await this.executeStep(run, node, step);
      if (outcome) {
        step.exitCode = outcome.exitCode;
        this.finishStep(step, outcome.exitCode);
        this.endRun(run, step.status === 'error' ? 'error' : 'ok');
      } else {
        this.endRun(run, 'canceled');
      }
    } catch (error) {
      run.error = (error as Error).message;
      if (run.status !== 'canceled') {
        run.status = 'error';
        this.deps.sink.line(runKey(run), 'meta', `erro: ${run.error}`);
        this.endRun(run, 'error');
      }
    } finally {
      this.workflowAbort = null;
      this.currentStepAbort = null;
      this.currentRunId = null;
      this.currentEdge = null;
      this.emit();
    }
  }

  /** Estado do nó na execução em andamento (ou da última, se já terminou). */
  nodeState(nodeId: string): NodeRunState {
    return this.nodeStates.get(nodeId) ?? 'idle';
  }

  /**
   * (Re)abre a janela de terminal de um nó sem executar nada — usado pelo botão
   * "Janela" do painel, que precisa abrir dentro do gesto do clique.
   */
  reopenTerminal(nodeId: string): void {
    const node = this.deps.store.activePage().nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const key = nodeWindowKey(nodeId);
    const step = lastStepOf(this, nodeId);
    openTerminal(this.deps.sink, key, `Terminal · ${node.label}`, () =>
      this.deps.onToast('O navegador bloqueou a janela do terminal — libere popups para este site.'),
    );
    if (step) this.deps.sink.status(key, step.status === 'error' ? 'error' : step.status === 'canceled' ? 'canceled' : 'ok', step.detail);
  }

  /** Últimas linhas de saída de um terminal — usado pelo painel do nó. */
  tailOf(nodeId: string, limit = 40): TerminalLine[] {
    return this.deps.sink.lines(nodeWindowKey(nodeId), limit);
  }

  /** Execução em andamento que envolve este nó, se houver. */
  runOfNode(nodeId: string): WorkflowRun | null {
    const current = this.currentRun;
    if (current?.status === 'running' && current.steps.some((step) => step.nodeId === nodeId)) {
      return current;
    }
    return null;
  }

  /** Percorre o grafo a partir de `node`, um passo por vez. */
  private async walk(page: Page, run: WorkflowRun, node: Node): Promise<void> {
    const visited = new Set<string>();
    let current: Node | undefined = node;
    let lastExit: number | null = null;

    while (current) {
      if (this.workflowAbort?.signal.aborted) return;

      if (visited.has(current.id)) {
        throw new Error(
          `Ciclo detectado em "${current.label}": este motor não repete nós. Use um terminal para iterar.`,
        );
      }
      visited.add(current.id);

      const step = this.beginStep(run, current);
      this.emit();

      const outcome = await this.executeStep(run, current, step);
      if (!outcome) return; // cancelado no meio do comando
      // Só um terminal produz exit code; um losango decide com o do terminal
      // que veio antes dele, não com o seu próprio (que é sempre null).
      if (isTerminal(current)) lastExit = outcome.exitCode;

      let next: ReturnType<typeof nextStep>;
      try {
        next = nextStep(page, current, {
          exitCode: isDecision(current) ? lastExit : outcome.exitCode,
          vars: run.vars,
        });
      } catch (error) {
        step.status = 'error';
        step.detail = (error as Error).message;
        this.nodeStates.set(current.id, 'error');
        this.emit();
        throw error;
      }

      step.detail = step.detail || next.reason;
      if (next.kind === 'halt') {
        this.finishStep(step, outcome.exitCode);
        this.deps.sink.line(runKey(run), 'meta', `· ${next.reason}`);
        this.endRun(run, 'ok');
        return;
      }

      this.finishStep(step, outcome.exitCode);
      this.markEdge(next.edge);
      this.emit();

      const target = page.nodes.find((item) => item.id === next.edge.to.nodeId);
      if (!target) {
        throw new Error(`A conexão de "${current.label}" aponta para um nó que não existe`);
      }
      this.deps.sink.line(runKey(run), 'meta', `→ ${target.label}`);
      current = target;
    }
  }

  private beginStep(run: WorkflowRun, node: Node): StepResult {
    const step: StepResult = {
      nodeId: node.id,
      label: stepLabel(node),
      kind: node.kind,
      status: 'running',
      exitCode: null,
      durationMs: 0,
      detail: '',
      vars: {},
    };
    run.steps.push(step);
    this.nodeStates.set(node.id, 'running');

    if (isDecision(node)) {
      this.deps.sink.line(runKey(run), 'meta', `◆ ${node.label}? ${conditionOf(node)}`);
    } else if (!isTerminal(node)) {
      this.deps.sink.line(runKey(run), 'meta', `□ ${node.label}`);
    }
    return step;
  }

  /** Executa um nó e devolve o exit code, ou `null` se cancelado. */
  private async executeStep(
    run: WorkflowRun,
    node: Node,
    step: StepResult,
  ): Promise<{exitCode: number | null} | null> {
    if (node.kind === 'text') {
      step.status = 'ok';
      step.durationMs = 0;
      step.detail = 'anotação (não executa nada)';
      this.nodeStates.set(node.id, 'ok');
      return {exitCode: null};
    }

    if (!isTerminal(node)) {
      step.status = 'ok';
      // O losango recebe o detalhe depois, com a condição avaliada e o lado
      // escolhido; aqui não há nada a dizer ainda.
      step.detail = isDecision(node) ? '' : 'passagem';
      this.nodeStates.set(node.id, 'ok');
      return {exitCode: null};
    }

    const command = (node.command ?? '').trim();
    if (!command) {
      step.status = 'error';
      step.detail = 'nó terminal sem comando';
      this.nodeStates.set(node.id, 'error');
      throw new Error(`O terminal "${node.label}" está sem comando`);
    }

    const started = Date.now();
    this.currentStepAbort = new AbortController();
    this.deps.sink.line(runKey(run), 'command', `$ ${command}`);
    this.openInput(runKey(run), node.id);

    try {
      const result = await streamRun(
        command,
        // A saída vai para a janela da execução E para a do nó: sem popups
        // (bloqueados ou fechados), o painel do nó é o único lugar onde o
        // usuário consegue ver o que aquele passo fez durante o fluxo.
        (event: RunEvent) => {
          this.forward(run, event);
          if (event.type === 'stdout' || event.type === 'stderr') {
            this.deps.sink.line(nodeWindowKey(node.id), event.type, event.data);
          }
        },
        this.currentStepAbort.signal,
        {exports: node.exposes ?? []},
      );
      this.currentRunId = null;

      // Só o que o nó declarou chega ao fluxo — e passa a valer para os
      // próximos passos, inclusive para a decisão seguinte.
      if (Object.keys(result.vars).length > 0) {
        step.vars = {...result.vars};
        Object.assign(run.vars, result.vars);
        const resumo = Object.entries(result.vars)
          .map(([name, value]) => `${name}=${value === '' ? '(vazio)' : value}`)
          .join(' · ');
        this.deps.sink.line(runKey(run), 'meta', `↦ ${resumo}`);
      }

      step.durationMs = Date.now() - started;
      step.exitCode = result.code;
      step.status = result.code === 0 ? 'ok' : 'error';
      const vars = Object.entries(result.vars)
        .map(([name, value]) => `${name}=${value === '' ? '(vazio)' : value}`)
        .join(' · ');
      step.detail = result.timedOut
        ? 'tempo esgotado'
        : `${result.code === 0 ? 'exit 0' : `exit ${result.code ?? result.signal}`}${
            vars ? ` · ${vars}` : ''
          }`;
      this.nodeStates.set(node.id, step.status);
      this.deps.sink.status(runKey(run), result.code === 0 ? 'ok' : 'error', step.detail);
      return {exitCode: result.code};
    } catch (error) {
      this.currentRunId = null;
      const aborted = (error as Error).name === 'AbortError';
      step.durationMs = Date.now() - started;
      step.status = aborted ? 'canceled' : 'error';
      step.detail = aborted ? 'cancelado' : (error as Error).message;
      this.nodeStates.set(node.id, step.status);
      if (!aborted) throw error;
      return null;
    } finally {
      this.currentStepAbort = null;
      this.closeInput(runKey(run), node.id);
    }
  }

  /**
   * O que a janela de terminal digita vai para o stdin do processo. Ligado nas
   * duas janelas (a do fluxo e a do nó) porque ambas mostram a mesma execução.
   */
  private openInput(...keys: string[]): void {
    const handler = (data: string) => {
      if (!this.currentRunId) {
        this.deps.onToast('A execução não está mais esperando entrada');
        return;
      }
      void sendInput(this.currentRunId, data).then((error) => {
        if (error) this.deps.onToast(`Entrada não enviada: ${error}`);
      });
    };
    for (const key of keys) this.deps.sink.setInputHandler(key, handler);
  }

  private closeInput(...keys: string[]): void {
    for (const key of keys) this.deps.sink.setInputHandler(key, null);
  }

  private finishStep(step: StepResult, exitCode: number | null): void {
    step.exitCode = exitCode;
    if (step.status === 'running') step.status = 'ok';
  }

  private forward(run: WorkflowRun, event: RunEvent): void {
    switch (event.type) {
      case 'start':
        this.currentRunId = event.runId;
        return;
      case 'stdout':
        this.deps.sink.line(runKey(run), 'stdout', event.data);
        return;
      case 'stderr':
        this.deps.sink.line(runKey(run), 'stderr', event.data);
        return;
      case 'limit':
        this.deps.sink.line(
          runKey(run),
          'meta',
          `saída truncada em ${event.maxOutputBytes} bytes — processo encerrado`,
        );
        return;
      case 'exit':
        this.currentRunId = null;
        return;
    }
  }

  private markEdge(edge: Edge): void {
    this.activeEdges.add(edge.id);
    this.currentEdge = edge.id;
  }

  private endRun(run: WorkflowRun, status: RunStatus): void {
    run.status = status;
    run.endedAt = Date.now();
    const total = run.endedAt - run.startedAt;
    const failed = run.steps.filter((step) => step.status === 'error').length;
    const detail =
      status === 'ok'
        ? `${run.steps.length} passo(s) · ${total} ms`
        : `${failed} falha(s) · ${total} ms`;
    this.deps.sink.status(runKey(run), status, detail);
    this.emit();
  }

  /** Leva a seleção ao nó de um passo (para o canvas centralizar nele). */
  revealStep(run: WorkflowRun, index: number): void {
    const step = run.steps[index];
    if (!step) return;
    select(this.deps.store, {type: 'node', id: step.nodeId});
  }
}

/** Chave da janela de terminal de uma execução. */
export const runKey = (run: WorkflowRun): string => run.windowKey;

/** Janela de terminal de um nó isolado (uma por nó, estável entre execuções). */
export const nodeWindowKey = (nodeId: string): string => `wf-node-${nodeId}`;

/**
 * Abre a janela de um terminal e avisa quando o navegador bloqueou. A execução
 * NÃO é abortada: a saída continua no buffer e aparece no painel do nó, então
 * o fluxo segue funcionando mesmo sem popups liberados.
 */
function openTerminal(
  sink: TerminalSink,
  key: string,
  title: string,
  onBlocked: () => void,
): void {
  if (!sink.ensure(key, title)) onBlocked();
}

/** Rótulo curto do lado de uma saída de losango. */
export const branchLabel = (branch: Branch): string => (branch === 'true' ? 'sim' : 'não');

/** Último passo registrado para o nó, em qualquer execução (inclusive a atual). */
export function lastStepOf(
  engine: ExecutionEngine,
  nodeId: string,
): StepResult | null {
  for (const run of engine.snapshot().history) {
    for (let index = run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.steps[index];
      if (step && step.nodeId === nodeId) return step;
    }
  }
  return null;
}