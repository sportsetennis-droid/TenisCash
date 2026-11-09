# Scanner: correções verificadas em 09/11/2026

Pedido: ativar a capacidade disponível de agentes e corrigir as falhas da bipagem. Foram acionadas 24 frentes auxiliares, com propriedade de arquivos/trechos e revisão central. Esse paralelismo é de desenvolvimento; o OCR publicado continua limitado a um processo, 24 segundos e 384 MiB. Nenhum serviço pago de leitura foi adicionado.

## Comportamentos corrigidos

- O upload exige a gravação durável da própria foto e revisão, inclusive depois de esperas assíncronas. Uma gravação anterior da fila não autoriza enviar uma captura nova ainda não gravada.
- ACK incompleto ou JSON inválido usam espera progressiva; 429 respeita Retry-After; 413 conserva o original para revisão.
- Consulta de status tem prazo, recupera autenticação da pessoa original e preserva estados diante de respostas atrasadas. 408/429 são temporários; conflitos reais permanecem visíveis.
- Recaptura mais nova não é descartada por conclusão antiga, e deltas antigos não podem confirmar ou sobrescrever a fotografia nova. Originais/eventos permanecem arquivados localmente.
- Captura manual decodifica seu próprio quadro; código antigo não é atribuído automaticamente a outra foto. Releitura conserva a identidade da peça e arquiva uma nova revisão.
- Falhas de inicialização encerram o worker OCR criado; a compressão de fotografias libera URLs e canvases em sucesso e falha.
- Identificação atrasada não sobrescreve o estado de captura excluída ou de rodada encerrada. Locks seguem rodada → captura e a gravação final é condicional.
- Consultas quentes de rodada usam projeções sem baseline; conferências do lote de status são buscadas em conjunto.
- Fila pg-boss pode consumir o backlog sem um segundo ocioso entre itens, mantendo um handler. Reavaliação legítima das imagens de itens aplicados permanece.
- Leitor servidor aceita os mesmos códigos internos de 16 dígitos já aceitos pelo cliente. Aliases UPC/EAN/GTIN preservam zeros equivalentes sem truncar dígitos não zero.
- Mensagens distinguem memória, autorização, confirmação de repetição e revisão. O HTML offline só é substituído por um precache completo.
- Parser acrescenta vetos contra escala estrangeira e evidência parcial contraditória. Não foi publicada fusão experimental de campos nem o protótipo Paddle.

## Validação e limites

As suítes `test:scanner` e `test:stock-replacement` incluem as novas regressões. PostgreSQL dos testes é isolado na porta 55329; não são criados bipes em produção. O teste opcional `scripts/test-scanner-browser-durability.cjs` usa DOM/IndexedDB reais, câmera/decoder simulados e API localhost, com Chromium e WebKit. Isso não equivale a teste físico no iPhone.

Os oito originais Mizuno desta investigação são fixtures arquivadas, não novas entradas de estoque. Resultados de OCR devem ser consultados no manifesto da execução; preservar pendência quando faltam código, BR ou referência/cor comprovados. Não afirmar leitura perfeita de todas as etiquetas.

Achados separados que não estão resolvidos por este lote: revisões anteriores recapturadas offline ainda podem existir só no aparelho; colisão de fotografias diferentes com a mesma revisão e ausência de hash no ACK; 401 no envio manual inicial; cancelamento cooperativo de uma etapa externa ao OCR que fique presa; vínculos fiscais legados e placeholders; seleção de códigos concorrentes no quadro; limites geométricos do parser para múltiplas caixas. Nenhum desses pontos autoriza inventar estoque, descartar fotos ou reativar bipes excluídos.

Loja 04 foi zerada em operação anterior, com arquivos e fotos preservados. Este lote de código não repete zeragens nem altera cadastros, preços, vendas ou estoque comprado. Commit, CI e implantação são registrados separadamente pela coordenação, em `output/scanner-parallel-reliability-20261109/` no projeto de trabalho.
