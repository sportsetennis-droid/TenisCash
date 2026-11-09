# Scanner móvel: persistência e retomada — 09/11/2026

Implementação local para as ordens de Douglas: guardar cada foto original e seu código antes de liberar Próximo, continuar envio/conferência em segundo plano, manter avanço manual e confirmar outro par físico quando o código já existe na rodada. Não houve bipagem fictícia, alteração de estoque, abertura de rodada ou serviço pago nesta execução.

## Gravação e contexto

`scanner-photo-storage.js` grava evento e fotografia na mesma transação IndexedDB; só retorna confirmação depois de outra transação reler e comparar os campos e os bytes da própria imagem. Solicita durabilidade estrita quando suportada, com compatibilidade para navegadores anteriores. O fallback localStorage também verifica o valor relido. Corrupção, indisponibilidade ou quota não liberam Próximo nem são descritas como foto salva. Recapturas preservam as revisões anteriores.

`localCaptureAcceptedAt` começa depois de produzir o JPEG da captura; `localSaveMs` termina após a releitura persistida. Esse tempo não mede captura da câmera, identificação, upload ou aplicação no estoque. O checkpoint seguinte persiste a medição. Não é apresentado como teste de velocidade no iPhone.

Solicitação de armazenamento persistente ocorre ao abrir a câmera por ação do operador. Negação ou API ausente permanece explicitamente desconhecida/não concedida, sem invalidar uma gravação que realmente foi confirmada. Navegador, sistema operacional e usuário ainda podem remover dados: a proteção não equivale a backup no servidor.

Retomada conserva os IDs originais de loja, rodada, operador, evento e revisão. Restauração de conexão, visibilidade e autenticação acorda a fila sem abrir câmera ou avançar peça. Autenticação recuperada é validada no servidor para a mesma identidade. Outro operador não envia os eventos antigos. Respostas atrasadas não autorizam outra revisão/peça. Erros reais 400/403/409 continuam em revisão; 401 aguarda autenticação correta.

## Contagem e repetição

Cada evento aparece em apenas um estado: no aparelho/aguarda envio, recebido/em conferência, pendência/erro, aplicado ou excluído/sem contagem. Estados somam o total da rodada e loja selecionadas; códigos iguais com IDs diferentes continuam eventos distintos. Aplicado exige ID de bipe e confirmação `appliedToStock` do servidor. Foto ou produto identificado não comprovam saldo.

Resposta 409 com `repeat.count` mantém a foto original. Confirmação explícita envia `repeatConfirmedCount` com o mesmo evento e revisão; contagem alterada por outro aparelho exige nova confirmação pelo backend. Cancelar mantém pendência até ACK do servidor, então permite Próximo manual sem contar nem recriar o evento. Foto excluída não pode ser recapturada/revivida. Upload, reconhecimento e cancelamento possuem limite de 25 segundos incluindo leitura do corpo HTTP; timeout preserva a fila e a tentativa posterior usa o mesmo ID.

## Reabertura offline

O service worker guarda somente o shell público do scanner e bibliotecas locais permitidas. Não guarda APIs, tokens, fotografias ou outras páginas. Mantém os handlers de push; não usa `skipWaiting`, evitando substituir à força uma sessão aberta. Falha de rede/quota no novo precache preserva o cache anterior; falha de cache não invalida uma resposta online válida.

Reabertura offline depende de instalação anterior bem-sucedida do shell; a primeira visita sem conexão não está garantida. O arquivo local recolhível exibe os eventos deste aparelho e seu contexto original mesmo sem rodada carregada. Não afirma enxergar fotos de outros aparelhos. Reabrir a lista não inicia câmera, não autentica offline e não aceita um novo operador. O processamento retoma quando houver conexão e identidade válida. A execução contínua em segundo plano com navegador fechado não é garantida.

## Evidências automatizadas locais

- `test-scanner-mobile-durability.cjs`: corrupção de releitura, rollback por quota, reenvio do mesmo ID, fallback de durabilidade, persistência negada/ausente, 300 eventos de EAN igual e 301 revisões originais restauradas. Simulador de protocolo IndexedDB, não benchmark de telefone.
- `test-scanner-offline-shell.cjs`: manifestos exatos, shell offline, bibliotecas locais, proibição de cache de API/token/foto, preservação de push, falha de cache e retenção/fallback de shell anterior incompleto.
- `test-scanner-outbox-recovery.cjs`: identidade/contexto, 401, 400/403/409, chamadas simultâneas, confirmação de repetição, cancelamento, timeout antes e depois de cabeçalhos nos três envios, revisão antiga, estados exclusivos e arquivo offline.
- `test-scanner-local-next.cjs`: atraso de gravação bloqueia avanço; upload/OCR atrasados não bloqueiam outra captura salva; cancelamento aguardando ACK bloqueia, ACK libera avanço manual; 203 originais, mais de 34 MB, sem conservar todas as imagens na fila em memória.
- `test-bipar-actions-auth.cjs`, `test-scanner-memory.cjs`, `test-scanner-recent-read-ui.cjs` e `test-bipar-pending-storage.cjs`: regressões aprovadas.

Os oito scripts acima passaram localmente. Sintaxe dos módulos cliente e service worker conferida. Teste físico prolongado no iPhone, publicação e recuperação integral das fotos do aparelho não foram observados por este agente; são verificações separadas. Nenhum teste local constitui confirmação do saldo oficial.
