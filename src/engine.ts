import type {Edge, Node, Page, ShapeKind} from './types';

/**
 * Motor de workflow: percorre o grafo a partir de um nó inicial e decide o
 * próximo passo. É puro no sentido em que não executa nada — recebe o resultado
 * de cada nó terminal e devolve qual vem a seguir. Quem executa de fato é
 * `execution.ts`, o que deixa as regras de decisão (branch por exit code,
 * ordem das saídas, detecção de ciclo) testáveis sem processo nem DOM.
 */

export type Branch = 'true' | 'false';

export interface NodeOutcome {
  /** `false` interrompe o fluxo (exit ≠ 0 sem tratamento). */
  continueFlow: boolean;
  exitCode: number | null;
  summary: string;
}

export const CONTINUE: NodeOutcome = {continueFlow: true, exitCode: null, summary: ''};
export const STOP: NodeOutcome = {continueFlow: false, exitCode: null, summary: ''};

export const DEFAULT_CONDITION = 'exit == 0';

/**
 * Mensagem única para "a decisão precisa de um exit code". Aparece tanto para
 * `ok`/`fail` quanto para comparações numéricas: é sempre a mesma causa — o
 * passo anterior não rodou um comando.
 */
const MISSING_EXIT =
  'não há exit code para decidir: o passo anterior precisa ser um nó terminal que executou um comando';

/** Condição de um nó de decisão, com o default quando nunca foi editada. */
export const conditionOf = (node: Node): string =>
  node.condition?.trim() || DEFAULT_CONDITION;

/**
 * Contexto de decisão: o que um losango pode olhar.
 *
 * `exit` é o código do **último terminal**; `vars` são as variáveis acumuladas
 * pelos terminais anteriores que declararam o que exportam.
 */
export interface DecisionContext {
  exitCode: number | null;
  vars: Readonly<Record<string, string>>;
}

/**
 * Avalia a condição de um losango contra `exit` **ou** uma variável exposta.
 *
 *   exit == 0    IDADE > 18    NOME == ana    idade >= 18
 *   ok    (verdadeiro quando exit === 0)
 *   fail  (verdadeiro quando exit !== 0)  — `erro` é apelido
 *
 * Dois lados numéricos viram comparação numérica; se algum não for número, é
 * comparação de texto (só `==` e `!=` fazem sentido).
 *
 * Variável inexistente, `exit` indisponível e texto não reconhecido são **erro**,
 * nunca `false`: um `if` mal escrito que calasse em silêncio seria o pior tipo de
 * bug num motor de workflow.
 */
export function evaluateCondition(condition: string, ctx: DecisionContext): boolean {
  const text = condition.trim().toLowerCase().replace(/\s+/g, ' ');

  if (text === 'ok' || text === 'fail' || text === 'erro') {
    if (ctx.exitCode === null) throw new Error(MISSING_EXIT);
    return text === 'ok' ? ctx.exitCode === 0 : ctx.exitCode !== 0;
  }

  const binary = text.match(
    /^([a-z_][a-z0-9_]*)\s*(==|!=|>=|<=|>|<|=)?\s*(-?[0-9.]+|-?[a-z_][a-z0-9_ ]*)?$/,
  );
  if (!binary) throw new Error(`Condição inválida: "${condition}"`);

  const [, name, rawOperator, rawValue] = binary;
  const operator = rawOperator ?? '==';
  const right = rawValue?.trim() ?? '';
  if (!right) throw new Error(`Condição "${condition}" está sem o valor de comparação`);

  const left = readOperand(name ?? '', ctx);
  const rightValue = readRightOperand(right, ctx);

  const leftNumber = Number(left);
  const rightNumber = Number(rightValue);
  const numeric =
    left.trim() !== '' &&
    rightValue.trim() !== '' &&
    !Number.isNaN(leftNumber) &&
    !Number.isNaN(rightNumber);

  if (numeric) return compare(leftNumber, operator, rightNumber);

  if (operator !== '==' && operator !== '=' && operator !== '!=') {
    throw new Error(
      `Operador "${operator}" só vale para números — "${left}" e "${rightValue}" não são`,
    );
  }
  const equal = left.trim() === rightValue.trim();
  return operator === '!=' ? !equal : equal;
}

/**
 * Lado direito: uma referência quando o nome existe (variável exposta ou
 * `exit`), um literal quando não.
 *
 * Sem isso, `IDADE > 18` seria lido como "18 é uma variável" — e a condição
 * mais óbvia do mundo morreria com "variável 18 não existe".
 */
function readRightOperand(raw: string, ctx: DecisionContext): string {
  const key = raw.trim().toLowerCase();
  const known =
    key === 'exit' ||
    key === 'code' ||
    Object.keys(ctx.vars).some((variable) => variable.toLowerCase() === key);
  return known ? readOperand(raw, ctx) : raw.trim();
}

/** Resolve `exit`/`code` (saída do último terminal) ou uma variável exposta. */
function readOperand(name: string, ctx: DecisionContext): string {
  const key = name.trim().toLowerCase();
  if (key === 'exit' || key === 'code') {
    if (ctx.exitCode === null) throw new Error(MISSING_EXIT);
    return String(ctx.exitCode);
  }
  const found = Object.entries(ctx.vars).find(([variable]) => variable.toLowerCase() === key);
  if (!found) {
    const available = Object.keys(ctx.vars);
    throw new Error(
      available.length > 0
        ? `variável "${name}" não existe — disponíveis: ${available.join(', ')}`
        : `variável "${name}" não existe: nenhum terminal anterior exportou variáveis`,
    );
  }
  return found[1] ?? '';
}

function compare(left: number, operator: string, right: number): boolean {
  switch (operator) {
    case '==':
    case '=':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    default:
      throw new Error(`Operador inválido: "${operator}"`);
  }
}


const OUTGOING = (page: Page, nodeId: string): Edge[] =>
  page.edges.filter((edge) => edge.from.nodeId === nodeId);

/**
 * Qual lado da decisão uma saída representa.
 *
 * A lateral diz tudo: a saída **da direita** é o caminho verdadeiro e a **da
 * esquerda** é o falso. É uma regra do desenho, não um atributo guardado no
 * modelo — o losango tem duas saídas e elas ficam onde o usuário as arrastou,
 * sem botão de "trocar lados" para sair de sincronia com o desenho.
 */
export function branchOf(edge: Edge): Branch | null {
  if (edge.from.side === 'e') return 'true';
  if (edge.from.side === 'w') return 'false';
  return null;
}

/** Nós que podem iniciar um fluxo: losango/terminal não são gatilho. */
export const isStartNode = (page: Page, node: Node): boolean =>
  node.kind === 'ellipse' &&
  page.edges.every((edge) => edge.to.nodeId !== node.id) &&
  OUTGOING(page, node.id).length > 0;

/** Um nó de decisão é um losango, com ou sem condição configurada. */
export const isDecision = (node: Node): boolean => node.kind === 'diamond';

/** Nós que produzem exit code para o losango consumir. */
export const isTerminal = (node: Node): boolean => node.kind === 'terminal';

export type NextStep =
  | {kind: 'next'; edge: Edge; reason: string}
  | {kind: 'halt'; reason: string};

/**
 * Decide o próximo passo depois de um nó qualquer ter sido processado.
 *
 * - terminal/demais nós com saída: segue pela primeira aresta de saída.
 * - losango: avalia a condição e segue pela saída do lado correspondente
 *   (direita = verdadeiro, esquerda = falso).
 * - fim do fluxo (sem saídas): halta.
 */
export function nextStep(page: Page, node: Node, ctx: DecisionContext): NextStep {
  const outgoing = OUTGOING(page, node.id);

  if (isDecision(node)) {
    const yes = outgoing.find((edge) => branchOf(edge) === 'true');
    const no = outgoing.find((edge) => branchOf(edge) === 'false');

    if (!yes || !no) {
      const missing = yes ? 'da esquerda (não)' : 'da direita (sim)';
      throw new Error(
        `A decisão "${node.label}" está sem a saída ${missing}. Uma decisão tem exatamente duas: direita para sim, esquerda para não.`,
      );
    }

    let taken: Branch;
    try {
      taken = evaluateCondition(conditionOf(node), ctx) ? 'true' : 'false';
    } catch (error) {
      throw new Error(`Decisão "${node.label}": ${(error as Error).message}`);
    }

    const exit = ctx.exitCode === null ? '' : ` (exit ${ctx.exitCode})`;
    return {
      kind: 'next',
      edge: taken === 'true' ? yes : no,
      reason: `${conditionOf(node)}${exit} → ${taken === 'true' ? 'sim' : 'não'}`,
    };
  }

  const first = outgoing[0];
  if (!first) return {kind: 'halt', reason: 'fim do fluxo'};
  if (outgoing.length > 1) {
    // Só o losango decide o caminho; nos demais nós, saídas múltiplas são um
    // desenho ambíguo — avisa em vez de escolher um lado silenciosamente.
    return {
      kind: 'next',
      edge: first,
      reason: `${outgoing.length} saídas: seguindo a primeira (use um losango para decidir)`,
    };
  }
  return {kind: 'next', edge: first, reason: ''};
}

/** Rótulo curto do passo, usado no histórico. */
export const stepLabel = (node: Node): string =>
  node.kind === 'text' ? `${node.label} (anotação)` : node.label;

export const KIND_LABEL: Record<ShapeKind, string> = {
  rect: 'processo',
  ellipse: 'início/fim',
  diamond: 'decisão',
  text: 'texto',
  terminal: 'terminal',
};