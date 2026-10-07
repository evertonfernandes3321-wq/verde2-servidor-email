# Handoff ao backend e Keycloak

Status: contrato local; integração externa depende de implantação autorizada e homologação. Não configurar dependência obrigatória do aplicativo antes dessas provas. Hostname SMTP, URL HTTPS, remetentes e referências do cofre serão fornecidos na entrega operacional; não há endpoint público qualificado nesta fase.

## Identidade

Criar um tenant por aplicação e ambiente. Homologação e produção usam tenants diferentes. Não enviar tenant livre no pedido: a credencial identifica o tenant. Várias chaves compartilham as quotas.

O operador entrega referências do cofre separadas para chave HTTP e usuário/senha SMTP. Credencial administrativa não deve estar no backend consumidor e não envia e-mail. HTTP inicia com `send:template`; solicitar explicitamente `send:raw`, `logs:read`, `stats:read` ou `templates:manage`. Consulta de mensagem exige `logs:read`.

Emissão retorna segredo uma vez: armazená-lo diretamente no cofre, sem console ou logs de resposta. Chaves expiram. Rotação não reinicia quota. Revogação impede novas admissões e mensagens ainda não submetidas; não recolhe mensagem já aceita pelo MTA.

## SMTP do Keycloak

| Campo | Configuração operacional |
| --- | --- |
| Host | FQDN entregue pelo operador e validado pelo certificado |
| Porta | `587` |
| STARTTLS | obrigatório |
| SSL implícito | não substituir STARTTLS por SSL implícito na porta 587 |
| Autenticação | obrigatória; credencial SMTP do tenant, finalidade `keycloak` |
| From | endereço explicitamente autorizado |
| Reply-To | ausente ou autorizado para essa finalidade |
| Truststore | cadeia válida; nunca desabilitar validação |

Worker da API usa credencial SMTP separada, finalidade `worker`. Chave Bearer não é senha SMTP. Exatamente um `From`, um destinatário e nenhum anexo. Não fabricar cabeçalhos `X-Verde2-*`, endereços de retorno reservados ou leases. Verde2 controla retorno e correlação.

Defaults compartilhados: 60/minuto e 1.000/dia por tenant, 2.000/dia no serviço, em janelas fixas de minuto e dia civil em UTC. MIME final até 1 MiB; admissão reserva margem de 16 KiB para cabeçalhos. Cinco conexões de submission no total limitam conservadoramente cada credencial a cinco. Usar backoff em falhas temporárias.

## HTTP

Consultar [OpenAPI](../api/openapi.json) para schemas e respostas exatos. Usar `Authorization: Bearer` com segredo do cofre, nunca na URL, e `Content-Type: application/json`. Exemplos são sintéticos.

`POST /api/v1/send`, com o cabeçalho `Idempotency-Key` único para a operação:

```json
{
  "to": "destinatario@example.test",
  "templateId": "11111111-1111-4111-8111-111111111111",
  "variables": { "nome": "Pessoa de Teste" }
}
```

Substituir UUID por template existente do tenant; o exemplo não está provisionado. Templates declaram variáveis permitidas/obrigatórias. Ausência de template, variável inválida ou erro de renderização impede envio. Conteúdo renderizado fica imutável na admissão, inclusive nos retries.

`POST /api/v1/send/raw`, somente com `send:raw`, com chave de idempotência própria:

```json
{
  "to": "destinatario@example.test",
  "from": "avisos@example.test",
  "subject": "Aviso de teste",
  "text": "Mensagem sintética."
}
```

`from` e `replyTo` precisam de autorização; domínios dos destinatários externos continuam permitidos. Não há anexos, CC ou BCC. Não há busca de arquivos, URLs ou inclusões remotas na renderização.

`202` retorna `id` e `state`. Guardar o ID com o evento de negócio. Em timeout HTTP, repetir exatamente o pedido com a mesma chave: deduplicação dura 30 dias e é compartilhada pelas chaves do tenant. Mesmo identificador com conteúdo diferente recebe `409`. Após 30 dias não há garantia de deduplicação; não reemitir eventos antigos automaticamente nem trocar chave para contornar supressão.

| Resposta | Ação |
| --- | --- |
| `400`/`422` | corrigir contrato, conteúdo ou variáveis |
| `401`/`403` | verificar validade, revogação e permissão no cofre/operador |
| `404` | verificar recurso e tenant; não usar template alternativo silenciosamente |
| `409` | reconciliar idempotência ou regra de estado |
| `413` | reduzir conteúdo; limite considera MIME final |
| `429`/`503` | backoff e jitter, preservando a chave do mesmo evento |
| `500` ou timeout | admissão pode ser incerta; repetir com mesma chave |

Consultar `GET /api/v1/messages/{id}` com permissão de leitura. `/logs` e `/stats` também são isolados por tenant. Não há corpo ou tokens nas consultas de acompanhamento.

| Estado | Significado |
| --- | --- |
| `queued` | persistida, aguardando submissão |
| `in_flight` | tentativa com lease |
| `accepted_local` | Postfix aceitou; retries externos são do MTA |
| `deferred` | entrega externa adiada |
| `accepted_remote` | servidor remoto aceitou SMTP; recebimento humano não demonstrado |
| `failed_permanent` | falha permanente registrada |
| `expired` | prazo encerrado |
| `outcome_unknown` | confirmação insuficiente; reconciliar antes de qualquer reenvio |

Não reenviar automaticamente `outcome_unknown`. `Message-ID` estável auxilia correlação, mas não garante deduplicação no destinatário. DSN não qualificado não prova rejeição; supressão definitiva exige evidência qualificada de endereço inválido.

## Homologação pendente

Após autorização, testar confirmação de cadastro e recuperação de senha no Keycloak real; template e raw; SPF/DKIM/DMARC nos cabeçalhos; aceitação remota e recebimento observado; atraso, rejeição e latência. Verificar no serviço de identidade que links vencidos ou usados são recusados. Verde2 não implementa a validade desses links.

Entregar referência do relatório, versão/imagens, hostname, quotas aprovadas, remetentes, responsáveis e referências de credenciais. Somente aprovação externa habilita dependência do aplicativo.
