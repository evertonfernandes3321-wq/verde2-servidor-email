# Solicitação preparada para o proprietário enviar à Locaweb

Este texto não foi enviado. Não inclui credenciais, destinatários de teste
nem conteúdo de mensagens. Confirmar no painel o produto/plano da VPS.

> Preciso qualificar a VPS 177.153.67.99 para operar um MTA próprio de e-mail
> exclusivamente transacional: confirmação de cadastro, recuperação de senha
> e avisos de aplicações. Não será usada para campanhas ou envios em massa.
>
> O hostname será mail.interati-app.com.br, com registro A já apontando para
> esse IP. Solicito confirmação contratual de que o plano permite operar MTA,
> liberação oficial de saída TCP 25 para os MX dos destinatários e entrada
> TCP 25 para retornos de falha. Clientes autenticados usarão STARTTLS em 587,
> inicialmente permitido somente de 170.238.162.239/32. A porta 25 não será
> usada como substituta da submission.
>
> Antes de aplicar restrições locais de preparação, conexões TCP 25 para os
> MX de Gmail e Outlook deram timeout. Confirme se há bloqueio no provedor e
> o procedimento oficial para liberação neste produto/plano. Não preciso de
> túnel ou desvio desse bloqueio.
>
> Solicito configurar o PTR de 177.153.67.99 para mail.interati-app.com.br e
> confirmar IP estático, região física dos volumes/computação no Brasil,
> condições de cifragem e disponibilidade das portas exigidas. Os backups
> cifrados serão mantidos fora da VPS, em computador local do proprietário.

Fonte oficial consultada em 08/10/2026: a
[proposta do Cloud OpenStack Locaweb](https://assets.locaweb.com.br/site/downloads/proposta-comercial-openstack.pdf)
informa bloqueio padrão da saída 25. Isso não identifica o produto/plano
desta VPS nem comprova sozinho a causa dos timeouts. A resposta precisa
tratar a contratação real. Não contratar outro serviço automaticamente.
