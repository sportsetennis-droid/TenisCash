# Confirmação administrativa de um conjunto finito de capturas

Uma confirmação explícita do proprietário pode abranger capturas exatas já arquivadas. Essa manifestação precisa ficar separada do operador original e não confirma código, BR, variante ou estoque por si só.

O serviço `finiteOwnerConfirmation` aceita exclusivamente uma solicitação inserida por manutenção administrativa no banco, na tabela `stock_replacement_queue.finite_owner_confirmation_request_v1`. Não existe rota HTTP, entrada do cliente ou autorização inferida de uma nota de captura. A publicação cria somente a estrutura; sem solicitação, nenhuma captura é alterada.

A lista permitida no código fixa operação, SHA-256 do texto integral do manifesto, loja, rodada, quantidade e ID inicial. O primeiro conjunto é `douglas-explicit-48-physical-pairs-20261109`, manifesto `5c08214c1f48d1d6d57725cb519828f9facb037d6483de7d035596d6630d1c50`: 48 capturas da Loja 04/rodada 27, confirmadas por Douglas com a frase “Eram outros 48 pares físicos”. O texto integral é arquivado no pedido administrativo. Marcadores de candidatos de chave rejeitados não servem como autorização.

Uma autorização posterior e separada cobre exatamente três capturas adicionais: `douglas-explicit-3-additional-physical-pairs-20261109`, manifesto `45395afa770811f741cd79a16058671cf98ca5e5a24d511a882cbe1e76f13b02`. Douglas respondeu “Sim, eram outros 3 pares físicos” à pergunta que identificava Scend Pro BR 41, EAN `4067979323215`/captura `cmw9wzhiw00453ni1rtdm3kzx`; ST Runner v4 NL BR 40, EAN `4067979749091`/captura `cmw9wzn44004h3ni13v5gk98l`; ST Runner v4 NL BR 41, EAN `4067979749114`/captura `cmw9wzqgz004m3ni1wlc4xpzd`. A primeira captura é o novo canary; `rest` abrange somente as outras duas. A operação anterior dos 48 não é modificada nem reaplicada. O mecanismo existente, inclusive locks, assinatura no runtime, atestado prévio e idempotência, permanece igual. Registrar esta autorização não insere pedido nem comprova gravação de grants, bipes ou estoque.

O pedido identifica `requested_by=system-maintenance` e `source=explicit-owner-chat-confirmation-v1`. A assinatura ocorre exclusivamente dentro do processo do servidor, pela função `recordOwnerReview`, com a chave vigente já presente no ambiente. Chave ausente, curta ou padrão proibido produz `secret_unavailable` sem gravar confirmação. O serviço não muda autenticação, não exporta segredo e não fornece alternativa fraca de assinatura.

## Duas etapas explícitas

1. Um pedido `stage=canary` autoriza apenas a captura inicial já definida no manifesto. O serviço compara foto, revisão, código, operador, horário e demais campos, grava o grant e enfileira a mesma captura na mesma transação.
2. Outro pedido administrativo explícito, `stage=rest`, autoriza os demais alvos do respectivo manifesto: 47 na primeira operação ou duas na operação adicional. É obrigatório que o pedido inicial esteja concluído e que um job do servidor tenha concluído com atestado HMAC `ownerConfirmation`, contexto completo atual e o mesmo bipe. Um marcador ou bipe isolado não satisfaz o requisito.

A rodada é travada antes das capturas; no segundo estágio, a primeira captura também é travada e comparada ao manifesto. O bipe inicial é travado antes da leitura do atestado. Um advisory lock transacional impede dois reconciliadores de processarem a mesma manutenção. A transação tem limite de 30 segundos, busca primeiro apenas metadados/hashes e carrega uma foto por vez para a assinatura. O worker usa a fila já inicializada; não inicia outro worker nem chama reconciliação recursiva.

`finite_owner_confirmation_event_v1` registra pedidos concluídos, rejeições, espera para repetir e cada captura confirmada, incluindo contexto, hashes, nota anterior, nota resultante e job. A quantidade confirmada é uma quantidade de grants; não significa estoque aplicado. A recuperação normal ainda decodifica o original e a conferência normal decide a aplicação de estoque. Este serviço não cria bipes nem movimentos.

## Falhas e repetição

- Manifesto não permitido, contexto alterado, rodada inativa ou chave indisponível: pedido rejeitado explicitamente, sem gravação parcial. Uma rejeição exige avaliação administrativa; o cliente não a remove.
- Interrupção, timeout, falha transitória de banco, enqueue ou atestado inicial ainda pendente: rollback dos grants e jobs; pedido continua solicitado, com resultado `deferred` e nova tentativa após 30 segundos. O evento guarda apenas motivo sanitizado. A disponibilidade do atestado é verificada novamente antes de qualquer grant restante.
- Pedido já concluído: não é executado novamente. Uma confirmação já válida e idêntica conserva sua assinatura; o enqueue reutiliza exclusivamente um job cujo snapshot completo corresponda.
- Falha no bootstrap ou reconciliação da manutenção: aviso fixo sanitizado; a fila normal continua funcionando e a inicialização da manutenção é tentada novamente.

Teste local: `ROUND_TEST_DATABASE_URL` deve apontar exclusivamente para PostgreSQL isolado na porta 55329, banco com prefixo `stock_replacement_`. Executar `npm run test:finite-owner-confirmation`. A suíte valida os dois estágios, adulteração de escopo/foto/revisão, ausência de chave, concorrência, repetição e rollback; nunca acessa produção.

Os scripts administrativos ficam no workspace operacional: `tmp/request-finite-owner-confirmation-20261109.cjs` para os 48 e `tmp/request-three-owner-confirmation-20261110.cjs` para os três adicionais. O padrão é somente leitura; os modos de solicitação fazem somente `INSERT` no pedido, com o hash de revisão explícito da respectiva operação. Não carregam JWT, não criam tabela nem alteram captura, bipe ou estoque. Publicação e pedidos reais devem ser registrados separadamente: este documento não comprova execução das confirmações.

Conferência offline dos três: `node scripts/test-three-owner-confirmation.cjs <manifesto-dos-3.json> <manifesto-original-dos-48.json>`. O teste lê os dois artefatos imutáveis, testa o validador real em memória e rejeita mudanças de escopo, origem e snapshot; não acessa banco nem chave de assinatura.
