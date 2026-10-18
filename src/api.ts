/**
 * Cliente do executor de comandos (`/api/run`).
 *
 * Separado da UI porque dois lugares consomem exatamente o mesmo stream: o
 * painel de um nó terminal e o motor de workflow. A leitura do corpo NDJSON é
 * feita aqui para que os dois tratem buffer de linha, cancelamento e erro de
 * conexão do mesmo jeito.
 */

export interface RunHandle {
  runId: string;
}

export type RunEvent =
  | {
      type: 'start';
      runId: string;
      command: string;
      cwd: string;
      timeoutMs: number;
      /** `true` quando o processo tem stdin — o `read` do comando fica esperando. */
      input: boolean;
      exports: string[];
    }
  | {type: 'stdout'; data: string}
  | {type: 'stderr'; data: string}
  | {type: 'limit'; reason: string; maxOutputBytes: number}
  | {
      type: 'exit';
      code: number | null;
      signal: string | null;
      durationMs: number;
      truncated: boolean;
      timedOut: boolean;
      /** Variáveis que o nó pediu para expor, já coletadas pelo executor. */
      vars: Record<string, string>;
    };

export interface RunOptions {
  /** Nomes de variáveis do shell a expor ao fluxo (ex.: `IDADE`). */
  exports?: readonly string[];
}

/** Erro de conexão com o executor — quase sempre "o processo não está rodando". */
export class ExecutorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorUnavailableError';
  }
}

const HINT =
  'o executor roda em `npm run api` (porta 5178) ou `docker compose up executor`';

async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // Falha de rede aqui quase sempre significa "o executor não está rodando",
    // e a mensagem crua do browser ("Failed to fetch") não ajuda ninguém.
    throw new ExecutorUnavailableError(`${(error as Error).message} — ${HINT}`);
  }
}

/**
 * Executa `command` e entrega cada evento assim que chega. Devolve o código de
 * saída final; o texto do comando já foi consumido por quem chamou.
 */
export async function streamRun(
  command: string,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
  options: RunOptions = {},
): Promise<{
  code: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  vars: Record<string, string>;
}> {
  const response = await postJson('/api/run', {command, exports: options.exports ?? []}, signal);

  if (!response.ok || !response.body) {
    const detail = await response
      .json()
      .then((body: {error?: string}) => body.error)
      .catch(() => undefined);
    throw new ExecutorUnavailableError(detail ?? `HTTP ${response.status}`);
  }

  let result = {
    code: null as number | null,
    signal: null as string | null,
    durationMs: 0,
    timedOut: false,
    vars: {} as Record<string, string>,
  };

  for await (const event of readNdjson(response.body, signal)) {
    onEvent(event as RunEvent);
    if (event.type === 'exit') {
      const exit = event as Extract<RunEvent, {type: 'exit'}>;
      result = {
        code: exit.code,
        signal: exit.signal,
        durationMs: exit.durationMs,
        timedOut: exit.timedOut,
        vars: exit.vars ?? {},
      };
    }
  }

  // `reader.cancel()` (abort) encerra o gerador sem lançar: sem esta checagem
  // um cancelamento apareceria como execução bem-sucedida.
  if (signal?.aborted) throw new DOMException('execução cancelada', 'AbortError');

  return result;
}

/** Lê um corpo NDJSON: um evento JSON por linha, decodificado incrementalmente. */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  const abort = () => void reader.cancel();
  signal?.addEventListener('abort', abort, {once: true});

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
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** Faz o servidor derrubar a execução; o cliente também aborta a leitura. */
export async function cancelRun(runId: string): Promise<void> {
  await postJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {}).catch(() => undefined);
}

/**
 * Envia o que o usuário digitou para o `read` que está esperando.
 *
 * `data` vai crua: quem decide se há `\n` no fim é a janela de terminal (Enter
 * envia uma linha), não esta camada.
 */
export async function sendInput(runId: string, data: string): Promise<string | null> {
  try {
    const response = await postJson(`/api/runs/${encodeURIComponent(runId)}/input`, {data});
    if (!response.ok) {
      const detail = await response
        .json()
        .then((body: {error?: string}) => body.error)
        .catch(() => undefined);
      return detail ?? `HTTP ${response.status}`;
    }
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}