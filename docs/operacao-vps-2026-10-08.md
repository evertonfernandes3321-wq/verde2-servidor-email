# Correção da base Verde2 — 08/10/2026

A base da VPS foi corrigida. **O SMTP e a API ainda não foram implantados;
nenhum e-mail externo foi enviado.** Esta entrega não libera o aplicativo
para depender do Verde2. A
[auditoria anterior](auditoria-vps-2026-10-08.md) permanece como baseline.

## Escopo e alterações reais

Autorização do proprietário: corrigir a VPS e entregar SMTP funcionando;
domínio `interati-app.com.br`, provedor Locaweb, consumidores inicialmente
limitados a `170.238.162.239/32`, teste em caixa do proprietário e backups
cifrados no computador local. O produto/plano da Locaweb ainda não foi
identificado. A implementação foi retomada em
`feat/verde2-production-mail`, sobre o SHA
`f9b31c2456c05515d17b424ee5491240e2099b01`, preservando fontes existentes,
configurações locais ignoradas e histórico Git/GPG.

Na VPS Ubuntu 24.04.5:

- Configurações anteriores preservadas em diretório root `0700`, cuja
  referência fica em `/var/lib/verde2-bootstrap/adoption-backup`.
- Bootstrap completo instalado sem recriar usuário nem repetir primeiro boot.
  Rollback temporizado protegeu a mudança de firewall; foi cancelado somente
  após uma nova conexão SSH autenticada com validação de host.
- UFW restringe SSH ao IP autorizado. Regras amplas de 22/80/443 removidas;
  saída SMTP de processos do host bloqueada durante a preparação. Senhas/root
  SSH continuam desabilitados.
- Guard Docker ativo/habilitado, com hooks IPv4/IPv6 em `DOCKER-USER` e
  restrições WAN. Não há exceção de envio para o MTA nesta fase.
- Docker Engine `29.8.2`, Compose `5.6.0`, Buildx `0.38.0` e containerd `2.3.6`
  instalados pelo repositório oficial, com verificação da chave pública APT.
  Driver de logs `local`, rotação `10m`/`3`, backend de firewall `iptables`.
- Caddy `2.11.7` recebeu configuração validada e recarregada, com `bind`
  explícito em `127.0.0.1:8081` e resposta de manutenção HTTP 503. Administração
  em `127.0.0.1:2019`. Isso não é API de produção nem TLS da submission.
- Cloudflare: criado exclusivamente `mail.interati-app.com.br A 177.153.67.99`,
  **Somente DNS**, confirmado também pelo resolvedor público. Políticas do
  domínio raiz e registros dos outros serviços preservados.

A evidência sanitizada de estado, versões e hashes de configuração está em
[operation-vps-20261008.json](evidence/operation-vps-20261008.json).
Nenhum `.env`, chave privada, segredo, corpo de mensagem ou destinatário
completo foi publicado. O snapshot de configuração anterior fica restrito
na VPS; não é o backup externo da aplicação.

## Provas executadas e limites

- Sintaxe Bash dos dois scripts de adoção: PASS no validador Ubuntu isolado.
- Adoção e instalação na VPS real: PASS; `dpkg --audit` sem pendências,
  guard persistido/habilitado e marcador `BASE_READY_MAIL_NOT_DEPLOYED`.
- Nova sessão SSH após restrição de firewall: PASS.
- Porta Docker temporária `18080`: serviço acessível em loopback, conexão
  externa bloqueada e contador DROP incrementado em três pacotes. Container
  removido, nenhum container remanescente. Fixture oficial BusyBox, digest
  `sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092`.
- Regras IPv6 instaladas/conferidas; conectividade externa IPv6 NOT_RUN.
- Caddy: validação/reload e resposta 503 em loopback PASS. A primeira
  configuração de manutenção não produziu o bind esperado; foi corrigida
  com `bind` explícito e o estado efetivo foi conferido. Isso não determina
  a causa da divergência que existia antes da operação.
- DNS A do hostname SMTP confirmado em Cloudflare e `1.1.1.1`: PASS.
- Reboot completo, TLS de submission, renovação, assinatura DKIM nesta VPS,
  cifragem de volumes/swap, backup externo e restauração: NOT_RUN.

## CI: correção local e bloqueio de segurança

A execução anterior
[37819568144](https://github.com/evertonfernandes3321-wq/verde2-servidor-email/actions/runs/37819568144)
terminou em FAIL: etapa funcional e Gitleaks passaram; quatro imagens
(API/Postfix/política/OpenDKIM) falharam no gate; PostgreSQL/Redis passaram.
A publicação também falhou com ausência de arquivos no glob sob
`.qualification`. Foram consultadas linhas específicas e sanitizadas dos
logs, sem baixar logs brutos ou artifacts privados.

O comportamento padrão de
[upload-artifact](https://github.com/actions/upload-artifact#uploading-hidden-files)
exclui arquivos ocultos. A correção exporta somente relatórios reconhecidos
para `artifacts/ci-evidence/`, sem percorrer snapshots, fixtures ou `.private`.
Rejeita symlinks e saída antiga, remove snippets/campos desconhecidos e
mantém os estados FAIL. SBOM exportado conserva componentes, versões,
identificadores de pacote e hashes; relatório de imagem conserva a identidade
qualificada. Nenhum gate obrigatório foi afrouxado.

Seis testes de exportação, scanner, backup cifrado e retenção autenticada:
PASS. Exportação de 15 arquivos reais de evidências anteriores: PASS,
preservando segurança FAIL; isso não é nova qualificação do runtime.
Um ensaio sobre todo o diretório local histórico recusou evidência antiga
com estado não reconhecido; não foi convertida em PASS. A CI usa checkout
limpo e publica a rodada gerada nela. A nova execução remota ainda precisa
ser conferida no SHA publicado, incluindo os artifacts.

O requisito de Debian 13/pacotes oficiais continua vigente. A consulta ao
Debian Security Tracker em 08/10/2026 ainda identifica as versões trixie de
[Python 3.13 / CVE-2026-82049](https://security-tracker.debian.org/tracker/CVE-2026-82049)
e [util-linux / CVE-2026-76642](https://security-tracker.debian.org/tracker/CVE-2026-76642)
como vulneráveis. Nenhum pacote sid foi misturado, CVE ignorado ou resultado
de scan convertido. Corrigir as imagens exige correções compatíveis e novos
scans/builds/provas, ou uma mudança de arquitetura explicitamente definida
antes da implementação.

## Bloqueios operacionais e sequência restante

1. **Locaweb:** confirmar produto/plano, permissão de MTA e liberação oficial
   de saída/entrada TCP 25. Antes das restrições locais desta preparação,
   testes TCP sem dados SMTP para Gmail/Outlook deram timeout. Isso não prova
   sozinho a causa. O PTR público ainda é `vps71371.publiccloud.com.br`;
   solicitar `mail.interati-app.com.br`. O
   [texto para o suporte](solicitacao-locaweb-smtp.md) está pronto e não foi
   enviado. Após liberação, repetir provas por caminho MTA autorizado; a
   preparação mantém também um bloqueio local explícito de saída SMTP.
2. **Imagens e CI:** obter candidato sem falhas no gate obrigatório, repetir
   qualificação e conferir evidências do SHA exato. Não iniciar a stack com
   as quatro imagens reprovadas.
3. **Cifragem e recuperação:** definir/provar volumes cifrados para banco,
   spool, temporários e retornos; swap protegido ou desabilitado. Docker usa
   `/var/lib/docker`; isso não demonstra cifragem. Configurar backups cifrados
   fora da VM no computador local, credenciais segregadas, retenção de sete
   dias e agenda compatível com RPO de uma hora. Ensaiar restore e RTO de
   quatro horas, incluindo indisponibilidade/desligamento do computador.
4. **DNS/TLS e implantação:** publicar SPF/DKIM/DMARC de
   `notificacoes.interati-app.com.br` e retorno em
   `bounce.interati-app.com.br`, certificado público válido para o hostname,
   renovação testada e controles privados. Apenas então provisionar segredos,
   migrar, criar tenants/remetentes/credenciais e liberar dispatch com provas
   reais de armazenamento/restauração. API/submission somente do IP escolhido;
   entrada 25 exclusiva para DSN reservados. Não criar marcadores para forçar
   partida.
5. **Aceite externo:** teste SMTP na caixa do proprietário, API/template/raw,
   Keycloak real, SPF/DKIM/DMARC, eventos de aceitação/rejeição/atraso,
   observação de recebimento e alertas/responsável operacional. A confirmação
   de uma caixa Gmail não substitui as demais provas.

| Área | Estado após esta correção |
|---|---|
| Implementação local | Código anterior preservado; bootstrap/adoção e exportador CI acrescentados; testes locais específicos PASS. |
| CI | Última execução do baseline FAIL; correção do artifact validada localmente, nova execução pendente. Segurança das imagens continua bloqueante. |
| Infraestrutura | Base/SSH/firewall/Docker/Caddy corrigidos, hostname publicado; armazenamento, backup, PTR e portas 25 não qualificados. |
| Entrega real | NOT_RUN; SMTP/API de produção ainda não disponíveis. |
| Aceite operacional | BLOCKED; aplicativo não pode depender do serviço. |
