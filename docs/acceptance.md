# Matriz de aceite

Todos os cenários locais usam dados sintéticos e SMTP controlado. Resultados executados, limitações e identidades estão em [evidence.md](evidence.md); ausência de evidência significa pendência. A matriz abaixo contém os critérios, sem converter execução sintética em aceite externo.

| Grupo | Critério |
|---|---|
| Construção | Node 24/Fastify 5, lock versionado, npm ci e todas as imagens do Compose construídas |
| Inicialização | Import sem IO; configuração inválida bloqueia; rotas/hooks sem 500 |
| Schema | Banco novo, checksum, trava e transações; ambos legados e schema desconhecido bloqueados quando não há adoção definida |
| API | Templates estritos; raw exige scope; idempotência 30 dias/409; mensagem imutável; um destinatário/sem anexo |
| Tenant e autenticação | Tenant A/B em todos os recursos/retries; send-only sem admin/logs/stats; expiração e revogação |
| Quota | Limites compartilhados SMTP/HTTP; rotação não reinicia; abortos liberam só quando comprovados |
| Fila | Outbox persistente; Redis recuperável; leases; falhas métricas sem reenvio; outcome_unknown conservador |
| SMTP | STARTTLS/validação cert/SASL obrigatórios; 587 auth também Docker; From/Reply-To/relay/múltiplos headers; policy/signer indisponíveis |
| Entrega | Queue ID/instância correlacionados; evento idempotente; DSN inválida/duplicada; supressão somente inválido permanente qualificado |
| Privacidade | Canários ausentes logs; conteúdo cifrado; spool/temp/backup cifrados; expurgo após terminal e TTL |
| Recuperação | Reinício/restore fechados; reconciliação antes liberação; RPO1h/RTO4h medidos |
| Carga | 1.000 mensagens, dez clientes concorrentes, quotas sintéticas separadas, sem rota SMTP externa |
| Segurança e CI | lint/test/migrations/build/Gitleaks/dependências/imagens, gates sem continue-on-error |
| Externo | Autorização operacional; Keycloak real, API template/raw, SPF/DKIM/DMARC recebidos, latência e rejeição/atraso |

Aceite do aplicativo depende das provas externas, recebimento observado e avaliação operacional. Resultado local não comprova CI remota, infraestrutura ou entrega real.

## Limites dos resultados locais

A qualificação completa executa 64 testes automatizados (12 API/unitários/contrato, 24 PostgreSQL, 24 Python e quatro backup/scanner), além dos cenários reais locais de HTTP, SMTP, carga e restore. Os resultados específicos e o manifesto da execução estão em [evidence.md](evidence.md).

| Área | Limite de aceite |
| --- | --- |
| Segurança | Gate HIGH/CRITICAL e segredos obrigatório; achados remanescentes bloqueiam produção mesmo com testes funcionais aprovados. |
| Privacidade | Conteúdo e backup cifrados e redaction exercitados; o spool sintético usa tmpfs. Criptografia dos volumes operacionais depende da infraestrutura e não foi comprovada localmente. |
| Recuperação | Restore físico sintético medido; RPO de uma hora, RTO operacional de quatro horas, residência brasileira e cópia fora da VM permanecem sem qualificação. |
| Falhas | Injeções controladas cobrem resultados perdidos/commit/Redis e métricas; não representam todas as janelas possíveis de crash real de processo. |
| CI | Configurada com gates obrigatórios; execução remota não realizada. |
| Externo | Não executado; exige autorização e caixas controladas. |
