# Executor de comandos dos nós "terminal" e do motor de workflow.
#
# Uma imagem Linux mínima com Node: o executor só precisa do runtime, os
# comandos do workflow rodam com as ferramentas que você montar no container.
FROM node:24-alpine

# `tini` como PID 1 para que SIGTERM/SIGKILL (timeout, cancelamento, docker
# stop) cheguem ao processo em vez de o container ignorar e só ser morto no fim.
#
# `docker-cli` fica na imagem porque é barato (~10 MB) e deixa o nó terminal
# falar com o Docker sem rebuild. **O que não vem por padrão é o acesso**: o
# socket do host só é montado pelo overlay `docker-compose.docker.yml`, então o
# executor padrão não consegue chegar no Docker de jeito nenhum.
# curl e jq são o que os nós de IA usam para falar com a Ollama e extrair o
# campo que importa da resposta — sem eles o executor não consegue buscar nada.
RUN apk add --no-cache tini bash coreutils curl jq git docker-cli docker-cli-compose

WORKDIR /app

# Só o executor é copiado para a imagem; o código do diagrama entra pelo volume.
COPY server/index.mjs server/agent.mjs server/search.mjs ./server/

# O workspace do workflow é montado por fora (compose); este é o default.
ENV WORKFLOW_ROOT=/workspace \
    PORT=5178 \
    HOST=0.0.0.0 \
    NODE_ENV=production

# USER root de propósito: o executor roda comandos do usuário sobre o volume
# montado, e trocar de uid aqui quebraria a escrita no bind mount do host.
# Para isolar de verdade, monte o workspace em um diretório descartável.

EXPOSE 5178

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/server/index.mjs"]