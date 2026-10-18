import type {Store} from './store';
import {setNodeCommand} from './commands';
import type {Node} from './types';

/**
 * Painel de console do nó terminal selecionado.
 *
 * Não guarda estado de execução no store: o histórico de undo do diagrama é
 * sobre o desenho, e saída de comando é dado volátil (e potencialmente
 * grande). Cada nó tem seu próprio buffer em memória, que sobrevive à troca de
 * seleção enquanto a aba estiver aberta.
 */

interface Line {
  stream: 'stdout' | 'stderr' | 'meta' | 'command';
  text: string;
}

type RunStatus = 'idle' | 'running' | 'ok' | 'error' | 'canceled';

const STATUS_LABEL: Record<RunStatus, string> = {
  idle: 'Pronto',
  running: 'Executando…',
  ok: 'Concluído',
  error: 'Falhou',
  canceled: 'Cancelado',
};

interface RunState {
  lines: Line[];
  status: RunStatus;
  startedAt: number;
  runId: string | null;
  controller: AbortController | null;
}

const newRunState = (): RunState => ({
  lines: [],
  status: 'idle',
  startedAt: 0,
  runId: null,
  controller: null,
});

/** Acumula chunks em linhas completas; o resto fica pendente. */
class LineBuffer {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts;
  }

  flush(): string | null {
    if (!this.pending) return null;
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}

export class TerminalConsole {
  private readonly titleEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly outputEl: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;

  private readonly runs = new Map<string, RunState>();
  private currentId: string | null = null;
  /** Primeira tecla desde o foco: só ela cria o ponto de undo. */
  private typedSinceFocus = false;
  private statusTimer = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: {store: Store; onError: (message: string) => void},
  ) {
    root.className = 'run-console';
    root.innerHTML = `
      <header class="run-console-bar">
        <span class="run-console-title"></span>
        <span class="run-console-status" data-status></span>
        <div class="run-console-actions">
          <button type="button" class="run-console-run" data-run>Executar <kbd>Ctrl+Enter</kbd></button>
          <button type="button" class="run-console-cancel" data-cancel>Cancelar</button>
          <button type="button" class="run-console-clear" data-clear title="Limpar saída">Limpar</button>
        </div>
      </header>
      <div class="run-console-body">
        <label class="run-console-label" for="run-console-command">Comando</label>
        <textarea id="run-console-command" class="run-console-input" spellcheck="false"
          rows="2" placeholder="ex.: npm run build"></textarea>
        <pre class="run-console-output" data-output></pre>
      </div>`;

    this.titleEl = root.querySelector('.run-console-title')!;
    this.statusEl = root.querySelector('[data-status]')!;
    this.inputEl = root.querySelector<HTMLTextAreaElement>('.run-console-input')!;
    this.outputEl = root.querySelector('[data-output]')!;
    this.runBtn = root.querySelector<HTMLButtonElement>('[data-run]')!;
    this.cancelBtn = root.querySelector<HTMLButtonElement>('[data-cancel]')!;

    this.runBtn.addEventListener('click', () => void this.runCurrent());
    this.cancelBtn.addEventListener('click', () => void this.cancelCurrent());
    root.querySelector<HTMLButtonElement>('[data-clear]')!.addEventListener('click', () => {
      const run = this.currentRun();
      if (!run) return;
      run.lines = [];
      this.paintOutput(run);
    });

    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.runCurrent();
      }
    });
    this.inputEl.addEventListener('input', () => {
      if (!this.currentId) return;
      const node = this.currentNode();
      if (!node) return;
      setNodeCommand(this.deps.store, node.id, this.inputEl.value, this.typedSinceFocus);
      this.typedSinceFocus = true;
    });
    this.inputEl.addEventListener('focus', () => {
      this.typedSinceFocus = false;
    });
  }

  /**
   * Espelha a seleção: o painel só existe para nós terminal, então trocar de
   * seleção fecha/abre em vez de ficar ocupando espaço com conteúdo obsoleto.
   */
  sync(node: Node | null): void {
    const terminal = node?.kind === 'terminal' ? node : null;

    if (!terminal) {
      this.root.hidden = true;
      this.currentId = null;
      return;
    }

    this.root.hidden = false;
    if (this.currentId !== terminal.id) {
      this.currentId = terminal.id;
      this.typedSinceFocus = false;
      if (!this.runs.has(terminal.id)) this.runs.set(terminal.id, newRunState());
      this.inputEl.value = terminal.command ?? '';
      this.titleEl.textContent = terminal.label;
      this.paintOutput(this.currentRun()!);
      this.paintStatus(this.currentRun()!);
    } else if (document.activeElement !== this.inputEl && this.inputEl.value !== (terminal.command ?? '')) {
      // o comando mudou por fora (undo, import, outline) e o campo não está em foco
      this.inputEl.value = terminal.command ?? '';
    }

    const run = this.currentRun()!;
    this.runBtn.disabled = run.status === 'running';
    this.cancelBtn.hidden = run.status !== 'running';
  }

  /** Esquece nós que saíram do diagrama (excluídos): nada de buffer órfão. */
  retain(nodeIds: ReadonlySet<string>): void {
    for (const [id, run] of [...this.runs]) {
      if (nodeIds.has(id)) continue;
      run.controller?.abort();
      this.runs.delete(id);
      if (this.currentId === id) this.currentId = null;
    }
  }

  async runCurrent(): Promise<void> {
    const node = this.currentNode();
    if (!node || node.kind !== 'terminal') return;
    const run = this.runs.get(node.id)!;
    if (run.status === 'running') return;

    const command = this.inputEl.value.trim();
    if (!command) {
      this.deps.onError('Informe um comando antes de executar');
      this.inputEl.focus();
      return;
    }

    run.lines = [{stream: 'command', text: `$ ${command}`}];
    run.status = 'running';
    run.startedAt = Date.now();
    run.controller = new AbortController();
    this.paintOutput(run);
    this.paintStatus(run);
    this.sync(node);

    const buffers = {stdout: new LineBuffer(), stderr: new LineBuffer()};

    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({command}),
        signal: run.controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response
          .json()
          .then((body: {error?: string}) => body.error)
          .catch(() => undefined);
        throw new Error(detail ?? `HTTP ${response.status}`);
      }

      for await (const event of this.readEvents(response.body, run.controller.signal)) {
        if (this.currentId !== node.id) continue; // painel trocou de nó no meio da execução
        this.handleEvent(run, event, buffers);
        this.paintOutput(run);
        this.paintStatus(run);
      }

      // `reader.cancel()` (abort) encerra o gerador sem lançar erro: sem esta
      // checagem, um cancelamento apareceria como execução bem-sucedida.
      if (run.controller?.signal.aborted) {
        throw new DOMException('execução cancelada', 'AbortError');
      }
      run.status = run.status === 'running' ? 'ok' : run.status;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        run.status = 'canceled';
        this.push(run, 'meta', 'execução cancelada');
      } else {
        run.status = 'error';
        this.push(run, 'meta', `falha ao executar: ${(error as Error).message}`);
        this.push(run, 'meta', 'o executor roda em `npm run api` (terminal separado) na porta 5178');
      }
    } finally {
      run.controller = null;
      run.runId = null;
      this.paintOutput(run);
      this.paintStatus(run);
      this.sync(node);
    }
  }

  private async cancelCurrent(): Promise<void> {
    const run = this.currentRun();
    if (!run?.runId || !run.controller) return;
    // avisa o servidor para que ele também derrube o processo, e aborta a
    // leitura do stream aqui no cliente
    void fetch(`/api/runs/${encodeURIComponent(run.runId)}/cancel`, {method: 'POST'}).catch(
      () => undefined,
    );
    run.controller.abort();
  }

  private currentNode(): Node | null {
    const {selection} = this.deps.store.get();
    if (selection?.type !== 'node') return null;
    return this.deps.store.activePage().nodes.find((node) => node.id === selection.id) ?? null;
  }

  private currentRun(): RunState | null {
    return this.currentId ? (this.runs.get(this.currentId) ?? null) : null;
  }

  private push(run: RunState, stream: Line['stream'], text: string): void {
    for (const line of text.split('\n')) run.lines.push({stream, text: line});
  }

  /** Lê o corpo NDJSON: um evento por linha, decodificado incrementalmente. */
  private async *readEvents(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>, void, void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    const abort = () => void reader.cancel();
    signal.addEventListener('abort', abort, {once: true});

    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        pending += decoder.decode(value, {stream: true});
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          yield JSON.parse(line) as Record<string, unknown>;
        }
      }
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }

  private handleEvent(
    run: RunState,
    event: Record<string, unknown>,
    buffers: {stdout: LineBuffer; stderr: LineBuffer},
  ): void {
    switch (event.type) {
      case 'start':
        run.runId = String(event.runId ?? '');
        return;
      case 'stdout':
        for (const line of buffers.stdout.push(String(event.data ?? ''))) {
          this.push(run, 'stdout', line);
        }
        return;
      case 'stderr':
        for (const line of buffers.stderr.push(String(event.data ?? ''))) {
          this.push(run, 'stderr', line);
        }
        return;
      case 'limit':
        this.push(run, 'meta', `saída truncada em ${event.maxOutputBytes} bytes — processo encerrado`);
        return;
      case 'exit': {
        const tail = {stdout: buffers.stdout.flush(), stderr: buffers.stderr.flush()};
        if (tail.stdout !== null) this.push(run, 'stdout', tail.stdout);
        if (tail.stderr !== null) this.push(run, 'stderr', tail.stderr);
        const code = event.code;
        if (event.timedOut) {
          run.status = 'error';
          this.push(run, 'meta', `tempo esgotado após ${event.durationMs} ms`);
        } else if (code === 0) {
          run.status = 'ok';
          this.push(run, 'meta', `exit 0 · ${event.durationMs} ms`);
        } else {
          run.status = 'error';
          this.push(run, 'meta', `exit ${code ?? event.signal ?? '?'} · ${event.durationMs} ms`);
        }
        return;
      }
    }
  }

  private paintOutput(run: RunState): void {
    const atBottom =
      this.outputEl.scrollHeight - this.outputEl.scrollTop - this.outputEl.clientHeight < 40;

    // Linhas são spans inline separados por "\n" (o <pre> preserva a quebra): o
    // texto copiado do console sai com as quebras reais, em vez de colado.
    const children: ChildNode[] = [];
    run.lines.forEach((line, index) => {
      if (index > 0) children.push(document.createTextNode('\n'));
      const span = document.createElement('span');
      span.className = `run-console-line is-${line.stream}`;
      span.textContent = line.text || ' ';
      children.push(span);
    });
    this.outputEl.replaceChildren(...children);

    if (atBottom) this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private paintStatus(run: RunState): void {
    window.clearInterval(this.statusTimer);
    if (run.status === 'running') {
      const tick = () => {
        const seconds = Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
        this.statusEl.textContent = `${STATUS_LABEL.running} ${seconds}s`;
      };
      tick();
      this.statusTimer = window.setInterval(tick, 1000);
      return;
    }
    this.statusEl.textContent = STATUS_LABEL[run.status];
    this.statusEl.dataset.status = run.status;
  }
}