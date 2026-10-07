# Verde2 — e-mail transacional

Serviço próprio para SMTP autenticado do Keycloak e API REST por aplicação/ambiente. Esta árvore contém implementação local; a qualificação funcional e o gate de imagens são registrados separadamente nas evidências. O gate de segurança bloqueia produção enquanto houver falhas. Não existe hostname de produção qualificado nem comprovação de entrega externa. O aplicativo só pode depender do Verde2 após homologação operacional com caixas controladas.

## Documentação

- [OpenAPI](api/openapi.json), gerado dos schemas da aplicação.
- [Instalação e operação](docs/runbook.md).
- [Integração do backend e Keycloak](docs/handoff-backend.md).
- [Hospedagem e DNS](docs/hosting-dns.md).
- [Limitações e estados da entrega](docs/limitations.md).
- [Achados e bloqueio de segurança](docs/security-findings.md).
- [Resultados executados, digests e estados finais](docs/evidence.md).
- [Baseline](docs/baseline.md), [ameaças](docs/threat-model.md) e [aceite](docs/acceptance.md).

## Arquitetura

JavaScript ESM, Node.js 24, Fastify 5, PostgreSQL 16 e Redis/BullMQ. Imagens próprias de Postfix/Cyrus SASL, política Python e OpenDKIM sobre Debian 13. Versões exatas das bibliotecas estão em `api/package-lock.json`; referências de imagens estão nos Dockerfiles e Compose. Referência fixada não equivale a imagem qualificada: consultar o relatório da execução correspondente.

PostgreSQL e Redis usam imagens derivadas de bases oficiais Alpine fixadas, com correções documentadas de componentes auxiliares. O Compose operacional exige referências imutáveis aprovadas para todas as seis imagens, incluindo banco e fila.

PostgreSQL mantém mensagens, idempotência, quotas, outbox, tentativas e eventos. Redis transporta identificadores reconstruíveis. A API grava conteúdo renderizado e cifrado antes de responder `202`; o worker obtém lease e usa SMTP com STARTTLS validado. A política privada autoriza a submissão antes do OpenDKIM. Depois de aceitação local, Postfix assume tentativas aos MX externos. Falta de confirmação após início de submissão exige reconciliação como `outcome_unknown`.

Cada aplicação e ambiente possui um tenant. Chaves HTTP, credenciais SMTP e credencial administrativa são distintas. Tenant vem da credencial. HTTP começa com `send:template`; envio direto, registros, estatísticas e gestão de templates exigem permissões explícitas. Um destinatário por mensagem, sem anexos. Não há webmail, IMAP, campanhas ou painel.

## Desenvolvimento e qualificação local

Requisitos: Node.js 24, npm compatível com o lockfile e Docker com engine Linux. Preservar `.env` e arquivos ignorados existentes; não sobrescrever configuração local com exemplos.

```powershell
npm.cmd --prefix api ci
npm.cmd --prefix api run lint
npm.cmd --prefix api test
node scripts/qualify.mjs
```

O runner é o caminho de qualificação sintética: cria snapshot identificado, rede isolada e serviços descartáveis; gera certificados e credenciais de teste. Não utiliza o `.env` operacional. Serializar com outros testes que usem Docker. Downloads podem usar Internet, mas o destino SMTP deve permanecer controlado. Ler saída e artefatos em `.qualification/` para saber o que efetivamente passou, falhou ou não foi executado. Não publicar esse diretório integralmente: contém material sintético de execução.

`npm --prefix api run openapi` regenera o contrato; revisar o diff junto das rotas. Importar `buildApp` não inicia HTTP ou worker. Entradas operacionais: `src/index.js`, `src/internal.js` e `src/worker.js`.

**Não usar `docker compose up` como teste local de envio:** o Compose principal conecta o MTA à rede `delivery`. Instalação operacional depende do runbook, autorização e controles de rede. Testes locais não comprovam DNS, reputação, recebimento na caixa ou Keycloak real.

## Interfaces

| Interface | Permissão/semântica |
| --- | --- |
| `POST /api/v1/send` | `send:template`; template e variáveis do tenant |
| `POST /api/v1/send/raw` | `send:raw`; conteúdo direto |
| `GET /api/v1/messages/{id}` e `/logs` | `logs:read`; estados/eventos sanitizados |
| `/api/v1/templates` | `templates:manage`; gestão e pré-visualização |
| `GET /api/v1/stats` | `stats:read`; agregação por tenant |
| `/api/v1/admin/*` | credencial administrativa opaca, expiração e auditoria |
| SMTP 587 | STARTTLS obrigatório, certificado validado e SASL |
| SMTP 25 | DSN para retornos reservados; não é submission |

Envios HTTP exigem `Idempotency-Key`, com deduplicação de 30 dias. Mesmo conteúdo retorna a mesma mensagem; conteúdo diferente recebe `409`. `202` comprova persistência e aceitação para processamento. `accepted_remote` indica aceitação SMTP pelo servidor remoto, não leitura nem posicionamento na caixa de entrada.

Defaults: 60 mensagens/minuto e 1.000/dia por tenant, 2.000/dia no serviço; dois workers concorrentes; MIME final até 1 MiB. As quotas usam janelas fixas de minuto e dia civil em UTC. HTTP e SMTP compartilham reservas. Teto SMTP conservador: cinco processos de submission, um de entrada DSN e quatro de saída; cada credencial usa no máximo cinco conexões de submission.

## Estado e publicação

Base registrada: `e7c98110ee51d8fe1b4e6828c9b05366a6293a81`, branch de trabalho `feat/verde2-production-mail`. Alterações locais posteriores precisam de manifesto de fontes e evidências próprias; apenas o SHA base não identifica o candidato testado.

Consultar [evidências consolidadas](docs/evidence.md) para testes, carga, restore, revisões independentes e o bloqueio de segurança das imagens. CI está configurada, mas não foi executada remotamente; infraestrutura não foi implantada; entrega real não foi realizada; aceite operacional está bloqueado. As configurações locais foram preservadas, sem commit, push ou merge. CI, infraestrutura, entrega real e aceite operacional são dimensões separadas. Este README não autoriza contratação, DNS ou envio externo. Segredos vêm do cofre do operador e nunca devem aparecer em documentos, logs ou histórico de comandos.
