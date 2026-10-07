# Limitações, evidências e estado de entrega

Este documento descreve limites observados no código e requisitos de operação. Não substitui resultados de execução. Base `e7c98110ee51d8fe1b4e6828c9b05366a6293a81`; branch `feat/verde2-production-mail`. Um SHA base com worktree modificada não identifica sozinho a implementação testada: vincular manifesto de arquivos/hash e imagens à execução.

| Dimensão | Estado desta entrega |
| --- | --- |
| Implementação local | implementada; qualificação funcional e gate de segurança separados em [evidence.md](evidence.md); segurança bloqueia produção |
| CI | workflow configurado; nenhuma execução remota, commit ou push nesta entrega |
| Infraestrutura | nenhum servidor contratado, publicado ou qualificado nesta entrega |
| Entrega real | não executada; destinos locais sintéticos não comprovam entrega Internet |
| Aceite operacional | bloqueado pelo gate de imagens, infraestrutura e provas externas pendentes |

## Limites concretos

- Um tenant por aplicação/ambiente, um destinatário por mensagem e sem anexos. Sem IMAP, webmail, campanhas, painel ou cobrança.
- Um domínio de assinatura `EMAIL_DOMAIN` por implantação atual. Tenants compartilham domínio autorizado, não dados/quotas. Multidomínio exige implementação e ensaio próprios.
- `202` confirma admissão persistida. `accepted_local` confirma Postfix; `accepted_remote` confirma servidor remoto. Nenhum desses estados significa leitura ou posicionamento na caixa de entrada.
- Sem garantia de exatamente uma entrega no destinatário. `Message-ID` ajuda correlação. Resultado incerto de submissão não admite retry cego.
- Revogação não recolhe mensagens já aceitas no MTA. Novas tentativas ainda não submetidas revalidam credenciais/tenant.
- SMTP direto não oferece `Idempotency-Key` HTTP ao Keycloak; falha de conexão após DATA pode exigir investigação antes de repetir pelo cliente.
- DSN recebido é entrada não confiável. A implementação registra sinal `dsn_unverified` correlacionado sem alterar automaticamente estado/supressão. Evidência qualificada do MTA é outra fonte. Não há qualificação universal de DSN nem reclamações de spam.
- Limite conservador de cinco conexões de submission no total, uma de entrada DSN e quatro de saída; não são dez sessões simultâneas de clientes de submission. Dois workers inicialmente.
- `/health/ready` prova acesso ao banco, não envio SMTP, assinatura ou fila saudável.
- Marker de armazenamento não cifra volume nem comprova localização. Compose não configura firewall externo, HTTPS público, renovação, cron, backup externo ou contratação.
- A rede `delivery` do Compose principal pode alcançar Internet. Usar runner isolado para ensaios; não ativar Compose operacional apenas para testar envio.
- Rotação direta de `CONTENT_KEY`/`CREDENTIAL_PEPPER` não tem migração de chaves automática. Requer procedimento específico para não perder leitura/autenticação.
- Bootstrap comum só cria primeiro administrador. Restore emite novo administrador em arquivo exclusivo protegido e revoga todas as credenciais recuperadas; não apagar dados/credenciais para burlar essa verificação.
- Backup/restore cifram os componentes e verificam manifesto assinado. A cópia externa, localização brasileira e agendamento dependem da infraestrutura autorizada. RPO de uma hora/RTO de quatro horas são metas; um ensaio descartável não qualifica recuperação operacional.
- Manutenção exige agendamento externo e alerta. Intervalo de execução acrescenta latência ao expurgo; provar o prazo máximo real antes de ativar retenção contratual. Backups têm retenção separada de sete dias.

## Evidência aceitável

Para cada execução, registrar data, branch, SHA, alterações locais/manifesto, versões, digests finais, comando, código de saída, resultados e recursos isolados. Em `.qualification/`, compartilhar somente relatórios/manifestos sanitizados revisados, nunca ambiente, certificados privados, credenciais ou conteúdo. SBOM e scanner devem corresponder às imagens efetivamente testadas. Uma imagem fixada por digest e um build concluído não demonstram operação segura sozinhos.

Falha anterior permanece falha histórica: execução posterior aprovada não comprova causa nem apaga limite. Distinguir cenário não executado, cenário aprovado, hipótese e reprodução. Não converter gate faltante, teste parcial ou workflow não publicado em PASS. Ensaios de perda de Redis, falhas de envio/commit, quotas, 1.000 mensagens, DSN e restore exigem resultado próprio verificável.

Critérios completos estão em [acceptance.md](acceptance.md). As [evidências consolidadas](evidence.md) vinculam o candidato testado às imagens e registram os requisitos ainda sem prova. O handoff descreve contratos futuros e não autoriza ativação operacional. Ausência de domínio/provedor/autorização não autoriza ativação; também não substitui execução do trabalho local que possa ser verificado.
