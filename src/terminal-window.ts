import type {TerminalSink} from './execution';

/**
 * Terminal em janela separada.
 *
 * Cada execução (ou nó) tem uma `window.open` própria, identificada pelo nome —
 * reabrir com o mesmo nome devolve a janela existente, então "Executar" de novo
 * apenas refocus. A comunicação é por `postMessage`: a janela é um documento
 * escrito por nós, sem bundler, então o script dela é uma string mínima.
 *
 * Por que uma janela real e não um painel: o painel do editor mostra o desenho,
 * e a saída de um fluxo é longa e independente do que está selecionado.
 */

type Status = 'running' | 'ok' | 'error' | 'canceled';

interface OpenWindow {
  win: Window;
  lines: number;
}

export type LineStream = 'stdout' | 'stderr' | 'meta' | 'command';

export interface TerminalLine {
  stream: LineStream;
  text: string;
}

interface TerminalBuffer {
  title: string;
  lines: TerminalLine[];
  truncated: boolean;
}

/**
 * Saída guardada por chave. É o que permite reabrir uma janela — ou abrir
 * depois que o navegador bloqueou o popup — com o histórico inteiro, em vez de
 * uma tela vazia.
 */
const BUFFER_LIMIT = 1000;

const STATUS_COLOR: Record<Status, string> = {
  running: '#7dd3fc',
  ok: '#4ade80',
  error: '#f87171',
  canceled: '#fbbf24',
};

const OPENED = new Map<string, OpenWindow>();
const BUFFERS = new Map<string, TerminalBuffer>();

const bufferOf = (key: string, title: string): TerminalBuffer => {
  let buffer = BUFFERS.get(key);
  if (!buffer) {
    buffer = {title, lines: [], truncated: false};
    BUFFERS.set(key, buffer);
  }
  return buffer;
};

/**
 * Documento da janela: sem dependências, sem script externo. `postMessage`
 * recebe eventos da janela principal e os desenha.
 *
 * Exportado para poder ser testado isoladamente — o `window.open` é impossível
 * de exercitar num harness de browser sem popups.
 */
export function terminalWindowDocument(title: string, key: string): string {
  const shell = JSON.stringify(title);
  const keyLiteral = JSON.stringify(key);
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: #020617; color: #e2e8f0;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; background: #0f172a; border-bottom: 1px solid #1e293b;
  }
  h1 { flex: 1; margin: 0; font-size: 12px; font-weight: 600; color: #e2e8f0;
       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { font-size: 11px; color: #94a3b8; }
  .btn {
    border: 1px solid #334155; border-radius: 6px; background: #1e293b;
    color: #e2e8f0; font: inherit; font-size: 11px; padding: 3px 8px; cursor: pointer;
  }
  .btn:hover { background: #334155; }
  pre {
    flex: 1; margin: 0; padding: 10px 12px; overflow: auto; white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .is-stdout { color: #cbd5e1; }
  .is-stderr { color: #fca5a5; }
  .is-meta   { color: #64748b; }
  .is-command{ color: #7dd3fc; }

  .stdin {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-top: 1px solid #1e293b; background: #0f172a;
  }
  .stdin-caret { color: #64748b; font-weight: 700; }
  .stdin input {
    flex: 1; border: 1px solid #1e293b; border-radius: 6px;
    background: #020617; color: #e2e8f0; padding: 6px 8px; font: inherit;
  }
  .stdin input:focus { outline: none; border-color: #334155; }
  /* "aguardando entrada": a última saída não terminou em quebra de linha, o
     que é o sinal de que o comando parou para ler (sem PTY não há como saber
     com certeza, então é uma pista visual, não uma garantia). */
  .stdin[data-waiting='true'] { border-top-color: #7dd3fc; background: #0b1a2e; }
  .stdin[data-waiting='true'] .stdin-caret { color: #7dd3fc; animation: blink 1s steps(2) infinite; }
  .stdin[data-waiting='true'] input { border-color: #7dd3fc; }
  @keyframes blink { 50% { opacity: .3; } }
</style></head>
<body>
  <header>
    <h1 id="title"></h1>
    <span class="status" id="status"></span>
    <button class="btn" id="clear" type="button">Limpar</button>
    <button class="btn" id="close" type="button">Fechar</button>
  </header>
  <pre id="out"></pre>
  <form class="stdin" id="stdin" data-waiting="false">
    <span class="stdin-caret" aria-hidden="true">&gt;</span>
    <input id="input" autocomplete="off" spellcheck="false"
      placeholder="resposta para o comando (Enter envia)" />
  </form>
<script>
  const out = document.getElementById('out');
  const status = document.getElementById('status');
  const title = document.getElementById('title');
  const stdin = document.getElementById('stdin');
  const input = document.getElementById('input');
  const colors = ${JSON.stringify(STATUS_COLOR)};
  const KEY = ${keyLiteral};
  title.textContent = ${shell};

  let running = false;
  let pendingText = false; // última saída terminou sem quebra de linha?

  function setWaiting(waiting) {
    stdin.dataset.waiting = waiting ? 'true' : 'false';
    if (waiting) input.focus();
  }

  // Espans inline separadas por "\\n": o <pre> preserva a quebra e o texto
  // copiado sai com as linhas de verdade.
  function append(cls, text) {
    pendingText = !String(text).endsWith('\\n');
    setWaiting(running && pendingText);
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    if (out.childNodes.length) out.appendChild(document.createTextNode('\\n'));
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text || ' ';
    out.appendChild(span);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  function reset() { out.replaceChildren(); }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    switch (data.kind) {
      case 'title':
        title.textContent = data.title;
        document.title = data.title;
        break;
      case 'line':
        append('is-' + data.stream, data.text);
        break;
      case 'status':
        running = data.status === 'running';
        status.textContent = data.detail || '';
        status.style.color = colors[data.status] || '#94a3b8';
        if (!running) setWaiting(false);
        break;
      case 'clear':
        reset();
        pendingText = false;
        setWaiting(false);
        break;
    }
  });

  // Enter envia uma linha; o "\\n" é do protocolo de terminal, não do browser.
  stdin.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = '';
    window.parent.postMessage({kind: 'input', key: KEY, data: value + '\\n'}, '*');
    setWaiting(false);
  });

  document.getElementById('clear').addEventListener('click', reset);
  document.getElementById('close').addEventListener('click', () => window.close());
</script>
</body></html>`;
}

export class TerminalWindows implements TerminalSink {
  private readonly inputHandlers = new Map<string, (data: string) => void>();

  constructor() {
    // A janela do terminal não conhece o processo: ela manda o texto ao pai, e
    // este decide para qual execução ele vai (pode não ser mais a mesma, se o
    // passo já tiver terminado).
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as {kind?: string; key?: string; data?: string} | null;
      if (!data || data.kind !== 'input' || typeof data.key !== 'string') return;
      const handler = this.inputHandlers.get(data.key);
      if (handler) handler(String(data.data ?? ''));
    });
  }

  setInputHandler(key: string, handler: ((data: string) => void) | null): void {
    if (handler) this.inputHandlers.set(key, handler);
    else this.inputHandlers.delete(key);
  }

  /**
   * Abre (ou reutiliza) a janela. Devolve `false` quando o navegador bloqueou
   * o popup: a execução continua e a saída fica no buffer, aparece no painel do
   * nó e pode ser reaberta depois com o botão "Janela".
   */
  ensure(key: string, title: string): boolean {
    const buffer = bufferOf(key, title);
    buffer.title = title;
    const existing = this.live(key);
    if (existing) {
      existing.win.focus();
      this.post(existing, {kind: 'title', title});
      this.replay(existing, buffer);
      return true;
    }

    // Janelas empilhadas com deslocamento: abrir duas não as sobrepõe.
    const offset = (BUFFERS.size % 6) * 32;
    const spec = `popup=yes,width=760,height=460,left=${120 + offset},top=${100 + offset}`;
    const win = window.open('', key, spec);
    if (!win) return false;

    win.document.open();
    win.document.write(terminalWindowDocument(title, key));
    win.document.close();

    const record: OpenWindow = {win, lines: 0};
    OPENED.set(key, record);
    this.replay(record, buffer);
    return true;
  }

  private replay(record: OpenWindow, buffer: TerminalBuffer): void {
    if (buffer.truncated) {
      this.post(record, {
        kind: 'line',
        stream: 'meta',
        text: `(saída anterior truncada: últimas ${buffer.lines.length} linhas)`,
      });
    }
    for (const line of buffer.lines) {
      this.post(record, {kind: 'line', stream: line.stream, text: line.text});
    }
    record.lines = buffer.lines.length;
  }

  /** Últimas linhas de uma chave — é o que o painel do nó mostra. */
  lines(key: string, limit = 40): TerminalLine[] {
    const buffer = BUFFERS.get(key);
    if (!buffer) return [];
    return buffer.lines.slice(-limit);
  }

  line(key: string, stream: LineStream, text: string): void {
    // Chunks chegam com '\n' no fim e a janela separa as mensagens com '\n';
    // sem tirar o pedaço vazio final, toda linha renderizava em dobro.
    const pieces = String(text).split('\n');
    if (pieces[pieces.length - 1] === '') pieces.pop();
    if (pieces.length === 0) return;

    // O buffer vem primeiro: mesmo sem janela (popup bloqueado, ou fechada
    // depois), a saída precisa ficar disponível para o painel e para o replay.
    // `bufferOf` cria sob demanda — uma execução pode espelhar linhas numa
    // janela de nó que nunca foi aberta.
    const buffer = bufferOf(key, '');
    if (buffer) {
      for (const piece of pieces) {
        buffer.lines.push({stream, text: piece});
        if (buffer.lines.length > BUFFER_LIMIT) {
          buffer.lines.shift();
          buffer.truncated = true;
        }
      }
    }

    const record = this.live(key);
    if (!record) return;
    for (const piece of pieces) {
      this.post(record, {kind: 'line', stream, text: piece});
      record.lines += 1;
    }
  }

  status(key: string, status: Status, detail: string): void {
    const record = this.live(key);
    if (record) this.post(record, {kind: 'status', status, detail});
  }

  clear(key: string): void {
    const record = this.live(key);
    if (record) this.post(record, {kind: 'clear'});
  }

  close(key: string): void {
    const record = this.live(key);
    if (record) record.win.close();
    OPENED.delete(key);
  }

  isOpen(key: string): boolean {
    return this.live(key) !== null;
  }

  /** Remove as janelas mortas (o buffer de saída continua sobrevivendo). */
  prune(): void {
    for (const [key] of [...OPENED]) {
      if (!this.isOpen(key)) OPENED.delete(key);
    }
  }

  private live(key: string): OpenWindow | null {
    const record = OPENED.get(key);
    if (!record) return null;
    if (record.win.closed) {
      OPENED.delete(key);
      return null;
    }
    return record;
  }

  private post(record: OpenWindow, message: Record<string, unknown>): void {
    record.win.postMessage(message, '*');
  }
}