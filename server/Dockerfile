# Executor de comandos dos nós "terminal" e do motor de workflow.
#
# Uma imagem Linux mínima com Node: o executor só precisa do runtime, os
# comandos do workflow rodam com as ferramentas que você montar no container.
FROM node:24-alpine

# `tini` como PID 1 para que SIGTERM/SIGKILL (timeout, cancelamento, docker
# stop) cheguem ao processo em vez de o container ignorar e só ser morto no fim.
RUN apk add --no-cache tini bash coreutils git

WORKDIR /app

# Só o executor é copiado para a imagem; o código do diagrama entra pelo volume.
COPY server/index.mjs ./server/index.mjs

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