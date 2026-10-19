import {clampTimeout, nextRunId, readJson, ROOT, running, sendJson} from './index.mjs';
import {webSearch} from './search.mjs';

/**
 * Agente de IA com ferramentas (nó `ai` do fluxograma).
 *
 * Existe porque um agente é **dinâmico** e um fluxograma é **estático**: o modelo
 * decide quantas buscas fazer, e um diagrama não consegue reagir a "quero mais
 * uma busca". Fazer isso só com nós de terminal obrigaria a fixar a profundidade
 * do raciocínio e a manipular o JSON da conversa dentro do shell.
 *
 * Como funciona: o modelo recebe o *schema* das ferramentas; quando responde com
 * `tool_calls`, o executor executa a busca de verdade (HTTP), devolve o resultado
 * como mensagem de tool e repete. Para quando o modelo responde em texto ou
 * quando o teto de iterações acaba.
 *
 * Não é a busca embutida da Ollama (`{"type":"web_search"}`): aquela é executada
 * pelo servidor da Ollama contra a API hospedada da Ollama e exige
 * `OLLAMA_API_KEY`. Aqui a ferramenta é nossa, o que funciona sem chave nenhuma.
 */

/** Ferramentas disponíveis e como cada uma é implementada. */
const TOOLS = {
  buscar_web: {
    description: 'Busca páginas na web e devolve títulos com trechos do conteúdo. Use para fatos atuais, documentacao ou qualquer coisa que exija a internet.',
    parameters: {
      type: 'object',
      properties: {consulta: {type: 'string', description: 'termos a buscar na web'}},
      required: ['consulta'],
    },
  },
};

/** Busca padrão: API de busca da Wikipédia (sem chave, estável, JSON limpo). */
async function runWebSearch(args, config, signal) {
  const query = String(args.consulta ?? '').trim();
  if (!query) return 'Consulta vazia: informe os termos da busca.';

  const result = await webSearch(query, signal, config.preferredSource);
  // Prefixa a fonte para o modelo saber o que está lendo — e para o usuário
  // auditar de onde veio a resposta quando ela estiver errada.
  return `Fonte: ${result.source ?? 'nenhuma'}\n${result.result}`;
}

const RUNNERS = {buscar_web: runWebSearch};

/**
 * Último turno, **sem ferramentas e sem pensar**: o trabalho de planejar já foi
 * feito, sobrou só redigir. É o que transforma ~200s de raciocínio em ~20s.
 */
async function synthesize(ollama, model, messages, numPredict, signal) {
  const response = await fetch(`${ollama}/api/chat`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Você já tem toda a informação necessária. Escreva AGORA a resposta final para o usuário, ' +
            'no idioma dele. Não planeje, não chame ferramenta, não explique seu raciocínio.',
        },
        ...messages,
      ],
      stream: false,
      // qwen3 é um modelo de *thinking*: redigir também o faz raciocinar, e o
      // orçamento inteiro acaba antes da primeira frase. Quem redige é um modelo
      // sem raciocínio (gemma3), que responde em segundos.
      think: false,
      options: {num_predict: numPredict},
    }),
    signal,
  });
  if (!response.ok) return '';
  const body = await response.json();
  const answer = body?.message?.content ?? '';
  return answer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Teto de caracteres devolvidos por ferramenta: contexto do modelo é curto. */
const TOOL_OUTPUT_LIMIT = 6000;

/**
 * POST /api/agent -> NDJSON.
 *
 * Eventos: `agent` (turno, tool_call, tool_result, delta, final) e `exit`.
 */
export async function handleAgent(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, 400, {error: error.message});
    return;
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    sendJson(res, 400, {error: 'Informe o prompt do agente'});
    return;
  }

  const ollama = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const model = typeof payload.model === 'string' && payload.model ? payload.model : 'qwen3:4b';
  const enabled = Array.isArray(payload.tools) ? payload.tools : [];
  const preferredSource = typeof payload.preferredSource === 'string' && payload.preferredSource
    ? payload.preferredSource
    : null;
  const maxIterations = Math.min(8, Math.max(1, Number(payload.maxIterations) || 3));
  // Modelo que escreve a resposta final. Vazio = usa o mesmo do planejador.
  const writerModel =
    typeof payload.writerModel === 'string' && payload.writerModel
      ? payload.writerModel
      : process.env.OLLAMA_WRITER_MODEL || 'gemma3:4b';
  const timeoutMs = clampTimeout(payload.timeoutMs ?? 300_000);
  // qwen3 é modelo de *thinking*: antes de emitir a tool call ele gasta centenas
  // de tokens raciocinando. Com teto baixo o turno acaba sem resposta nenhuma —
  // foi exatamente o que aconteceu na primeira versão (900 tokens, nada).
  const numPredict = Math.min(8000, Math.max(256, Number(payload.numPredict) || 2000));

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });

  const runId = nextRunId();
  const emit = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  const startedAt = Date.now();
  emit({type: 'start', runId, command: `agente ${model}`, cwd: ROOT, timeoutMs, input: false, exports: []});

  // O agente não tem stdin, mas precisa ser cancelável como qualquer execução.
  const controller = new AbortController();
  const state = {
    child: null,
    signalTree: () => controller.abort(),
    writeInput: null,
    finished: false,
  };
  running.set(runId, state);
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  const tools = enabled
    .filter((tool) => tool && RUNNERS[tool.type])
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.type,
        description: TOOLS[tool.type].description,
        parameters: TOOLS[tool.type].parameters,
      },
    }));

  // Instrução de sistema: o qwen3 é um modelo de *thinking* e, depois de receber
  // o resultado da ferramenta, tends a raciocinar até acabar o orçamento de
  // tokens em vez de responder. Dizer isso explicitamente encurta o plano.
  const messages = [
    {
      role: 'system',
      content:
        'Você tem uma ferramenta chamada buscar_web. Quando o pedido envolver informação externa, atual ou que você não sabe, ' +
        'chame buscar_web (com os termos da pesquisa) ANTES de responder. Depois de receber o resultado, responda direto e de forma curta, ' +
        'sem raciocínio longo, usando o que a busca trouxe.',
    },
    {role: 'user', content: prompt},
  ];
  const used = [];
  let iterations = 0;
  let answer = '';

  try {
    if (tools.length === 0) {
      emit({type: 'agent', event: 'notice', text: 'Nenhuma ferramenta habilitada: o agente responde só do que sabe.'});
    }

    while (iterations < maxIterations) {
      if (controller.signal.aborted) throw new Error('execução cancelada');
      iterations += 1;
      emit({type: 'agent', event: 'turn', n: iterations, max: maxIterations});

      const chat = await fetch(`${ollama}/api/chat`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          options: {num_predict: numPredict},
        }),
        signal: controller.signal,
      });

      if (!chat.ok || !chat.body) {
        const detail = await chat.text().catch(() => '');
        throw new Error(`Ollama respondeu ${chat.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }

      // Consome o stream do modelo e reconstrói a mensagem final.
      const reader = chat.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let toolCalls = [];
      let content = '';

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        pending += decoder.decode(value, {stream: true});
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }
          const piece = chunk?.message?.content ?? '';
          if (piece) {
            content += piece;
            emit({type: 'agent', event: 'delta', text: piece});
          }
          // o raciocínio vira progresso visível: um turno leva ~70s e, sem isso,
          // a janela parece travada
          const thinking = chunk?.message?.thinking ?? '';
          if (thinking) emit({type: 'agent', event: 'thinking', text: thinking});
          if (chunk?.message?.tool_calls) toolCalls = chunk.message.tool_calls;
          if (chunk?.done) {
            content = chunk?.message?.content ?? content;
            if (chunk.message?.tool_calls) toolCalls = chunk.message.tool_calls;
          }
        }
      }

      if (toolCalls.length === 0) {
        if (!content.trim()) {
          // Virou fase de resposta sem ferramentas: sem tool para planejar, o
          // modelo não precisa pensar tanto e fecha em segundos.
          emit({type: 'agent', event: 'notice', text: 'finalizando a resposta…'});
          content = await synthesize(
            ollama,
            writerModel,
            messages,
            Math.min(numPredict, 1200),
            controller.signal,
          );
        }
        answer = content.trim();
        if (!answer) {
          throw new Error(
            `o modelo não produziu resposta (provavelmente atingiu o limite de ${numPredict} tokens pensando). ` +
              'Aumente o limite de tokens nas configurações do nó agente.',
          );
        }
        emit({type: 'agent', event: 'final', text: answer});
        break;
      }

      // O modelo pediu ferramenta: executamos e devolvemos o resultado.
      messages.push({role: 'assistant', content, tool_calls: toolCalls});
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const args = call?.function?.arguments ?? {};
        if (!RUNNERS[name]) {
          messages.push({role: 'tool', content: `Ferramenta "${name}" não existe.`});
          continue;
        }
        emit({type: 'agent', event: 'tool_call', name, args});
        const started = Date.now();
        let output = '';
        try {
          const runnerConfig = {...(enabled.find((t) => t.type === name)?.config ?? {}), preferredSource};
        output = await RUNNERS[name](args, runnerConfig, controller.signal);
        } catch (error) {
          output = `A ferramenta falhou: ${error.message}`;
        }
        output = String(output).slice(0, TOOL_OUTPUT_LIMIT);
        used.push(name);
        emit({
          type: 'agent',
          event: 'tool_result',
          name,
          ms: Date.now() - started,
          chars: output.length,
          text: output,
        });
        messages.push({role: 'tool', content: output});
      }
    }

    if (!answer) {
      // Gastou o teto de iterações sem se CONTENTAR: o melhor que temos é dizer
      // isso explicitamente, em vez de devolver a última mensagem da conversa
      // (que seria o pedido original, e pareceria uma resposta).
      answer = `(o agente usou as ${maxIterations} iterações sem fechar uma resposta)`;
      emit({type: 'agent', event: 'final', text: answer});
    }

    clearTimeout(timer);
    running.delete(runId);
    emit({
      type: 'exit',
      runId,
      code: 0,
      signal: null,
      durationMs: Date.now() - startedAt,
      truncated: false,
      timedOut: false,
      vars: {
        RESPOSTA: answer,
        ITERACOES: String(iterations),
        FERRAMENTAS: used.join(','),
        MODELO: model,
        REDATOR: writerModel,
      },
    });
    res.end();
  } catch (error) {
    clearTimeout(timer);
    running.delete(runId);
    const aborted = controller.signal.aborted;
    const timeout = controller.signal.reason === 'timeout';
    emit({
      type: 'exit',
      runId,
      code: aborted ? null : 1,
      signal: aborted ? (timeout ? 'TIMEOUT' : 'SIGTERM') : null,
      durationMs: Date.now() - startedAt,
      truncated: false,
      timedOut: timeout,
      vars: {
        RESPOSTA: answer,
        ITERACOES: String(iterations),
        FERRAMENTAS: used.join(','),
        MODELO: model,
        ERRO: aborted
          ? timeout
            ? `tempo esgotado após ${timeoutMs} ms`
            : 'execução cancelada'
          : error.message,
      },
    });
    res.end();
  }
}