# Bloqueio de segurança das imagens

Consulta em 2026-10-07 UTC. A análise local encontrou versões afetadas segundo Trivy e o fornecedor; não houve validação de exploração no Verde2. O gate HIGH/CRITICAL permanece obrigatório. `no-dsa` não significa corrigido, e nenhuma exceção ou redução de severidade foi aplicada.

O relatório consolidado e os IDs efetivamente analisados estão em [evidence.md](evidence.md). SBOM e relatórios sanitizados separam achados anteriores e posteriores à redução do runtime. `npm audit` da aplicação não cobre os pacotes do sistema nem o npm global da imagem base.

## Debian 13 / trixie

As famílias abaixo permaneceram vulneráveis nas versões trixie consultadas. As versões corrigidas citadas pelo tracker pertencem a unstable; não foram instaladas sobre Debian 13. Os números são versões de pacotes fonte; variantes binárias podem incluir sufixos de rebuild.

| Família observada | Referências e situação do fornecedor |
| --- | --- |
| util-linux `2.41.5-0+deb13u1` | [CVE-2026-76642](https://security-tracker.debian.org/tracker/CVE-2026-76642), [78409](https://security-tracker.debian.org/tracker/CVE-2026-78409), [78410](https://security-tracker.debian.org/tracker/CVE-2026-78410): correção em unstable `2.42.3-1`; [78408](https://security-tracker.debian.org/tracker/CVE-2026-78408): `2.42.4-1`. Trixie `no-dsa`. |
| acl `2.3.2-2` | [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369): correção unstable `2.4.0-1`; trixie `no-dsa`, com mudança de ABI e atualização pontual futura indicada. |
| systemd `257.13-1~deb13u1` | [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742): correção unstable `261.2-1`; trixie `no-dsa`. |
| ncurses `6.5+20250216-2` | [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720): correção unstable `6.6+20251231-1`; trixie `no-dsa`. |
| Perl `5.40.1-6+deb13u1` | [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538): correção unstable `5.42.3-1`; trixie `postponed`, devido a regressões upstream. |
| Expat `2.8.3-1~deb13u1` | [CVE-2026-66046](https://security-tracker.debian.org/tracker/CVE-2026-66046), [76956](https://security-tracker.debian.org/tracker/CVE-2026-76956), [76957](https://security-tracker.debian.org/tracker/CVE-2026-76957): correção unstable `2.8.4-1`; [93990](https://security-tracker.debian.org/tracker/CVE-2026-93990): `2.8.4-2`. Sem correção trixie observada. |
| Python `3.13.5-2+deb13u5` | [CVE-2026-15308](https://security-tracker.debian.org/tracker/CVE-2026-15308): correção unstable `3.13.15-1`; [7210](https://security-tracker.debian.org/tracker/CVE-2026-7210): `3.13.14-1`. [19445](https://security-tracker.debian.org/tracker/CVE-2026-19445), [19553](https://security-tracker.debian.org/tracker/CVE-2026-19553), [82049](https://security-tracker.debian.org/tracker/CVE-2026-82049): pacote Python 3.13 ainda sem correção, inclusive em unstable observado. Trixie `no-dsa`. |

Alguns CVEs atingem ferramentas ou componentes específicos. A classificação do fornecedor e a ausência de prova de alcance não autorizam tratar o gate como aprovado. Reavaliar componente, versão e alcance com evidência própria; não prometer segurança por ausência de exploração observada.

## Ferramentas removidas do runtime da API

O primeiro SBOM local vinculou os oito achados de pacotes Node ao diretório `usr/local/lib/node_modules/npm`, e não às dependências de produção da aplicação. A imagem final remove npm, npx, Yarn e Corepack: o serviço executa Node diretamente e conserva `/app/node_modules`. Os estágios de instalação e testes conservam npm. A remoção reduz a superfície instalada; não configura uma exclusão no scanner.

Existem correções upstream para [brace-expansion](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-qhr7-859c-m2p7), [ip-address](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-mwp4-54f8-5fhr), [tar](https://github.com/isaacs/node-tar/security/advisories/GHSA-r292-9mhp-454m) e [undici](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5). Atualizar apenas npm não comprovaria a correção de todas as cópias: o [lock oficial consultado do npm 12.2.0](https://raw.githubusercontent.com/npm/cli/v12.2.0/package-lock.json) ainda contém algumas versões afetadas.

O Undici embutido no Node 24.21.0 é 7.29.1, distinto da cópia 6.27.0 encontrada no npm global. [Release oficial do Node](https://nodejs.org/en/blog/release/v24.21.0). Para `http-cache-semantics`, há [versão upstream 4.3.0](https://raw.githubusercontent.com/kornelski/http-cache-semantics/master/package.json), mas a pesquisa não confirmou correção de segurança oficial para o achado; o [relato upstream](https://github.com/kornelski/http-cache-semantics/issues/56) foi encerrado sem plano de ação.

## PostgreSQL e Redis

O scan anterior do PostgreSQL identificou 22 CVEs da biblioteca Go, um CRITICAL e 21 HIGH, exclusivamente em `usr/local/bin/gosu`. O banco em si não foi identificado como origem desses achados. A [release oficial gosu 1.19](https://github.com/tianon/gosu/releases/tag/1.19) registra a toolchain Go 1.24.6 utilizada.

A imagem derivada mantém PostgreSQL 16.15 e seus scripts oficiais, instala [`su-exec=0.3-r0` do Alpine 3.24](https://raw.githubusercontent.com/alpinelinux/aports/3.24-stable/main/su-exec/APKBUILD) e remove definitivamente `/usr/local/bin/gosu` e o alias anterior `su-exec -> gosu`. As duas chamadas de troca de usuário dos scripts oficiais passam a executar `/sbin/su-exec` pelo caminho absoluto, com asserts no build que impedem qualquer referência restante a gosu. O binário C tem proprietário `root:root` e modo `0755`, sem SUID/SGID. Não copia `postgres/init/` nem adota o schema antigo.

O [código oficial su-exec](https://raw.githubusercontent.com/ncopa/su-exec/v0.3/su-exec.c) aplica grupos, GID e UID antes de executar o processo. Diferenças relevantes: redefine `HOME` e não oferece `gosu --version`; sua versão é registrada pelo APK. Configurações dependentes de HOME customizado exigem qualificação específica. A prova local verifica servidores sem UID zero, banco novo, reinício do banco migrado e restore. São preservados os argumentos e o restante do comportamento dos [entrypoints oficiais PostgreSQL](https://raw.githubusercontent.com/docker-library/postgres/9d15534160ade17f2b6c455a39ee967c49b1937d/16/alpine3.24/docker-entrypoint.sh), inclusive o [helper de inicialização](https://raw.githubusercontent.com/docker-library/postgres/9d15534160ade17f2b6c455a39ee967c49b1937d/16/alpine3.24/docker-ensure-initdb.sh).

O scan anterior do Redis identificou quatro ocorrências HIGH, dois CVEs únicos, em `libcrypto3`/`libssl3` 3.3.7-r1. O [APKBUILD oficial do OpenSSL no Alpine 3.21](https://raw.githubusercontent.com/alpinelinux/aports/3.21-stable/main/openssl/APKBUILD) registra CVE-2026-75804 e CVE-2026-84782 corrigidos em 3.3.7-r2. A imagem derivada atualiza os pacotes pelo repositório estável, preservando o servidor e o entrypoint oficial. SBOM e novo scan devem comprovar a versão e o resultado; não basta o comando de atualização existir.

## Condição para nova avaliação

Obter correções oficiais compatíveis, reconstruir imagens, registrar novos IDs e SBOM, repetir os scans e as provas funcionais apropriadas. Alterações de imagem/runtime invalidam o reaproveitamento automático da carga anterior. A CI conserva todos os gates obrigatórios e executa o escopo completo. Enquanto o gate falhar, as imagens não recebem aceite de produção e o aplicativo não pode depender do serviço.

Uma atualização de repositório APT/APK não invalida automaticamente uma camada Docker em cache. Ao qualificar uma correção de pacote, renovar a base fixada ou reconstruir o componente com `docker build --no-cache` antes do ciclo completo; conferir a versão instalada no SBOM final. Não tratar a existência de `apt-get upgrade` ou `apk upgrade` no Dockerfile como prova de atualização executada.

O scan intermediário de 2026-10-07 (`1791337182955`) ainda apontou o Go da camada base quando o caminho gosu era substituído por um symlink, apesar de o runtime usar o binário C. Esse gate permanece FAIL (22 CVEs, incluindo um CRITICAL); a nova imagem elimina o caminho por completo. A correção só pode ser considerada qualificada após nova execução funcional e scan/SBOM da identidade final.

## Resultado final local

O [scan consolidado](evidence/image-scan-summary.json) da rodada final encontrou 17 CVEs HIGH únicos no conjunto API/Postfix/política/OpenDKIM, nenhum CRITICAL e nenhum segredo. Essas quatro imagens falharam no gate obrigatório. PostgreSQL e Redis passaram, com SBOM sem o helper Go e OpenSSL Redis 3.3.7-r2. As seis identidades correspondem às imagens da qualificação funcional completa. Não houve exclusão nem relaxamento do scanner. Produção permanece bloqueada, com CI remota, infraestrutura e entrega externa ainda não realizadas.
