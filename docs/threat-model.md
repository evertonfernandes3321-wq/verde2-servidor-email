# Modelo de ameaças e decisões

## Fronteiras

O cliente HTTP e o cliente SMTP são não confiáveis. A credencial determina tenant, aplicação, ambiente e finalidade. O corpo enviado pelo cliente não escolhe tenant. Administração possui identidade própria e nenhuma permissão automática de envio. Os endpoints internos não são publicados pelo Compose.

PostgreSQL é autoridade sobre mensagem, idempotência, reserva, tentativa, lease, outbox e evento. Redis contém apenas identificadores e pode ser reconstruído. Postfix é autoridade de entrega após aceite local. Uma resposta HTTP 202 comprova persistência/admissão; um SMTP 250 remoto comprova somente aceitação pelo servidor remoto.

## Ameaças e controles a qualificar

| Ameaça | Controle | Prova necessária |
|---|---|---|
| Leitura ou alteração entre tenants | Credencial resolve tenant; filtros e relacionamentos compostos | A/B em templates, mensagens, logs, stats, reservas e retries |
| Chave de envio usada como admin | Principais separados, scopes explícitos, credenciais expiradas/revogadas | 401/403 sem mudanças |
| Relay anônimo ou falsificação de remetente | 587 STARTTLS+SASL, milter antes DKIM, um From/RCPT, remetente/Reply-To autorizados | Sessões SMTP positivas e negativas com MTA real |
| Replay, corrida e rotação burlando quota | Reserva e idempotência na mesma TX; quota tenant/serviço com trava | Concorrência HTTP/SMTP/rotação e abortos |
| Reenvio após crash ou falha de métricas | Lease persistente; resultado incerto sem retry automático; reconciliação MTA | Injeção antes/depois da submissão e confirmação |
| Envio sem controles durante indisponibilidade | Banco/policy/signer indisponíveis produzem falha temporária | Falhas controladas antes do aceite |
| DSN forjada altera entrega/supressão | Correlação e origem qualificada; entrada restrita; dedupe de eventos | DSN inválida/duplicada; reputação não suprime destinatário |
| SSRF, anexos e templates perigosos | Conteúdo direto limitado, sem attachments/includes remotos, renderização estrita | URLs não buscadas, variáveis obrigatórias e erros sem envio |
| Roubo por logs, volumes ou backup | Logs sem corpos/links/endereço completo; conteúdo cifrado; spool/backups em armazenamento cifrado | Canários, expurgo, montagem/restore qualificados |
| Restore reativa fila antiga | Gate explícito; expiração e reconciliação antes de workers/Postfix | Restore em recursos descartáveis |

## Semântica de resultado incerto

EOM do milter é anterior ao aceite definitivo do Postfix e à conclusão do signer. Reserva obtida nessa fase permanece pendente quando não existe evidência segura de rejeição/aborto. Uma desconexão ou crash depois da submissão não autoriza retry. Message-ID estável facilita correlação e não garante deduplicação pelo destinatário.

Revogação bloqueia novas admissões e mensagens ainda não submetidas. Mensagens já aceitas pelo MTA exigem reconciliação/ação operacional; não podem ser recolhidas de caixas remotas.

## Limites operacionais

Restrição de rede de produção, discos cifrados, certificados públicos e sua renovação, PTR/porta25, backup segregado e recuperação RPO/RTO não podem ser comprovados apenas por configuração ou teste unitário. Cada prova exige observação no ambiente correspondente. Um bind local não substitui firewall e allowlists na implantação.
