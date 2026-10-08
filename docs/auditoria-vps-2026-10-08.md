# Revisão da VPS Verde2 — 08/10/2026

Registro histórico da inspeção anterior à correção. O estado posterior e as
alterações autorizadas estão em [operação da VPS](operacao-vps-2026-10-08.md).

Resultado: **SSH funcional; preparação da base incompleta; Verde2 não implantado;
aceite operacional bloqueado.** Inspeção por `ssh verde2`, com comandos de
consulta e leitura sanitizada de configuração. Nenhum arquivo, pacote,
serviço, firewall ou DNS da VPS foi alterado durante esta revisão. Nenhum
e-mail foi enviado. Senhas, chaves privadas, histórico de comandos e conteúdo
de aplicações não foram coletados.

## Escopo e procedência

- VPS: `177.153.67.99`, usuário `verde2admin`, acesso por chave já validado.
- Ubuntu 24.04.5 LTS; 2 vCPU; disco raiz de 76,5 GiB, com 67,7 GiB livres na
  leitura das 19:34 UTC. Isso não é teste de capacidade de envio.
- Checkout: `feat/verde2-production-mail`, HEAD
  `f9b31c2456c05515d17b424ee5491240e2099b01`. Fontes versionadas sem alterações;
  `ops/` contém a preparação local ainda não commitada. Esta revisão acrescenta
  somente este relatório local.
- Domínio escolhido pelo proprietário: `interati-app.com.br`. Nenhuma
  configuração de produção ou registro DNS foi publicado em consequência.

## Achados verificáveis

| Componente | Evidência | Implicação |
|---|---|---|
| SSH | Login por chave funciona; root, senha e autenticação interativa desabilitados; `AllowUsers verde2admin`; chave autorizada modo `0600`, com `from="170.238.162.239/32"`. | A proteção por chave e IP está preservada. |
| Sudo | Arquivo administrativo modo `0440`; `visudo --check` passou; consultas com `sudo -n` funcionam. | Administração disponível sem habilitar senha SSH. |
| Bootstrap | `/usr/local/sbin/verde2-bootstrap-host` tem **284 bytes, 10 linhas e modo `0600`**. Não contém instalação de Docker, ativação de UFW ou gravação do marcador de conclusão. O arquivo completo local tem 2.003 bytes nesta revisão. | O arquivo instalado não corresponde ao bootstrap completo entregue. A causa de sua substituição/encurtamento não foi determinada. |
| Docker/Compose | Ambos ausentes; repositório APT `docker.sources` ausente. | Nenhuma stack Verde2 pode ser iniciada ainda. |
| Diretórios | `/opt/verde2` e `/srv/verde2` ausentes; marcador `BASE_READY_MAIL_NOT_DEPLOYED` ausente. | A preparação não foi concluída. Não criar marcador para forçar aprovação. |
| UFW | Ativo; permite **22, 80 e 443 de qualquer origem**, em IPv4 e IPv6. | A regra de rede do SSH descumpre a restrição de origem solicitada, embora a opção `from=` da chave impeça seu uso de outros IPs. Portas web foram abertas antes de definir a exposição operacional. |
| Política Docker | `verde2-network-guard.service` desabilitado/inativo; chains `VERDE2-BASE` e hooks `DOCKER-USER` ausentes em IPv4/IPv6. | A política deve ser instalada e verificada antes de iniciar Docker ou publicar containers. |
| Configuração Docker | JSON válido com driver `json-file` e limites `10m`/`3`. Configuração explícita de backend/firewall não presente. | A rotação dos logs está definida; o conjunto de controles do bootstrap ainda precisa ser conferido antes do daemon iniciar. Ausência de opção explícita não prova que seu default seria inseguro. |
| Caddy | Versão 2.11.7, ativo. Runtime HTTP em `:80`, com `file_server`; sem domínio escolhido, proxy da API ou aplicação TLS na configuração ativa. | Está servindo HTTP genérico; não há HTTPS/API do Verde2 configurados. |
| Caddy persistido | `/etc/caddy/Caddyfile` tem apenas **2 bytes**, sem sites/proxies identificados; runtime ainda contém um servidor HTTP. | A configuração em disco difere da configuração ativa. Preparar configuração válida antes de reload/restart. |
| Administração Caddy | Listener `127.0.0.1:2019`. | A interface administrativa não está publicada nas interfaces externas. |
| Cloud-init | Agora `done`, com `extended_status: degraded done`, zero erros e avisos recuperáveis. Na inspeção anterior havia `cloud-final` failed. | O status atual não certifica instalação de Docker nem conclusão do bootstrap. Não foi demonstrado qual alteração causou a mudança de status. |
| Pacotes | `dpkg --audit` sem pendências; nenhum processo `apt`, `apt-get` ou `dpkg` encontrado no instante da consulta. | Não há evidência atual de instalação de pacotes interrompida. |
| SMTP/API | Nenhum listener 25, 587 ou 3000; Node no host e Postfix ausentes nas consultas efetuadas. | Serviço de e-mail e API ainda não estão disponíveis. Node 24 da aplicação será fornecido pelas imagens qualificadas; rotinas operacionais do host precisam de preparação própria. |

Não foi reiniciado nenhum serviço para testar a configuração em disco. A
revisão de Caddy usou somente estrutura da configuração administrativa local;
valores de configuração sensíveis não foram expostos.

## DNS observado

Consultas públicas ao resolvedor `1.1.1.1`:

- Nenhum endereço A/AAAA retornado para `interati-app.com.br`,
  `mail.interati-app.com.br`, `mail-api.interati-app.com.br` e
  `bounce.interati-app.com.br` nas consultas realizadas.
- O domínio raiz publica **MX `0 .` (Null MX)**, SPF com mecanismo final
  **`-all`** e DMARC **`p=reject`**. Valores TXT completos e endereços de
  relatórios não foram registrados.

Null MX anuncia que o domínio não aceita correio. A
[RFC 7505, seção 4.2](https://datatracker.ietf.org/doc/html/rfc7505#section-4.2)
também recomenda não usá-lo em domínios empregados no envelope ou no cabeçalho
From, pois isso pode levar à rejeição de mensagens. Essas políticas existentes
precisam de decisão explícita antes de ativar envio.

Uma opção a avaliar é preservar a política do domínio raiz e usar um
subdomínio dedicado, como `notificacoes.interati-app.com.br`, para remetentes e
assinatura. Hostname SMTP, endpoint HTTPS e domínio de retorno seriam
definidos separadamente. Isso é uma proposta: nenhum desses registros,
certificados ou remetentes foi criado, e não se deve substituir o MX raiz
automaticamente.

## CI e software

A execução remota
[37819568144](https://github.com/evertonfernandes3321-wq/verde2-servidor-email/actions/runs/37819568144),
no mesmo HEAD, está **completed/failure**:

- `History secrets gate`: success.
- `Serialized lint, contracts, migrations, builds, transport and recovery`:
  success.
- `Dependency and image gates with SBOM`: failure.
- `Sanitized evidence only`: failure.

Foram consultados metadados das etapas, não logs brutos ou artefatos potencialmente
sensíveis. A causa específica de cada falha da CI não foi determinada nesta
revisão. Não atribuir automaticamente ambas às vulnerabilidades históricas.
O [relatório de qualificação local](evidence.md) registra PASS funcional e FAIL
de segurança, com 17 CVEs únicos HIGH no scan documentado. Não foi repetido
esse scan nesta auditoria da VPS.

## Sequência de correção proposta

1. Preservar uma cópia restrita das configurações atuais e registrar sua
   procedência. Adotar o usuário já existente; **não repetir cegamente o script
   de primeiro boot**, que recusa usuário/Docker existentes.
2. Substituir o bootstrap incompleto pelo conteúdo completo revisado e conferir
   os arquivos auxiliares. Restringir SSH no firewall ao IP escolhido antes de
   remover regras amplas; manter uma sessão e testar uma segunda conexão para
   evitar perda de acesso. Decidir a necessidade de exposição web.
3. Instalar e testar a política IPv4/IPv6 antes do daemon Docker; instalar
   Docker/Compose pelo repositório oficial; conferir versões e ausência de
   containers de aplicação. O serviço de e-mail continua pausado.
4. Preparar uma configuração Caddy coerente em disco, validá-la e só então
   aplicar uma alteração operacional aprovada. Certificados públicos dependem
   do hostname e do DNS previamente qualificados.
5. Resolver os gates de segurança/CI e definir DNS/remetentes/retorno sem
   sobrescrever políticas existentes silenciosamente. Qualificar provedor,
   PTR, portas 25, cifragem, backups, restauração, retenção e responsável.
6. Implantação do Verde2 e testes externos somente na etapa operacional
   autorizada. Não iniciar a composição inteira nem criar marcadores de
   armazenamento/restauração sem as respectivas provas.

Esta sequência é reviewável, mas **não foi aplicada à VPS** nesta tarefa de
verificação. Não é necessário pressupor outra formatação para corrigir a base;
é necessário planejar a adoção do estado existente.

## Estado da entrega

| Área | Estado |
|---|---|
| Implementação local | Código transacional existente; qualificação funcional histórica PASS; segurança local documentada FAIL. |
| CI | FAIL nos gates de dependências/imagens e na etapa de evidência sanitizada; etapa funcional success. |
| Infraestrutura | VPS reinstalada e SSH funcional; base incompleta; configuração operacional pendente. |
| Entrega real | Não testada; nenhum envio efetuado nesta revisão. |
| Aceite operacional | Bloqueado por segurança/CI, base incompleta e provas operacionais/externas ausentes. |

Limites: não foi demonstrada cifragem do volume raiz nem de futuros volumes,
temporários/swap e backups; não foram qualificados localização física,
permissão contratual de MTA, saída/entrada 25, PTR final, restauração ou metas
RPO/RTO. O mount ext4 em `/dev/xvda4` não permite concluir se existe cifragem
transparente no provedor. Não há promessa de capacidade ou entregabilidade.
