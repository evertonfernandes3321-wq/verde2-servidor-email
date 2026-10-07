# Hospedagem, DNS e liberação operacional

Não há contratação, DNS ou implantação autorizados nesta etapa local. Referência inicial: VM separada da aplicação, 2 vCPU, 4 GB RAM e 40 GB. Dimensionamento depende de teste medido, incluindo banco, spool, observabilidade, backups e margem de disco; não é promessa de capacidade.

## Evidências exigidas do provedor

| Requisito | Comprovação a obter antes de contratar/publicar |
| --- | --- |
| Localização | computação, volumes e backups fisicamente no Brasil |
| IPv4/IP público | estático; custo e condições de troca documentados |
| PTR | configurável pelo cliente/provedor para o FQDN escolhido |
| MTA | permissão contratual de operar servidor próprio de e-mail |
| TCP 25 saída | acesso oficial permitido aos MX externos, sem contorno de bloqueio |
| TCP 25 entrada | alcance para DSN nos endereços de retorno reservados |
| TCP 587 | alcance somente dos consumidores autorizados |
| Armazenamento | cifragem verificável de volumes, temporários e backups |
| Recuperação | destino fora da VM, credenciais segregadas, restauração ensaiável |
| Operação | alertas, renovação de certificados e responsável nomeado |

Solicitar cotação em reais com impostos, IP, volume, backup externo, tráfego, suporte, retenção e eventual cobrança de snapshots. Apresentar ao proprietário; não contratar automaticamente. Hospedagem no Brasil não significa que caixas dos destinatários estejam no Brasil.

O plano registra bloqueio padrão de saída TCP 25 na Magalu. Consultar a [documentação oficial de rede](https://docs.magalu.cloud/docs/network/additional-explanations/best-practices/) e obter solução oficial comprovada para a conta/região antes de escolhê-la. Sem solução comprovada, pesquisar provedor brasileiro alternativo e submeter cotação; não criar túnel para contornar restrição. Informação comercial e de rede precisa ser reconfirmada na contratação.

## Plano de DNS

Definir valores reais antes de aplicar registros. Nomes abaixo descrevem funções, não são registros já publicados.

| Registro | Requisito |
| --- | --- |
| `A` do `MAIL_HOSTNAME` | IP estático da VM; coerente com HELO e certificado |
| `PTR` do IP | retorna `MAIL_HOSTNAME`, que deve resolver de volta ao IP |
| MX de `BOUNCE_DOMAIN` | aponta para `MAIL_HOSTNAME`, porta 25 alcançável |
| SPF do domínio de envelope | autoriza somente as origens reais aprovadas; incluir domínio de retorno |
| DKIM | `DKIM_SELECTOR._domainkey.EMAIL_DOMAIN`, chave pública RSA 2048 do signer |
| DMARC | `_dmarc.EMAIL_DOMAIN`, alinhamento e política aprovados, destino de relatórios controlado |

`BOUNCE_DOMAIN` deve ser diferente de `EMAIL_DOMAIN`. Endereços reservados `b+<id>@BOUNCE_DOMAIN` são criados/correlacionados pelo serviço; não são caixas pessoais. O caminho DSN exige envelope remetente vazio e destinatário reservado conhecido. Internet não recebe caminho de assinatura como aplicação.

A implantação atual assina um `EMAIL_DOMAIN`; remetentes autorizados dos tenants devem pertencer a ele. Não anunciar suporte operacional a vários domínios de assinatura sem mudança e qualificação específicas. Não publicar AAAA até comprovar saída, PTR e política equivalentes para IPv6. SPF não se constrói copiando um IP de exemplo; verificar cadeia e evitar múltiplos registros SPF conflitantes. Planejar evolução da política DMARC com observações reais, evitando mudança destrutiva sem autorização.

## Rede e liberação

API precisa de HTTPS e allowlist dos servidores consumidores/administração; definir proxy e confiança explícita. SMTP 587 exige STARTTLS/SASL inclusive dentro do Docker. SMTP 25 permite somente retornos previstos, sem relay externo. PostgreSQL, Redis, API interna e milters não são publicados. O Compose começa com portas em loopback; exposição externa e firewall fazem parte da etapa autorizada.

Antes de liberar: provar cifragem, backup/restore e metas medidas; renovar certificado em ensaio; validar PTR/HELO/A e DNS; testar bloqueio de relay, remetentes e credenciais inválidas; provar indisponibilidade de política/signature como falha temporária. Não remover gates de armazenamento/restauração para iniciar serviços.

Depois, com autorização e caixas controladas, enviar pelo Keycloak real e API, conferir SPF/DKIM/DMARC nos cabeçalhos recebidos, registrar aceitação remota separada de recebimento observado, atraso/rejeição e latência. Confirmar recusa de links vencidos/utilizados no serviço de identidade. Não prometer caixa de entrada universal nem criptografia ponta a ponta: TLS de submission e TLS aos MX são políticas diferentes.

Entregar ao proprietário custos, provedores/regiões, DNS proposto, responsáveis, relatório de recuperação e resultados externos. Só aceite operacional explícito autoriza o aplicativo a depender do Verde2.
