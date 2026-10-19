/**
 * Ferramentas disponíveis para o agente de IA.
 *
 * Hoje só `buscar_web` (API da Wikipédia, sem chave). A configuração do nó
 * (modelo, redator, timeout, voltas, tokens) vive no próprio nó — não há mais
 * um painel separado na sidebar.
 */

export function toAgentTools(): {
  type: string;
  config: {endpoint: string; maxResults: number};
}[] {
  return [
    {
      type: 'buscar_web',
      config: {
        endpoint: 'https://pt.wikipedia.org/w/api.php',
        maxResults: 3,
      },
    },
  ];
}