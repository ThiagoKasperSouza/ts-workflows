/**
 * Executor de comandos dos nós "terminal" do fluxograma.
 *
 * O front-end é um SPA e não tem acesso ao shell, então este processo é quem
 * executa os comandos: recebe POST /api/run com um comando, roda via
 * child_process e devolve stdout/stderr em NDJSON, linha a linha, enquanto o
 * processo ainda está vivo.
 *
 * ATENÇÃO — isto roda com as permissões do seu usuário, sem sandbox. Por isso
 * o servidor só escuta em 127.0.0.1 e o `cwd` de qualquer execução é
 * confinado dentro de WORKFLOW_ROOT. Para isolar de verdade, mova este
 * processo para um container (ver docker-compose.yml).
 */

import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 5178);
const HOST = process.env.HOST ?? '127.0.0.1';
/** Raiz do workspace: nenhum comando pode escapar daqui via `cwd`. */
const ROOT = path.resolve(process.env.WORKFLOW_ROOT ?? path.join(HERE, '..'));
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 262_144);
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS ?? 30_000);
const MAX_TIMEOUT_MS = Number(process.env.MAX_TIMEOUT_MS ?? 600_000);
const MAX_INPUT_BYTES = Number(process.env.MAX_INPUT_BYTES ?? 64 * 1024);
const MAX_BODY_BYTES = 64 * 1024;

/** Execuções vivas, para permitir cancelamento. */
const running = new Map();
let runSeq = 0;

const nextRunId = () => `run_${Date.now().toString(36)}_${(runSeq += 1).toString(36)}`;

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Corpo da requisição muito grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Resolve um diretório relativo ao workspace. Qualquer tentativa de escapar da
 * raiz (via `..` ou caminho absoluto) é rejeitada em vez de silenciosamente
 * normalizada para fora do workspace.
 */
function resolveCwd(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return ROOT;
  const target = path.resolve(ROOT, raw);
  const inside = target === ROOT || target.startsWith(ROOT + path.sep);
  if (!inside) throw new Error('`cwd` precisa estar dentro do workspace');
  return target;
}

const clampTimeout = (raw) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, value));
};

/**
 * Monta o script do comando.
 *
 * `exports` são os nomes de variáveis que o nó quer expor ao fluxo (ex.:
 * `IDADE`, digitada por `read`). Elas são lidas **no mesmo shell**, logo depois
 * do comando, e enviadas por um pipe exclusivo (fd 3) — não pelo stdout, para
 * não se misturarem com o log do terminal nem precisarem de filtragem no meio do
 * stream. Os valores vão em base64 porque podem conter qualquer byte (quebra de
 * linha, espaço, aspas).
 */
function buildScript(command, exports) {
  const names = exports.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (names.length === 0) return command;

  const lines = [
    '{',
    "  printf '%s\\n' '__WF_VARS__' >&3",
    // `${NOME-}` é written com escape porque, em template literal do JS, `${`
    // abriria interpolação. Sem `eval` não há expansão indireta em sh POSIX.
    ...names.map(
      (name) =>
        '  eval "__wf_val=\\${' +
        name +
        '-}"\n' +
        "  printf '%s\\t%s\\n' '" +
        name +
        "' \"$(printf '%s' \"$__wf_val\" | base64 | tr -d '\\n')\" >&3",
    ),
    "  printf '%s\\n' '__WF_END__' >&3",
    '}',
  ];

  return `${command}
__wf_rc=$?
${lines.join('\n')} >&3
exit $__wf_rc`;
}

/** Lê o dump de variáveis do fd 3 e resolve as linhas `NOME<TAB>base64`. */
function createVarReader(onVars) {
  let buffer = '';
  let collecting = false;
  const vars = {};
  const decode = (line) => {
    const tab = line.indexOf('\t');
    if (tab === -1) return;
    vars[line.slice(0, tab)] = Buffer.from(line.slice(tab + 1), 'base64').toString('utf8');
  };

  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      // `collecting` é estado do reader, não do chunk: o dump chega picotado e
      // o marcador `__WF_VARS__` quase nunca vem na mesma leitura do valor.
      for (const line of lines) {
        if (line === '__WF_VARS__') {
          collecting = true;
          continue;
        }
        if (line === '__WF_END__') {
          collecting = false;
          onVars({...vars});
          continue;
        }
        if (collecting) decode(line);
      }
    },
    flush() {
      if (buffer.trim()) decode(buffer);
    },
  };
}

/**
 * POST /api/run -> NDJSON.
 * Cada linha é um evento: start, stdout, stderr, exit (sempre o último).
 */
async function handleRun(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, 400, {error: error.message});
    return;
  }

  const command = typeof payload.command === 'string' ? payload.command.trim() : '';
  if (!command) {
    sendJson(res, 400, {error: 'Informe um comando para executar'});
    return;
  }

  let cwd;
  try {
    cwd = resolveCwd(payload.cwd);
  } catch (error) {
    sendJson(res, 400, {error: error.message});
    return;
  }

  const timeoutMs = clampTimeout(payload.timeoutMs);
  const exports = Array.isArray(payload.exports)
    ? payload.exports.filter((name) => typeof name === 'string').slice(0, 16)
    : [];
  const runId = nextRunId();

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });

  const emit = (event) => {
    // O cliente pode ter desconectado (fechou o painel, cancelou): escrever
    // depois disso geraria erro de stream destruído no log do processo.
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  const startedAt = Date.now();
  emit({type: 'start', runId, command, cwd, timeoutMs, input: true, exports});

  // `shell: true` faz o comando rodar dentro de um `sh -c`: sinalizar o shell
  // NÃO mata o processo real (o `sleep 30` continua, segurando o pipe). Com
  // `detached` o filho vira líder de grupo e o sinal chega na árvore toda.
  const useGroup = process.platform !== 'win32';
  const child = spawn(buildScript(command, exports), {
    shell: true,
    detached: useGroup,
    cwd,
    env: {...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0'},
    // stdin vira pipe (para `read` esperar o usuário) e o fd 3 leva o dump de
    // variáveis, separado do stdout do usuário.
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });

  const signalTree = (signal) => {
    if (useGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // grupo já foi embora: cai no kill direto
      }
    }
    child.kill(signal);
  };

  const state = {
    child,
    signalTree,
    bytes: 0,
    truncated: false,
    limited: false,
    timedOut: false,
    finished: false,
    vars: {},
    /** Injetado logo após o spawn: escreve no stdin do processo. */
    writeInput: null,
    timer: null,
    escalations: [],
  };
  running.set(runId, state);

  const kill = (reason) => {
    if (state.finished) return;
    if (reason === 'timeout') state.timedOut = true;
    signalTree('SIGTERM');
    // Um processo que ignora o SIGTERM não pode segurar a conexão para sempre:
    // SIGKILL no grupo e, em último caso, fecha a resposta de qualquer forma.
    state.escalations.push(
      setTimeout(() => {
        if (state.finished) return;
        signalTree('SIGKILL');
      }, 2_000).unref?.(),
    );
    state.escalations.push(
      setTimeout(() => {
        if (state.finished) return;
        emit({
          type: 'exit',
          runId,
          code: null,
          signal: 'SIGKILL',
          durationMs: Date.now() - startedAt,
          truncated: state.truncated,
          timedOut: state.timedOut,
          unresponsive: true,
        });
        finish(null, 'SIGKILL');
      }, 4_000).unref?.(),
    );
  };

  state.timer = setTimeout(() => kill('timeout'), timeoutMs);
  state.timer.unref?.();

  const streamOf = (stream, name) => {
    stream.setEncoding('utf8');
    stream.on('data', (data) => {
      // `limited` é irreversível: depois do teto o stream é pausado, mas um
      // chunk já enfileirado pode ainda chegar — sem esta guarda o evento
      // `limit` seria reemitido indefinidamente.
      if (state.finished || state.limited) return;
      const room = MAX_OUTPUT_BYTES - state.bytes;
      if (data.length >= room) {
        state.limited = true;
        state.truncated = true;
        state.bytes = MAX_OUTPUT_BYTES;
        emit({type: name, data: data.slice(0, Math.max(0, room))});
        emit({type: 'limit', reason: 'output', maxOutputBytes: MAX_OUTPUT_BYTES});
        child.stdout.pause();
        child.stderr.pause();
        kill('output');
        return;
      }
      state.bytes += data.length;
      emit({type: name, data});
    });
  };

  streamOf(child.stdout, 'stdout');
  streamOf(child.stderr, 'stderr');

  // stdin: o `read` do comando fica esperando o que o usuário digitar na janela.
  // Escrever num processo que já morreu levanta EPIPE; isso é normal no fim de
  // um comando interativo, não um erro a propagar.
  child.stdin.on('error', () => undefined);
  state.writeInput = (data) => {
    if (state.finished || child.stdin.destroyed) return false;
    child.stdin.write(data);
    return true;
  };

  const varReader = createVarReader((vars) => {
    state.vars = vars;
  });
  child.stdio[3]?.setEncoding('utf8');
  child.stdio[3]?.on('data', (chunk) => varReader.push(chunk));

  const finish = (code, signal) => {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.timer);
    for (const timer of state.escalations) clearTimeout(timer);
    child.stdin.end();
    varReader.flush();
    running.delete(runId);
    emit({
      type: 'exit',
      runId,
      code,
      signal,
      durationMs: Date.now() - startedAt,
      truncated: state.truncated,
      timedOut: state.timedOut,
      vars: state.vars,
    });
    res.end();
  };

  child.on('close', (code, signal) => finish(code, signal));

  // `error` (ex.: comando inexistente) chega depois de `finish` existir: o
  // handler é registrado aqui, mas só roda no próximo tick.
  child.on('error', (error) => {
    if (state.finished) return;
    emit({type: 'stderr', data: `${error.message}\n`});
    finish(null, null);
  });
}

/** POST /api/runs/:id/cancel */
function handleCancel(res, runId) {
  const state = running.get(runId);
  if (!state) {
    sendJson(res, 404, {error: 'Execução não encontrada ou já terminou'});
    return;
  }
  state.signalTree('SIGTERM');
  sendJson(res, 200, {ok: true, runId});
}

/** POST /api/runs/:id/input — escreve no stdin (o que o `read` está esperando). */
async function handleInput(req, res, runId) {
  const state = running.get(runId);
  if (!state || state.finished) {
    sendJson(res, 404, {error: 'Execução não encontrada ou já terminou'});
    return;
  }
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, 400, {error: error.message});
    return;
  }
  const data = typeof payload.data === 'string' ? payload.data : '';
  if (!data) {
    sendJson(res, 400, {error: 'Informe o texto de entrada'});
    return;
  }
  if (data.length > MAX_INPUT_BYTES) {
    sendJson(res, 413, {error: 'Entrada grande demais'});
    return;
  }
  const written = state.writeInput?.(data) ?? false;
  sendJson(res, written ? 200 : 409, written ? {ok: true, runId} : {error: 'Processo não está mais lendo'});
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      root: ROOT,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      running: running.size,
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/run') {
    handleRun(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, {error: error.message});
      else res.end();
    });
    return;
  }

  const cancel = path.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
  if (req.method === 'POST' && cancel) {
    handleCancel(res, cancel[1]);
    return;
  }

  const input = path.match(/^\/api\/runs\/([\w-]+)\/input$/);
  if (req.method === 'POST' && input) {
    handleInput(req, res, input[1]).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, {error: error.message});
      else res.end();
    });
    return;
  }

  sendJson(res, 404, {error: 'Rota não encontrada'});
});

server.listen(PORT, HOST, () => {
  console.log(`executor de workflows em http://${HOST}:${PORT}`);
  console.log(`workspace: ${ROOT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const state of running.values()) state.child.kill('SIGTERM');
    server.close(() => process.exit(0));
  });
}