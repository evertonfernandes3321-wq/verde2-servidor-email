# Cloud-init para preparar a VPS Verde2

Imagem alvo: **Ubuntu 24.04 LTS**, com cloud-init habilitado pelo provedor. Este
procedimento prepara uma VPS nova; não instala nem libera o serviço de e-mail.
O IP informado da VPS é `177.153.67.99`; confirme se ele será preservado após
a reinstalação. Este documento não autoriza formatar uma máquina existente.

## Antes da formatação

1. Preserve e teste backups dos bancos, volumes, configurações e segredos das
   aplicações existentes. A inspeção anterior encontrou CARIAD e prontuário
   nessa VPS. Armazene os backups fora dela, com acesso restrito e cifragem.
2. Confirme que o provedor aceita **user-data/cloud-init** na reinstalação e
   oferece console de recuperação. Se não oferecer user-data, não cole o YAML
   no terminal como se fosse um script shell.
3. Confirme o IP público de origem para SSH. Um IP dinâmico pode mudar; VPN ou
   conexão móvel podem apresentar outro endereço. Preserve acesso ao console
   do provedor para recuperar a allowlist sem abrir SSH para toda a Internet.
4. Use somente a chave **pública** ao gerar user-data. Nunca envie a privada ao
   provedor, ao Git ou ao chat. A chave pública nova foi gerada localmente no
   computador do proprietário; o arquivo personalizado não é versionado.

## Gerar o arquivo completo

O gerador usa Python 3 e sua biblioteca padrão. Exemplo em PowerShell, com o
IP público observado na preparação; confirme esse IP antes de usar:

```powershell
python ops/cloud-init/render.py `
  --public-key C:\Users\evert\.ssh\id_ed25519_verde2_20261008.pub `
  --ssh-cidr 170.238.162.239/32 `
  --output .qualification/cloud-init/verde2-ubuntu24-confirmado.user-data.yaml
```

O gerador não sobrescreve arquivos existentes. Para regenerar, escolha outro
nome de saída. É possível repetir `--ssh-cidr` para IPs públicos adicionais
explicitamente autorizados; nenhuma faixa irrestrita é aceita. A allowlist
também fica na opção `from=` da chave autorizada, protegendo o acesso durante
a instalação inicial dos pacotes, antes da ativação do firewall.

Cole **todo o arquivo gerado**, começando por `#cloud-config`, no campo
user-data/cloud-init ao criar ou reinstalar a VPS. Não use o `.yaml.in`, que é
apenas um template. O provedor pode armazenar user-data: este arquivo contém
somente a chave pública, o IP autorizado e configuração de bootstrap.

Se o painel apresenta um campo genérico **script de inicialização**, use a
versão Bash completa, que começa com `#!/bin/bash`. Essa versão também pode
ser consumida como [user-script por cloud-init](https://docs.cloud-init.io/en/latest/explanation/format/user-data-script.html).
Cole seu conteúdo diretamente
no campo durante a criação/reinstalação da VPS; não cole YAML como comandos
shell nem execute esse bootstrap na VPS antiga com aplicações ativas.

```powershell
python ops/cloud-init/render.py --format shell `
  --public-key C:\Users\evert\.ssh\id_ed25519_verde2_20261008.pub `
  --ssh-cidr 170.238.162.239/32 `
  --output .qualification/cloud-init/verde2-ubuntu24-inicializacao-validado.sh
```

A versão Bash cria o usuário e instala a chave explicitamente, antes da
configuração da base. Recusa execução se já existir Docker ou o usuário/grupo
`verde2admin`, para proteger instalações existentes. Falha parcial exige
diagnóstico pelo console, pois a repetição automática pode encontrar o usuário
já criado. O SSH é iniciado/reiniciado explicitamente: uma imagem com somente
`ssh.socket` ativo não depende de um serviço SSH previamente iniciado.

A versão Bash foi validada em Ubuntu 24.04 descartável: sintaxe, criação do
usuário com senha bloqueada, chave e permissões, sudoers, configuração SSH e
recusa de repetição quando o usuário já existe passaram. Os arquivos
materializados corresponderam à versão YAML revisada. A instalação completa
de pacotes, o boot da VPS e o formato específico do campo do provedor ainda
dependem de conferência. Evidência: `.qualification/cloud-init/validation-shell.json`.

## O que fica preparado

- Usuário `verde2admin`, com sudo, autenticação apenas por chave e senha
  bloqueada. Login root por SSH é desabilitado. Não há senha padrão.
- SSH na porta 22 somente das origens escolhidas, com limitação de conexões.
  Encaminhamento de portas, agente SSH e X11 por essa chave são desabilitados.
- Docker e Compose pelo repositório APT oficial do Docker, com assinatura
  verificada pelo APT. Versões efetivamente instaladas são registradas no host;
  o bootstrap não fixa nem qualifica imagens da aplicação.
- UFW bloqueia novas conexões de entrada e saída SMTP do host nas portas
  25/465/587/2525. Regras IPv4/IPv6 em `DOCKER-USER` bloqueiam novas conexões
  externas para containers e a saída SMTP deles. A política é instalada antes
  de iniciar Docker e reaplicada antes de cada início do daemon. Falha da
  política impede sua partida. Serviços de aplicação não são iniciados.
- Atualizações de segurança do Ubuntu, sem reinicialização automática.
  Diretórios `/opt/verde2` e `/srv/verde2`, sem conteúdo de mensagens ou segredos.

O [Docker alerta que portas publicadas podem contornar UFW](https://docs.docker.com/engine/install/ubuntu/).
A política adicional usa o caminho documentado em
[DOCKER-USER](https://docs.docker.com/engine/network/firewall-iptables/).
Não desative essa política para publicar o serviço. A liberação futura exige
regras específicas de API, submission, DSN e saída do MTA, mantendo banco,
Redis, milters e autorização internos privados.

## Primeiro acesso e conferência

Depois da reinstalação, confira o fingerprint SSH novo pelo console do provedor
com `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` e compare-o com o
fingerprint apresentado no primeiro acesso.
Se a entrada antiga conflitar, remova **somente a entrada dessa VPS**, depois
da conferência; não desative a validação de host:

```powershell
ssh-keygen -R 177.153.67.99
ssh -i C:\Users\evert\.ssh\id_ed25519_verde2_20261008 verde2admin@177.153.67.99
```

A chave privada nova foi criada sem passphrase para permitir provisionamento,
com ACL restrita ao usuário local. Para adicionar uma passphrase, execute
localmente `ssh-keygen -p -f C:\Users\evert\.ssh\id_ed25519_verde2_20261008` e
informe-a no terminal; não compartilhe essa passphrase. Preserve uma cópia
segura da chave privada para evitar perda de acesso.

O arquivo gerado deve passar por `cloud-init schema --config-file ARQUIVO` em
Ubuntu 24.04 com cloud-init instalado. Isso valida o contrato de configuração;
a inicialização completa depende da imagem e da integração do provedor.

Na preparação local de 08/10/2026, o arquivo personalizado passou no schema de
cloud-init `26.1-0ubuntu1~24.04.1`, em `bash -n`, no parser de chave e na
configuração efetiva do OpenSSH. As unidades systemd passaram na verificação
estática. Em container Ubuntu descartável, sem rede externa e com namespace
próprio, a política instalou regras IPv4/IPv6, recusou ausência de interface
padrão e foi reaplicada sem duplicação. Esses testes não executaram o bootstrap
completo, a instalação do Docker nem o boot de uma VM; não constituem prova
de conectividade externa ou qualificação do provedor. As evidências locais
ficam em `.qualification/cloud-init/validation.json`.

Na VPS nova:

```sh
sudo cloud-init status --wait --long
sudo cat /var/lib/verde2-bootstrap/status
sudo cat /var/lib/verde2-bootstrap/versions.txt
sudo ufw status verbose
sudo iptables -S VERDE2-BASE
sudo ip6tables -S VERDE2-BASE
sudo systemctl status verde2-network-guard docker --no-pager
sudo docker compose version
```

O status esperado é `BASE_READY_MAIL_NOT_DEPLOYED`. Ausência desse arquivo ou
erro no cloud-init significa bootstrap incompleto. Examine os erros pelo
console; não transforme falhas em aprovação. Atualização de kernel pode
exigir reinício manual posterior. Faça nova conferência de SSH e firewall
depois dele. Logs de cloud-init podem revelar IP e chave pública: evite
compartilhar logs completos ou introduzir segredos em user-data.

## Etapa seguinte: serviço de e-mail

O proprietário escolheu `interati-app.com.br`. Em 08/10/2026, foi publicado
`mail.interati-app.com.br A 177.153.67.99`, sem proxy, exclusivamente para o
Verde2. O domínio raiz conserva Null MX, SPF `-all` e DMARC `p=reject`.
O desenho usa `notificacoes.interati-app.com.br` para remetentes e assinatura
e `bounce.interati-app.com.br` para retornos. Esses dois subdomínios ainda
dependem da implantação qualificada e das políticas DNS correspondentes.
PTR, portas 25 e permissão contratual de MTA dependem da Locaweb.

Antes de instalar o Verde2, resolver os achados HIGH das imagens e obter
aprovação nos gates do candidato; comprovar volumes/temporários/swap e backups
cifrados, retenção, restauração e armazenamento no Brasil; preparar
certificados válidos e segredos no cofre. Este cloud-init **não** implementa
cifragem de disco, backup, DNS, TLS de e-mail, DKIM, Node 24 no host ou
recuperação. A aplicação usa Node 24 nas suas imagens; rotinas operacionais
que exigem Node no host precisarão dessa instalação qualificada.

Siga o [runbook](../../docs/runbook.md) e os
[requisitos de hospedagem/DNS](../../docs/hosting-dns.md). Clone/acesso a
repositório privado, instalação da aplicação, liberação de portas, publicação
de DNS e envios externos continuam etapas distintas. Apenas provas externas
autorizadas de API, Keycloak, SPF/DKIM/DMARC e recebimento permitem aceite
operacional. Não inicie a composição inteira com esse bootstrap.

## Adoção da VPS existente de 08/10/2026

`adopt-host.sh` e `finish-adoption.sh` são específicos para o estado inspecionado
da VPS `177.153.67.99`, Ubuntu 24.04, usuário `verde2admin`, IP administrativo
`170.238.162.239/32`, sem Docker e sem dados de aplicação. Não substituem o
bootstrap de primeiro boot nem servem para adoção genérica de servidores.
O primeiro verifica o estado conhecido, preserva configurações em diretório
root `0700`, agenda rollback do firewall em três minutos e restringe a rede.
O segundo deve executar por uma **nova conexão SSH verificada**, cancela o
rollback e instala Docker/Compose pelo repositório oficial, conferindo a
impressão digital da chave pública APT. Ambos recusam precondições divergentes.

Esses scripts já foram executados nesta VPS. Não os repita: a segunda execução
da adoção deve recusar o Docker existente. Para futuras alterações, inspecione
novamente o estado e prepare uma mudança específica com rollback.

```powershell
ssh verde2 'sudo -n cat /var/lib/verde2-bootstrap/status'
ssh verde2 'sudo -n ufw status numbered'
ssh verde2 'sudo -n docker compose version'
```

Resultado real: Docker `29.8.2`, Compose `5.6.0`, guard habilitado/ativo, SSH
restrito ao IP autorizado, portas web fechadas e saída SMTP bloqueada durante
a preparação. Uma porta Docker publicada temporariamente respondeu em
loopback, foi bloqueada no acesso externo e incrementou o contador DROP; o
container de teste foi removido. IPv6 teve instalação de regras conferida,
sem ensaio de conectividade externa IPv6. Reboot completo não foi ensaiado.

O marcador `BASE_READY_MAIL_NOT_DEPLOYED` atesta somente os checks de base
executados pelo script. Não comprova cifragem, backup, TLS, entrega ou produção.
Veja o [registro da correção e bloqueios](../../docs/operacao-vps-2026-10-08.md).
