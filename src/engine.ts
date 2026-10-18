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

/** Condição de um nó de decisão, com o default quando nunca foi editada. */
export const conditionOf = (node: Node): string =>
  node.condition?.trim() || DEFAULT_CONDITION;

/**
 * Avalia a condição de um losango contra o exit code do último terminal.
 *
 * Gramática mínima e deliberadamente pequena:
 *   exit == 0 | exit != 0 | exit > 1 | exit >= 1 | exit < 1 | exit <= 1
 *   ok   (verdadeiro quando exit === 0)
 *   fail (verdadeiro quando exit !== 0)  — `erro` é apelido
 *
 * `exit` sem número compara contra 0. Qualquer outra coisa é erro de
 * configuração, não "falso": um `if` mal escrito que calasse em silêncio seria
 * o pior tipo de bug num motor de workflow.
 */
export function evaluateCondition(condition: string, exitCode: number | null): boolean {
  const text = condition.trim().toLowerCase().replace(/\s+/g, ' ');

  if (text === 'ok') return exitCode === 0;
  if (text === 'fail' || text === 'erro') return exitCode !== 0;

  const binary = text.match(/^(?:exit|code)\s*(==|!=|>=|<=|>|<|=)?\s*(-?\d+)?$/);
  if (!binary) throw new Error(`Condição inválida: "${condition}"`);

  const [, rawOperator, rawNumber] = binary;
  const operator = rawOperator ?? '==';
  const right = rawNumber === undefined ? 0 : Number(rawNumber);

  // Um terminal que nem rodou (ou foi pulado) não tem exit code: não é
  // verdadeiro nem falso, é uma comparação impossível.
  if (left === null) throw new Error('Condição precisa de um exit code, mas o passo anterior não executou');

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
 * Qual saída de um losango corresponde a "verdadeiro".
 *
 * As saídas de um nó de decisão são, por ordem de criação, a primeira
 * verdadeira e a segunda falsa. `edge.branch` sobrescreve essa ordem depois
 * que o usuário troca os lados (ver `assignBranches`).
 */
export function branchOf(page: Page, nodeId: string, edge: Edge): Branch | null {
  const outgoing = OUTGOING(page, nodeId);
  const index = outgoing.indexOf(edge);
  if (edge.branch) return edge.branch;
  return index === 0 ? 'true' : index === 1 ? 'false' : null;
}

/** Troca os lados (verdadeiro ↔ falso) de todas as saídas de uma decisão. */
export function swappedBranches(page: Page, nodeId: string): Record<string, Branch> {
  const swaps: Record<string, Branch> = {};
  for (const edge of OUTGOING(page, nodeId)) {
    const current = branchOf(page, nodeId, edge);
    if (current) swaps[edge.id] = current === 'true' ? 'false' : 'true';
  }
  return swaps;
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
  | {kind: 'next'; edge: Edge | null; reason: string}
  | {kind: 'halt'; reason: string};

/**
 * Decide o próximo passo depois de um nó qualquer ter sido processado.
 *
 * - terminal/demais nós com saída: segue pela primeira aresta de saída.
 * - losango: avalia a condição e segue pela saída do lado correspondente.
 * - fim do fluxo (sem saídas): halta.
 */
export function nextStep(
  page: Page,
  node: Node,
  exitCode: number | null,
): NextStep {
  const outgoing = OUTGOING(page, node.id);

  if (isDecision(node)) {
    if (outgoing.length === 0) {
      throw new Error(`Decisão "${node.label}" não tem saída para nenhum lado`);
    }
    if (outgoing.length > 2) {
      throw new Error(
        `Decisão "${node.label}" tem ${outgoing.length} saídas; o máximo é 2 (sim/não)`,
      );
    }
    let taken: Branch;
    try {
      taken = evaluateCondition(conditionOf(node), exitCode) ? 'true' : 'false';
    } catch (error) {
      throw new Error(`Decisão "${node.label}": ${(error as Error).message}`);
    }
    const edge = outgoing.find((item) => branchOf(page, node.id, item) === taken);
    if (!edge) {
      throw new Error(
        `Decisão "${node.label}": o lado "${taken === 'true' ? 'sim' : 'não'}" não tem saída`,
      );
    }
    const exit = exitCode === null ? '' : ` (exit ${exitCode})`;
    return {
      kind: 'next',
      edge,
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