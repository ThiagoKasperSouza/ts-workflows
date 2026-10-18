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
  | {type: 'start'; runId: string; command: string; cwd: string; timeoutMs: number}
  | {type: 'stdout'; data: string}
  | {type: 'stderr'; data: string}
  | {type: 'limit'; reason: string; maxOutputBytes: number}
  | {type: 'exit'; code: number | null; signal: string | null; durationMs: number; truncated: boolean; timedOut: boolean};

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
    throw new ExecutorUnavailableError((error as Error).message);
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
): Promise<{code: number | null; signal: string | null; durationMs: number; timedOut: boolean}> {
  const response = await postJson('/api/run', {command}, signal);

  if (!response.ok || !response.body) {
    const detail = await response
      .json()
      .then((body: {error?: string}) => body.error)
      .catch(() => undefined);
    throw new ExecutorUnavailableError(detail ?? `HTTP ${response.status}`);
  }

  let result = {code: null as number | null, signal: null as string | null, durationMs: 0, timedOut: false};

  for await (const event of readNdjson(response.body, signal)) {
    onEvent(event as RunEvent);
    if (event.type === 'exit') {
      const exit = event as Extract<RunEvent, {type: 'exit'}>;
      result = {
        code: exit.code,
        signal: exit.signal,
        durationMs: exit.durationMs,
        timedOut: exit.timedOut,
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