import {setNodeCommand, setNodeExposes} from './commands';
import {lastStepOf, nodeWindowKey, type ExecutionEngine, type NodeRunState} from './execution';
import type {Store} from './store';
import type {Node} from './types';

/**
 * Painel do nó terminal selecionado: edita o comando, mostra o estado da última
 * execução e dispara/cancela a execução.
 *
 * A saída em si não aparece aqui — ela vive na janela separada do terminal
 * (`terminal-window.ts`). O que fica no painel é o *controle*, não o log.
 */

const STATE_LABEL: Record<NodeRunState, string> = {
  idle: 'Pronto',
  running: 'Executando…',
  ok: 'Concluído',
  error: 'Falhou',
  canceled: 'Cancelado',
  skipped: 'Pulado',
};

export class NodeInspector {
  private readonly titleEl: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly exposesEl: HTMLInputElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly outputWrap: HTMLElement;
  private readonly outputEl: HTMLElement;
  private readonly answerForm: HTMLFormElement;
  private readonly answerInput: HTMLInputElement;
  private readonly answerTarget: HTMLElement;
  private readonly fieldsEl: HTMLElement;

  private currentId: string | null = null;
  /** No modo de execução o painel só informa: nada de editar comando aqui. */
  private editable = true;
  /** Primeira tecla desde o foco: só ela cria o ponto de undo. */
  private typedSinceFocus = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: {
      store: Store;
      engine: ExecutionEngine;
      onError: (message: string) => void;
    },
  ) {
    root.className = 'node-inspector';
    root.innerHTML = `
      <div class="node-inspector-head">
        <span class="node-inspector-title"></span>
        <span class="node-inspector-state" data-state></span>
        <span class="node-inspector-detail" data-detail></span>
        <div class="node-inspector-actions">
          <button type="button" class="is-run" data-run>Executar <kbd>Ctrl+Enter</kbd></button>
          <button type="button" class="is-cancel" data-cancel>Cancelar</button>
          <button type="button" class="is-window" data-window title="Reabrir a janela do terminal">Janela</button>
        </div>
      </div>
      <div class="is-fields">
        <div class="is-field">
          <label class="is-label" for="node-inspector-command">Comando executado por este nó</label>
          <textarea id="node-inspector-command" class="is-input" spellcheck="false" rows="2"
            placeholder="ex.: npm run build"></textarea>
        </div>
        <div class="is-field is-narrow">
          <label class="is-label" for="node-inspector-exposes">Variáveis expostas</label>
          <input id="node-inspector-exposes" class="is-input is-exposes" spellcheck="false"
            placeholder="ex.: IDADE" />
          <p class="is-help">Viram <code>NOME</code> na condição e em <code>$NOME</code> nos próximos comandos</p>
        </div>
      </div>
      <form class="is-answer" data-answer hidden>
        <label class="is-label" for="node-inspector-answer">Resposta para o comando em execução</label>
        <div class="is-answer-row">
          <span class="is-answer-target" data-answer-target></span>
          <input id="node-inspector-answer" class="is-input is-answer-input" autocomplete="off"
            spellcheck="false" placeholder="digite e aperte Enter" />
          <button type="submit" class="is-answer-send">Enviar</button>
        </div>
      </form>
      <details class="is-output-wrap" data-output-wrap hidden>
        <summary>Saída do terminal<span class="is-output-hint"> (a janela aberta mostra o log completo)</span></summary>
        <pre class="is-output" data-output></pre>
      </details>`;

    this.titleEl = root.querySelector('.node-inspector-title')!;
    this.stateEl = root.querySelector('[data-state]')!;
    this.detailEl = root.querySelector('[data-detail]')!;
    this.inputEl = root.querySelector<HTMLTextAreaElement>('#node-inspector-command')!;
    this.exposesEl = root.querySelector<HTMLInputElement>('#node-inspector-exposes')!;
    this.runBtn = root.querySelector<HTMLButtonElement>('[data-run]')!;
    this.cancelBtn = root.querySelector<HTMLButtonElement>('[data-cancel]')!;
    this.fieldsEl = root.querySelector<HTMLElement>('.is-fields')!;
    this.answerForm = root.querySelector<HTMLFormElement>('[data-answer]')!;
    this.answerInput = root.querySelector<HTMLInputElement>('#node-inspector-answer')!;
    this.answerTarget = root.querySelector<HTMLElement>('[data-answer-target]')!;
    this.outputWrap = root.querySelector<HTMLElement>('[data-output-wrap]')!;
    this.outputEl = root.querySelector<HTMLElement>('[data-output]')!;

    this.runBtn.addEventListener('click', () => void this.run());
    this.cancelBtn.addEventListener('click', () => void this.deps.engine.cancel());
    // Caminho de entrada sem popup: responder aqui funciona mesmo com a janela
    // bloqueada, e é o mesmo `answer` que a janela usa.
    const send = () => {
      const value = this.answerInput.value;
      this.answerInput.value = '';
      void this.deps.engine.answer(value);
    };
    this.answerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      send();
    });
    // Enter é tratado aqui, e não pela submissão implícita do form: nos testes
    // ela simplesmente não acontecia, e o campo ficava preenchido como se o
    // comando tivesse ignorado a resposta.
    this.answerInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      send();
    });
    root.querySelector<HTMLButtonElement>('[data-window]')!.addEventListener('click', () => {
      const node = this.currentNode();
      // Precisa ser síncrono: abrir depois de um await vira popup bloqueado.
      if (!node) return;
      this.deps.engine.reopenTerminal(node.id);
    });

    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.run();
      }
    });
    this.inputEl.addEventListener('input', () => {
      const node = this.currentNode();
      if (!node || !this.editable) return;
      setNodeCommand(this.deps.store, node.id, this.inputEl.value, this.typedSinceFocus);
      this.typedSinceFocus = true;
    });
    this.inputEl.addEventListener('focus', () => {
      this.typedSinceFocus = false;
    });
    this.exposesEl.addEventListener('input', () => {
      const node = this.currentNode();
      if (!node || !this.editable) return;
      setNodeExposes(this.deps.store, node.id, this.exposesEl.value);
    });
  }

  private currentNode(): Node | null {
    const {selection} = this.deps.store.get();
    if (selection?.type !== 'node') return null;
    return this.deps.store.activePage().nodes.find((node) => node.id === selection.id) ?? null;
  }

  /** Modo de execução: o comando sai de edição, mas continua visível. */
  setInteractive(on: boolean): void {
    if (this.editable === on) return;
    this.editable = on;
    this.inputEl.readOnly = !on;
    this.exposesEl.readOnly = !on;
    // `locked` é o oposto de `editable`: o CSS trava a leitura quando true.
    this.root.dataset.locked = on ? 'false' : 'true';
    this.paintState();
  }

  /**
   * Espelha a seleção. O painel existe para nós terminal — mas, se um comando
   * estiver rodando e esperando resposta, ele também aparece (com o nó em
   * execução no lugar de um terminal selecionado), porque é a única forma de
   * responder quando a janela separada está bloqueada.
   */
  sync(node: Node | null): void {
    const running = this.deps.engine.runningNode();
    const terminal = node?.kind === 'terminal' ? node : null;
    if (!terminal && !running) {
      this.root.hidden = true;
      this.currentId = null;
      return;
    }

    this.root.hidden = false;
    const shown = terminal ?? running!;
    this.currentId = shown.id;
    this.titleEl.textContent = shown.label;

    this.root.dataset.kind = shown.kind;
    this.fieldsEl.hidden = shown.kind !== 'terminal';
    this.answerForm.hidden = running === null;

    if (terminal && document.activeElement !== this.inputEl) {
      const command = terminal.command ?? '';
      if (this.inputEl.value !== command) {
        this.inputEl.value = command;
        this.typedSinceFocus = false;
      }
      if (document.activeElement !== this.exposesEl) {
        const exposes = (terminal.exposes ?? []).join(', ');
        if (this.exposesEl.value !== exposes) this.exposesEl.value = exposes;
      }
    }

    this.paintState();
  }

  /** Chamado a cada evento do motor, para manter estado/detalhe/buttons vivos. */
  paintState(): void {
    if (this.root.hidden || !this.currentId) return;

    const engine = this.deps.engine;
    const state = engine.nodeState(this.currentId);
    this.stateEl.textContent = STATE_LABEL[state];
    this.stateEl.dataset.state = state;

    const step = lastStepOf(engine, this.currentId);
    this.detailEl.textContent = step ? step.detail : '';

    // quem está esperando resposta (pode ser outro nó, não o selecionado)
    const waiting = engine.runningNode();
    this.answerForm.hidden = waiting === null || this.root.hidden;
    this.answerTarget.textContent = waiting ? `${waiting.label} espera:` : '';

    const busy = state === 'running';
    this.runBtn.hidden = !this.editable;
    this.runBtn.disabled = busy || engine.isRunning();
    this.cancelBtn.hidden = !busy;

    this.paintOutput();
  }

  /**
   * Fallback da janela separada: com o popup bloqueado (ou fechado), a saída
   * continua visível aqui — as últimas linhas do buffer do terminal.
   */
  private paintOutput(): void {
    if (!this.currentId) return;
    const lines = this.deps.engine.tailOf(this.currentId, 30);
    this.outputWrap.hidden = lines.length === 0;
    if (lines.length === 0) {
      this.outputEl.replaceChildren();
      return;
    }

    // Como no <pre> da janela: spans inline separados por "\n".
    const children: ChildNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) children.push(document.createTextNode('\n'));
      const span = document.createElement('span');
      span.className = `run-console-line is-${line.stream}`;
      span.textContent = line.text || ' ';
      children.push(span);
    });
    this.outputEl.replaceChildren(...children);
  }

  private async run(): Promise<void> {
    const node = this.currentNode();
    if (!node) return;
    if (!(node.command ?? '').trim()) {
      this.deps.onError('Informe um comando antes de executar');
      this.inputEl.focus();
      return;
    }
    try {
      await this.deps.engine.runNode(node.id);
    } catch (error) {
      this.deps.onError((error as Error).message);
    }
  }

  /** Chave da janela deste nó — usada pelo botão "Janela". */
  windowKey(): string | null {
    return this.currentId ? nodeWindowKey(this.currentId) : null;
  }
}