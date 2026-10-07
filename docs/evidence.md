# Evidências da entrega local

Resultado consolidado: **qualificação funcional local PASS; segurança de imagens FAIL; aceite de produção bloqueado**. Nenhuma CI remota, infraestrutura publicada, entrega Internet ou homologação Keycloak foi executada. O relatório funcional não inclui o gate de imagens, que foi executado separadamente e permanece obrigatório.

## Candidato e rastreabilidade

- Branch: `feat/verde2-production-mail`; HEAD base: `e7c98110ee51d8fe1b4e6828c9b05366a6293a81`. Worktree modificada, sem commit, push, merge ou deploy.
- Execução completa: `verde2-qualify-1791337660662-34956`, de 2026-10-07T01:47:40.662Z a 2026-10-07T02:10:15.026Z (UTC).
- Digest do manifesto de fontes testadas: `e994bd49f49eb259e99aaabc0eadf7a94a301336e0816af524231a35b32da59c`, calculado por SHA-256 do JSON compacto do manifesto ordenado. [Manifesto](evidence/qualified-source-manifest.json), [relatório funcional](evidence/local-qualification.json).
- Versões exatas dos pacotes estão no campo `versions` do relatório e nos seis SBOMs CycloneDX. Runtime Node v24.21.0; PostgreSQL/Redis e componentes SMTP estão vinculados aos IDs abaixo.
- [Preservação](evidence/preservation.json): 16/16 fontes antigas arquivadas com bytes idênticos ao HEAD; configurações locais ignoradas presentes, sem leitura de valores. O lockfile anterior ficou no arquivo local ignorado; o novo lockfile é versionável.
- [Reconciliação final](evidence/final-reconciliation.json) registra o manifesto final, diferenças documentais e identidade das fontes de runtime/testes/scripts em relação ao snapshot qualificado. O SHA base sozinho não representa esta implementação.

| Imagem própria efetivamente usada | ID imutável local |
| --- | --- |
| api | `sha256:da7c252dcc90556857348f5cf485f2a631235f3507ed6b0dd7e87494cc8a3510` |
| postfix | `sha256:55b60cd5cc27c9f5c218ea29a4e1bba1b17091342e27c578d0543f98894f4f06` |
| policy | `sha256:ffff8055ded2260178084db20c33f5e8e98514301b01a6ecf872b2966cb2fcd0` |
| opendkim | `sha256:64f84e1f2cfbe0542f273394b6baf83e662724cee0378fb4d16adb377c173d6a` |
| postgres | `sha256:8eb681e254bc35eea04bd217b9b8c32245e329dd0f3380dc0c671fe635514566` |
| redis | `sha256:283a0b2772591fee809886da80fe389f381a2428f40d59ca52ff2153efd239e7` |

IDs locais identificam as imagens no engine qualificado, sem comprovar publicação em registry. `imageId` do scanner pode ser o digest da configuração de plataforma, distinto do índice multi-plataforma; `qualifiedImageId` é o ID inspecionado e exportado para o scan.

## Comandos e resultados

Executados em Docker Desktop Linux no Windows, com Node 24.15.0/npm 12 no host. Os nomes, tempos e estados de cada gate estão no relatório JSON; stdout/segredos não foram copiados.

| Comando/prova | Resultado e limite |
| --- | --- |
| `node scripts/qualify.mjs`, escopo `full` | Exit 0; instalação limpa por `npm ci --ignore-scripts`, lint, contrato OpenAPI/unitários, audit npm, migrations, seis builds próprios, transportes e recuperação aprovados. O snapshot não lê o `.env` local. |
| Gitleaks candidato e histórico | PASS/exit0; scanners fixados, redaction e rede desabilitada. [Histórico](evidence/history-gitleaks.json). |
| PostgreSQL real + Redis real | Isolamento/scopes, idempotência concorrente, quotas HTTP/SMTP, rollback, leases/revogação, outbox/enqueue parcial, perda de Redis, retenção, dois schemas legados e drift aprovados. Falhas de confirmação SMTP e métricas usam injeções controladas nessa suíte; não equivalem a crash real de processo no intervalo DATA/commit. |
| SMTP/MTA/HTTP reais locais | STARTTLS/certificado, SASL/credencial revogada, relay anônimo, From/Reply-To/múltiplos headers, destinatário único, rejeição temporária com policy/signer indisponíveis, API template/raw, erros com zero admissão e DSN local25 aprovados. |
| Carga sintética | 1.000 mensagens com dez clientes, zero duplicatas observadas e 1.000 assinaturas DKIM verificadas; 11.23 minutos. Quotas somente de teste: tenant 10.000/minuto e 10.000/dia, serviço 5.000/dia. Dois workers; espera máxima de conclusão 1.200s após admissão. Não é garantia de capacidade/entregabilidade. |
| Reinício e restore físico | PASS; PostgreSQL reiniciou com migrations válidas e PG/Redis sem UID zero. Backup cifrado e autenticado, corrupção rejeitada; restore medido em 1.79 minutos. Dispatch pausado, credenciais revogadas, queued incerto, conteúdo vencido removido, journal pendente em quarentena, MTA inicialmente recusado. Após ação sintética explícita e auditada, fila incerta continuou hold, vencida foi removida e zero mensagens adicionais chegaram ao sink. |
| Privacidade e retenção | Canários/credenciais/endereços completos ausentes dos logs coletados; conteúdo persistido e backup cifrados; journal expurgado independentemente do MTA. Spool local usa tmpfs descartável: não comprova cifragem de volumes da infraestrutura futura nem ACL POSIX no CI remoto. |
| `node scripts/scan-images.mjs` | FAIL/exit 1; seis imagens analisadas com Trivy 0.74.0, HIGH/CRITICAL e segredos obrigatórios; seis SBOMs emitidos. [Resumo](evidence/image-scan-summary.json). |

A rede sintética era `internal=true`, sem portas publicadas, com destinos `.test` e sink controlado. Não existia rota SMTP externa. Recursos próprios, certificados, credenciais sintéticas e backups foram removidos pelo runner; imagens locais, cache de scanner e relatórios foram preservados. Backups fora da VM e RPO de 1h/RTO de 4h de produção **não qualificados**.

## Gate de imagens

| Imagem | Gate | Ocorrências / CVEs únicos | CRITICAL | Segredos |
| --- | --- | --- | --- | --- |
| verde2/api:local | FAIL | 43 / 8 | 0 | 0 |
| verde2/postfix:local | FAIL | 68 / 17 | 0 | 0 |
| verde2/policy:local | FAIL | 68 / 17 | 0 | 0 |
| verde2/opendkim:local | FAIL | 46 / 8 | 0 | 0 |
| verde2/postgres:local | PASS | 0 / 0 | 0 | 0 |
| verde2/redis:local | PASS | 0 / 0 | 0 | 0 |

17 CVEs únicos entre as imagens finais. A remoção de ferramentas globais npm do runtime, substituição do helper Go por pacote oficial su-exec na imagem derivada e atualização OpenSSL do Redis são mudanças verificadas, sem exclusões no scanner. O restante e as fontes oficiais estão em [security-findings.md](security-findings.md). Não foi validada exploração dos CVEs no serviço. Não usar a classificação vendor `no-dsa` como aprovação.

## Falhas históricas preservadas

- [FULL anterior FAIL](evidence/historical-full-failed.json): carga 1.000 PASS, mas recuperação terminou em `docker_operation_failed`; resultado global continua FAIL.
- [Restore anterior FAIL](evidence/historical-recovery-failed.json): houve falha de parsing JSON de postqueue. A correção separa stdout/stderr e aguarda prontidão real; uma execução posterior verde não prova isoladamente toda a causa anterior.
- [Recuperação focada PASS](evidence/historical-recovery-pass.json): carga NOT_RUN explicitamente, vinculada naquela ocasião ao runtime e imagens anteriores; não foi usada para qualificar as imagens finais.
- [Scan anterior FAIL](evidence/historical-image-scan-failed.json): mantido para comparação dos componentes corrigidos. Gate anterior não foi reclassificado.
- [Scan intermediário FAIL](evidence/intermediate-image-scan-failed.json): quatro imagens Debian e 22 achados Go no caminho gosu ainda identificado na camada base, embora o runtime usasse um alias para C. A FULL dessa imagem [permanece PASS funcional](evidence/intermediate-full-pass.json), separada do gate FAIL; a imagem final elimina o caminho gosu e substitui as duas chamadas oficiais, sendo qualificada novamente.
- [Primeira reconciliação final FAIL](evidence/historical-final-audit-cleanup-failed.json): identificou um container sintético de diagnóstico antigo em estado created, sem processo em execução. A propriedade e os mounts sob `.qualification/` foram conferidos antes de remover somente esse container. A auditoria final foi repetida; fontes de runtime não mudaram.
- Revisões finais apontaram retenção de spool sem vínculo, limite de resposta do controle, autorização de liberação vencida, tipos e objetos de catálogo desconhecidos no banco e classificação HTTP incorreta. Correções e testes estão no snapshot da FULL final; evidência e limites da [revisão independente](evidence/reviews.json) e da reconciliação são separados dos resultados executados.

## Estado final e próximos requisitos

| Dimensão | Estado |
| --- | --- |
| Implementação local | Implementada e funcionalmente qualificada; gate de segurança de imagens bloqueia produção. |
| CI | Workflow configurado com gates obrigatórios; nenhuma execução remota, push ou publicação. |
| Infraestrutura | Não contratada/implantada. Pendente domínio, VM/IP/PTR/TCP25, residência brasileira, armazenamento cifrado, certificados, firewall, backups externos, alertas e responsável. |
| Entrega real | Não executada. Pendente Keycloak real, API, SPF/DKIM/DMARC recebidos e observação em caixas controladas, após autorização. |
| Aceite operacional | Bloqueado por segurança e pelas provas externas/infraestrutura ausentes. O aplicativo não pode depender do Verde2 nesta etapa. |

[Runbook](runbook.md), [handoff](handoff-backend.md) e [hospedagem/DNS](hosting-dns.md) descrevem a próxima etapa, sem autorizá-la. Credenciais devem vir do cofre; nenhum valor consta nestes artefatos.
