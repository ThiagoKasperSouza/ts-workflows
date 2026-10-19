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
      /** Variáveis do ambiente injetadas neste comando. */
      env: string[];
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
  /**
   * Variáveis de passos anteriores, entregues como **ambiente** do shell — o
   * comando usa `$NOME` normalmente. Não é interpolação de texto: o valor entra
   * como dado, então nada do que o modelo ou o usuário digitou vira comando.
   */
  env?: Readonly<Record<string, string>>;
}

/** Como a execução terminou, mesmo que o stream tenha morrido no caminho. */
export interface RunResult {
  code: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  vars: Record<string, string>;
  /** `true` quando o stream quebrou e o resultado veio do executor. */
  recovered: boolean;
}

interface RunState {
  runId: string;
  status: 'running' | 'finished';
  command: string;
  /** Só quando `finished`. */
  code?: number | null;
  signal?: string | null;
  durationMs?: number;
  timedOut?: boolean;
  vars?: Record<string, string>;
  finishedAt?: number;
}

/**
 * Consulta o resultado de uma execução que já terminou.
 *
 * É o que salva o fluxo quando a conexão morre depois do comando ter rodado: sem
 * isto, derrubar um container e perder a resposta faria o fluxo reportar falha
 * sobre algo que deu certo — e, pior, o passo following não aconteceria.
 */
async function fetchRunState(runId: string): Promise<RunState | null> {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) return null;
    return (await response.json()) as RunState;
  } catch {
    return null;
  }
}

/**
 * Aguarda o fim de uma execução consultando o executor.
 *
 * Perguntar uma vez só não resolve: quando o stream morre, o comando quase
 * sempre ainda está rodando. Aqui o cliente insiste até o executor responder que
 * acabou — ou até o prazo do comando estourar.
 */
export async function waitForRunState(runId: string, budgetMs = 120_000): Promise<RunState | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const state = await fetchRunState(runId);
    if (!state) return null; // o executor não conhece: reiniciou
    if (state.status === 'finished') return state;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
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
): Promise<RunResult> {
  const response = await postJson(
    '/api/run',
    {command, exports: options.exports ?? [], env: options.env ?? {}},
    signal,
  );

  if (!response.ok || !response.body) {
    const detail = await response
      .json()
      .then((body: {error?: string}) => body.error)
      .catch(() => undefined);
    throw new ExecutorUnavailableError(detail ?? `HTTP ${response.status}`);
  }

  let result: RunResult = {
    code: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    vars: {},
    recovered: false,
  };
  let runId = '';
  let streamBroken = false;

  try {
    for await (const event of readNdjson(response.body, signal)) {
      onEvent(event as RunEvent);
      if (event.type === 'start') runId = String(event.runId ?? '');
      if (event.type === 'exit') {
        const exit = event as Extract<RunEvent, {type: 'exit'}>;
        result = {
          code: exit.code,
          signal: exit.signal,
          durationMs: exit.durationMs,
          timedOut: exit.timedOut,
          vars: exit.vars ?? {},
          recovered: false,
        };
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // Stream morreu no meio. Antes de desistir, pergunta ao executor: o
    // comando provavelmente rodou, e sem isso a decisão seguinte receberia uma
    // falha que não existiu.
    streamBroken = true;
    const finished = runId ? await waitForRunState(runId) : null;
    if (!finished || finished.status !== 'finished') {
      throw new ExecutorUnavailableError(
        `a conexão com o executor quebrou no meio da execução (${(error as Error).message}). ` +
          'Se o executor foi reiniciado no meio do fluxo, este comando precisa ser executado de novo.',
      );
    }
    result = {
      code: finished.code ?? null,
      signal: finished.signal ?? null,
      durationMs: finished.durationMs ?? 0,
      timedOut: finished.timedOut ?? false,
      vars: finished.vars ?? {},
      recovered: true,
    };
  }

  // `reader.cancel()` (abort) encerra o gerador sem lançar: sem esta checagem
  // um cancelamento apareceria como execução bem-sucedida.
  if (signal?.aborted) throw new DOMException('execução cancelada', 'AbortError');

  if (!streamBroken && result.durationMs === 0 && !result.recovered) {
    // Stream terminou sem evento de saída e sem erro visível: trata como
    // quebra também, usando a mesma recuperação.
    const finished = runId ? await waitForRunState(runId) : null;
    if (finished?.status === 'finished') {
      result = {
        code: finished.code ?? null,
        signal: finished.signal ?? null,
        durationMs: finished.durationMs ?? 0,
        timedOut: finished.timedOut ?? false,
        vars: finished.vars ?? {},
        recovered: true,
      };
    }
  }

  return result;
}

/** Eventos do agente de IA (`POST /api/agent`). */
export type AgentEvent =
  | {type: 'agent'; event: 'turn'; n: number; max: number}
  | {type: 'agent'; event: 'thinking'; text: string}
  | {type: 'agent'; event: 'delta'; text: string}
  | {type: 'agent'; event: 'tool_call'; name: string; args: unknown}
  | {type: 'agent'; event: 'tool_result'; name: string; ms: number; chars: number; text: string}
  | {type: 'agent'; event: 'final'; text: string}
  | {type: 'agent'; event: 'notice'; text: string}
  | {type: 'start'; runId: string; command: string; cwd: string; timeoutMs: number; input: boolean; exports: string[]}
  | RunEvent;

export interface AgentRequest {
  prompt: string;
  model: string;
  /** Fonte preferida da busca: 'Wikipédia', 'Bing', 'Ollama cloud' ou null. */
  preferredSource?: string | null;
  /** Modelo que redige a resposta final (padrão: um modelo sem raciocínio). */
  writerModel?: string;
  tools: {type: string; config: Record<string, unknown>}[];
  maxIterations: number;
  numPredict: number;
  timeoutMs: number;
}

/**
 * Roda o agente com ferramentas e devolve o mesmo formato de `streamRun`, para
 * que o motor de workflow não saiba a diferença entre um comando e um agente.
 */
export async function streamAgent(
  request: AgentRequest,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<{
  code: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  vars: Record<string, string>;
  recovered: boolean;
}> {
  const response = await postJson('/api/agent', request, signal);
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
    recovered: false,
  };

  for await (const event of readNdjson(response.body, signal)) {
    onEvent(event as AgentEvent);
    if (event.type === 'exit') {
      const exit = event as Extract<RunEvent, {type: 'exit'}>;
      result = {
        code: exit.code,
        signal: exit.signal,
        durationMs: exit.durationMs,
        timedOut: exit.timedOut,
        vars: exit.vars ?? {},
        recovered: false,
      };
    }
  }

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