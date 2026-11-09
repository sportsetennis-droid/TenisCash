# Implantação do mecanismo de estoque — 09/11/2026

Ordem expressa de Douglas neste chat: “Eu quero que implante tudo / Eu quero o sistema a nível mundial / Eu quero o melhor sistema do mundo”. Horário exato da mensagem não registrado. Autorização para implementar e publicar as melhorias pesquisadas no TenisCash. Critérios concretos substituem qualquer afirmação não demonstrada de perfeição ou liderança mundial.

Referência: pesquisa em `output/pesquisa-github-estoque-20261109/RELATORIO.md` no projeto de trabalho. Integração incremental no TenisCash, mantendo cadastros, fotos, IDs, movimentos e as rodadas17–23 existentes. Nenhuma nova zeragem. Sem API paga. Não instalar múltiplos ERPs concorrentes como se isso fosse requisito da pesquisa.

## Frentes autorizadas em implementação

- Runtime Node22 alinhado entre execução local, CI e Nixpacks; dependências pg-boss12.38.1, zxing-wasm3.1.6 e Sharp0.35.5.
- Fila persistente no PostgreSQL para captura, identificação e conferência/aplicação; retomada, tentativas, posse de trabalho e unicidade do efeito.
- Processamento de imagem isolado em subprocesso, limites de memória/tempo e recuperação de falha; preservar leitura da própria etiqueta e escala BR.
- Persistência local com releitura de foto/metadados, retomada, quota e contexto original. Próximo exclusivamente manual; repetição autorizada de outra peça física.
- Shell offline específico do scanner, mantendo notificações existentes e sem cache de respostas autenticadas ou fotografias pela camada de navegação.
- Relatório por evento com situação exclusiva, motivo, horários, tentativas e vínculo de movimento. Saúde da fila protegida pela autorização da loja.
- Regressões de estoque/vendas/transferências, falhas de rede/processo, múltiplos trabalhadores, reenvios e manutenção do arquivo anterior.
- Publicação somente após validar a versão exata; conferir arquivos servidos, execução da fila e movimentos reais, sem bipes fictícios em produção.

## Estado inicial confirmado

Branch `fix/scanner-recovery-20261109`, PR125, HEAD anterior `1389320a5554823cf612f7486fb67fe15503f479`; produção anteriormente verificada `98b0e2ee9afdd5539939052942019b6162fbe017`.

Consulta somente leitura em `2026-11-09 18:50:40.90428+00`: Loja04 rodada20 tinha17 fotos,13 bipes ativos,0aplicados, saldo oficial0. Sete rodadas continuam ativas; saldos das outras lojas podem conter vendas e movimentos posteriores e não serão reiniciados. Contagem33 da tela do telefone é evidência distinta; reconciliar IDs antes de afirmar recuperação completa.

## Verificações obrigatórias e estado

| Verificação | Estado inicial desta implantação |
|---|---|
| Runtime Node22 oficial com hash verificado | Preparado localmente,22.23.4 |
| Fila e processos de imagem | Implementação em andamento |
| Falhas de armazenamento/reenvio e autorização | Testes em elaboração |
| Diagnóstico por evento sem somar bipe+foto | Teste local aprovado; integração pendente |
| Suite completa no PostgreSQL local isolado | Pendente após integração |
| Publicação e prova do código servido | Pendente |
| Conciliação de movimentos reais após publicação | Pendente |
| Sessão prolongada no telefone original | Não observada; ferramenta não controla esse aparelho |

Os estados serão atualizados com resultados e fontes. Código preparado, teste local, CI, publicação e uso físico são etapas distintas. A atualização de dependências não comprova a causa do encerramento da página no iPhone.

## Verificação integrada antes da publicação

Node22.23.4: suites `test:scanner`, `test:stock-replacement`, `test:sale-stock-ledger`, `test:financial` e `test:mf-daily` aprovadas localmente. PostgreSQL local isolado na porta55329, sem leituras fictícias em produção. Testes adicionais de autenticação, shell offline, status recente e armazenamento pendente aprovados; integrados ao CI. Revisão independente identificou corrida de recaptura e a correção usa lock da captura antes do bipe, com teste concorrente de banco.

Foto+job persistem na mesma transação; aplicação do saldo+movimento+confirmação da tentativa vigente também. Reenvio do mesmo ID não duplica unidade. Outro par de código igual exige confirmação da contagem corrente, incluindo concorrência entre aparelhos. OCR roda isolado com prazo24s e falhas ficam pendentes/repetíveis.

Corpus original de17 fotos:6 extrações completas de código/BR/referência-modelo,1 código e BR com referência pendente,10 pendentes (9timeout e1tamanho/referência). Extração não equivale a aplicação de estoque. Não declarar leitura perfeita.

Cópia pré-publicação somente leitura em `2026-11-09 19:03:10.924735+00`, PostgreSQL18.6 com permissão de criar schema da fila:7rodadas,13bipes,17capturas,13checks,24477linhas de saldo e13187movimentos desde abertura. Backup delimitado ao estoque, não banco inteiro; gzip foi relido e conferido. Manifesto no projeto raiz `output/stock-upgrade-20261109/predeploy-manifest.json`, SHA256 `7495a990e6a69782b8be511a5274c6ad876c862f882c68eb95bcf7a3d8a00b2c`.

Publicação, verificação do código servido e conciliação pós-publicação continuam pendentes neste registro. Não iniciar ou zerar novamente rodadas17–23.
