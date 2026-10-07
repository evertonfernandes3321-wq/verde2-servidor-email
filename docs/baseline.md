# Baseline e limites da entrega local

Inspeção em 2026-10-06, no checkout `C:\Users\evert\Projetos\Verde2 - Servidor de Email`.

- Branch inicial: `master`; HEAD e referência local `origin/master`: `e7c98110ee51d8fe1b4e6828c9b05366a6293a81`.
- Worktree versionada limpa. Referência remota não foi atualizada via fetch; a igualdade observada é com a referência local.
- Branch de trabalho criada: `feat/verde2-production-mail`. Sem commit, push, merge ou implantação autorizados nesta execução.
- Nenhum `AGENTS.md` encontrado no projeto ou nos diretórios ancestrais consultados.
- Arquivos locais ignorados existentes: `.env`, `gitleaks.toml`, `api/node_modules/`, `api/package-lock.json`. Valores sensíveis não foram lidos. Lockfile local será preservado antes da atualização.
- Stack inicial: JavaScript ESM, Fastify 4, PostgreSQL, Redis/BullMQ, Nodemailer, Handlebars, Postfix e OpenDKIM.
- Ferramentas observadas: Node.js 24.15.0, npm 12, Docker Desktop Linux Engine 29.4.2. Nenhum contêiner rodando no início.

## Problemas observados na fonte inicial

`api/src/index.js` inicia servidor ao importar, registra hooks síncronos como hooks assíncronos e confia indiscriminadamente em proxies. `routes/*` e registro duplicam prefixos. `services/email.js` importa `Handlebars` mas usa `handlebars`, absorve erros de renderização e aceita qualquer certificado SMTP. `services/queue.js` cria worker ao importar, consulta templates sem tenant e mistura envio SMTP com atualização de métricas no mesmo caminho de retry.

Existem duas linhagens incompatíveis: `api/src/db/migrate.js`, com tabelas globais sem tenant; e `postgres/init/01-init.sql`, com tenants, dados iniciais e chave administrativa padrão. Nenhuma possui checksums. Bancos existentes não serão apagados nem terão dados atribuídos automaticamente.

`docker-compose.yml` usa `boky/postfix`, ignorando o Dockerfile e a configuração locais; mapeia porta 25 para 587, publica OpenDKIM, utiliza configurações permissivas. A CI mira `main/develop`, usa Node 20 e ignora falha do audit.

## Escopo autorizado

Implementação local de SMTP autenticado, API transacional, templates, fila, autenticação, isolamento, acompanhamento, rejeições, operação, testes sintéticos e documentação. Apenas ambientes descartáveis identificados; destinos SMTP controlados, sem saída SMTP acidental à Internet. Webmail, IMAP, painel, campanhas, cobrança e outros repositórios estão excluídos.

DNS, contratação, publicação, VPS, implantação, envios externos e testes reais de Keycloak exigem etapa operacional autorizada. Ausência dessas provas não autoriza o aplicativo a depender do Verde2.

## Coordenação de arquivos

Um responsável por `api/**`, outro por `postfix/**`, `opendkim/**`, `policy/**`, Compose e configurações de transporte. Coordenador mantém documentação, CI, scripts de qualificação e consolidação. Até dois editores simultâneos, arquivos distintos; agentes de desenho/revisão somente leitura. Sem delegação recursiva. Testes que compartilham banco, portas, volumes ou artefatos são serializados.
