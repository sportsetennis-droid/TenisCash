# Arquivo de imagens dos bipes

Pedido de Douglas em 08/11/2026: “Eu quero que fique salvo e arquivada cada bipe com imagem”. Horário exato da mensagem indisponível.

- Recebimento e transferência: a câmera salva o quadro decodificado primeiro no aparelho (IndexedDB; fallback localStorage). O envio guarda bytes da foto no PostgreSQL, ligados ao ID imutável do bipe, lote, código, operador e horário. Produto/tamanho continuam no próprio bipe. OCR, quando disponível, acompanha a foto sem substituir a imagem original.
- Reenvio da mesma imagem usa chave única bipe + SHA-256. Uma nova foto da mesma peça fica preservada sem acrescentar bipe. Remover uma leitura da contagem não apaga sua evidência.
- O histórico permite abrir as fotos mediante autenticação e autorização de loja. A resposta binária usa cache privado/no-store.
- Leitura nova no recebimento/transferência sem foto fica pendente. Confirmação de lote com `photoRequired` e sem foto é recusada no servidor. Uma foto salva somente no aparelho é mostrada como aguardando arquivamento; retorno da conexão, autenticação e reabertura retomam o envio.
- Inventário pela câmera: a leitura automática passa pelo mecanismo existente de `ProductCapture` e `/api/stocktake/etiqueta`, usando o quadro que decodificou o código. Fotos manuais e recapturas continuam preservadas. O serviço antigo de identificação por código continua disponível para compatibilidade e não inventa fotografia para entradas de texto.
- Nenhum estoque é movimentado por salvar uma imagem. Foto não comprova recebimento aplicado nem resolve tamanho sem evidência.
- Registros antigos sem imagem continuam sem imagem. Não gerar fotografias artificiais ou usar foto de outra peça. Abas abertas antes desta versão precisam ser recarregadas para carregar a mudança.

## Implantação

Aplicar somente a migração aditiva `20261109010000_scan_action_photos` antes de publicar o código; ela acrescenta tabela de fotos e coluna de controle, preservando dados anteriores. Não executar `db push` indiscriminado em produção. Não inserir bipes fictícios no banco real para testar.

## Validação

`npm run test:scanner` inclui captura do inventário, integridade de JPEG/PNG/WebP e 88 grupos da interface de ações, usando DOM/câmera/rede simulados. O visualizador é testado com fotos pendentes, fotos arquivadas, logout e respostas atrasadas. `scripts/test-scan-action-photos.cjs` exige PostgreSQL local isolado e testa bytes reais de imagem, concorrência, recapturas, autorização, HTTP e trava de confirmação. Históricos e transferências têm testes próprios no mesmo ambiente isolado. Isso não constitui teste físico com o telefone do operador.

Teste solicitado em 08/11/2026 encontrou JPEG truncado aceito porque o cabeçalho continuava legível. O servidor agora decodifica todos os pixels antes de reconhecer o arquivamento; os bytes originais são preservados, sem converter a imagem. Imagem incompleta permanece pendente para reenvio da mesma peça.
