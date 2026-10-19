/**
 * Busca web sem chave de API, para a ferramenta `buscar_web` do agente.
 *
 * Ordem de tentativa (cascata): a primeira que responder com conteúdo vence.
 *   1. Wikipédia (pt → en) — JSON limpo, estável, sem chave
 *   2. Bing RSS            — sem chave, retorna XML com 10 resultados
 *   3. Ollama cloud        — exige OLLAMA_API_KEY, é a última (e a melhor)
 *
 * Cada fonte é independente: se uma falhar ou bloquear, tenta a próxima.
 */

const UA = 'workflow-diagram/1.0 (exemplo de agente)';

const fetchText = async (url, signal) => {
  const response = await fetch(url, {headers: {'user-agent': UA}, signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
};

const stripTags = (html) =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const wikipedia = async (query, signal) => {
  const search = async (lang) => {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('srlimit', '3');
    url.searchParams.set('srsearch', query);
    const response = await fetch(url, {headers: {'user-agent': UA}, signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return body?.query?.search ?? [];
  };

  let items = await search('pt');
  if (items.length === 0) items = await search('en');
  if (items.length === 0) return null;

  return items
    .map((item) => `- ${item.title}: ${stripTags(item.snippet)}`)
    .join('\n');
};

const bing = async (query, signal) => {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'rss');

  const text = await fetchText(url, signal);
  const items = text.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  const out = [];
  for (const item of items.slice(0, 5)) {
    const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    const desc = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '';
    const cleanTitle = stripTags(title);
    const cleanDesc = stripTags(desc);
    if (cleanTitle) out.push(`- ${cleanTitle}: ${cleanDesc}`);
  }
  return out.length > 0 ? out.join('\n') : null;
};

const ollamaCloud = async (query, signal) => {
  const apiKey = (process.env.OLLAMA_API_KEY ?? '').trim();
  if (!apiKey) return null;

  const response = await fetch('https://ollama.com/api/web_search', {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
    body: JSON.stringify({query, max_results: 5}),
    signal,
  });
  if (!response.ok) return null;

  const body = await response.json();
  const results = body?.results ?? [];
  if (results.length === 0) return null;

  return results
    .map((item) => `- ${item.title}: ${stripTags(item.content ?? '')}`)
    .join('\n');
};

const SOURCES = [
  {name: 'Wikipédia', run: wikipedia},
  {name: 'Bing', run: bing},
  {name: 'Ollama cloud', run: ollamaCloud},
];

export async function webSearch(query, signal, preferred) {
  const errors = [];
  // Fonte preferida primeiro (se existir e for válida); as demais são o
  // fallback, na ordem original. Assim o usuário escolhe o que quer sem perder
  // a garantia de ter algum resultado.
  const ordered = preferred
    ? [SOURCES.find((s) => s.name === preferred), ...SOURCES.filter((s) => s.name !== preferred)].filter(Boolean)
    : SOURCES;
  for (const source of ordered) {
    try {
      const result = await source.run(query, signal);
      if (result) return {source: source.name, result};
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  return {
    source: null,
    result:
      `Nenhum resultado para "${query}" (tentativas: ${errors.join('; ') || 'todas retornaram vazio'}). ` +
      'Tente outros termos ou configure OLLAMA_API_KEY para a busca da Ollama.',
  };
}

export { SOURCES };
