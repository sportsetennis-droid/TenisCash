# Servidor MCP do TenisCash (`/mcp`)

O Claude (Code, Desktop, celular) e os agentes da Rede Neural conversam com o TenisCash pelo mesmo servidor MCP. Ele é a seção 9 de `docs/REDE-NEURAL-DE-AGENTES.md`: as ferramentas são os sentidos e as mãos da rede, e as regras duras do `CLAUDE.md` são checadas **dentro** delas.

- Código: `src/ai/rede/mcp/servidor.js` (exporta `mount(app)`)
- Teste: `node scripts/test-rede-mcp.js` (sobe banco descartável, fala com o servidor pelo cliente oficial do SDK)
- SDK: `@modelcontextprotocol/sdk` **1.32.x** (linha 1.x, com build CommonJS: `require('@modelcontextprotocol/sdk/server/mcp.js')`) + `zod` 4.

## Ligar no servidor

Em `src/index.js`, **antes** do fallback `app.get('*')` (o SPA) e depois do `express.json`:

```js
require('./ai/rede/mcp/servidor').mount(app); // MCP do TenisCash em /mcp
```

Variáveis opcionais (Railway):

| Variável | Padrão | Para quê |
|---|---|---|
| `MCP_SESSOES` | ligado | `0` = 100% sem estado (sem elicitation; a decisão exige `confirmar=true`) |
| `MCP_MAX_SESSOES` | 50 | teto de sessões em memória (fecha a mais antiga) |
| `MCP_SESSAO_OCIOSA_MIN` | 30 | sessão parada há mais que isso é fechada |
| `MCP_RATE_MIN` | 240 | chamadas por minuto por usuário |

Depois do deploy, conferir no ar (Lei 1 da constituição):

```bash
curl -i -X POST https://clubsportsetennis.com.br/mcp -H "Content-Type: application/json" -d '{}'
# esperado: 401 com JSON {"jsonrpc":"2.0","error":{...}} (não o HTML do SPA)
```

## Autenticação

- Só `Authorization: Bearer <JWT do TenisCash>`. Token na URL (`?token=`) **não** vale aqui.
- O JWT é o mesmo do login do admin (`JWT_SECRET`) e passa pelo `authMiddleware`, que consulta o banco. Conta desativada ou rebaixada perde o acesso na hora.
- Só entram os papéis `admin`, `superadmin` e `manager`. Vendedor, loja, cliente e design recebem **403**. Sem token ou com token inválido, **401**.
- A sessão MCP fica presa ao usuário que a abriu. Outro usuário com o mesmo `Mcp-Session-Id` recebe 403.
- O token dá acesso total de leitura ao negócio. Trate como senha e **nunca** cole no chat nem faça commit dele.

Pegar o token: faça login no admin e copie o JWT. Ele fica no armazenamento local do navegador, mesmo valor que vai no header `Authorization` das chamadas `/api/admin`.

## Conectar o Claude

### Pelo OAuth (recomendado, desde 18/11/2026)

O `/mcp` tem OAuth 2.1 (`src/ai/rede/mcp/oauth.js`): descoberta RFC 9728/8414, registro dinâmico (RFC 7591), PKCE S256 obrigatório, token de 1 h (JWT do TenisCash) + renovação de 60 dias com rotação. Só conta admin/superadmin/manager autoriza.

- **claude.ai / Desktop / celular:** Configurações → Conectores → Adicionar conector personalizado → URL `https://teniscash.com.br/mcp` → Conectar → entrar com o login do admin → Autorizar.
- **Claude Code:** `claude mcp add --transport http teniscash https://teniscash.com.br/mcp` e depois `/mcp` → teniscash → Authenticate.
- Tabelas (SQL aditivo): `McpOAuthClient`, `McpOAuthCode`, `McpOAuthRefresh`. Teste local: registro → autorização → token → initialize → renovação (14/14 em 18/11/2026).

O caminho antigo abaixo (Bearer colado à mão / mcp-remote) continua funcionando.


### Claude Code

```bash
claude mcp add --transport http teniscash https://clubsportsetennis.com.br/mcp --header "Authorization: Bearer <token>"
```

`claude mcp list` deve mostrar `teniscash` conectado. Claude Code suporta elicitation: ao decidir uma proposta, ele mostra a pergunta de confirmação na tela.

### Claude Desktop

O conector remoto da interface do Desktop e do claude.ai só pede URL (e OAuth). **Ainda não existe OAuth no `/mcp`**, então use a ponte `mcp-remote` no `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "teniscash": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://clubsportsetennis.com.br/mcp", "--header", "Authorization:${TC_TOKEN}"],
      "env": { "TC_TOKEN": "Bearer <token>" }
    }
  }
}
```

### claude.ai e o app do celular

O conector personalizado do claude.ai/celular exige **OAuth**, e o servidor ainda não tem OAuth. Até isso existir, o celular não conecta direto. Essa é a próxima etapa (ver "Riscos").

## Ferramentas

As ferramentas são organizadas por **tarefa**, não por tabela. Toda resposta é JSON curto (no máximo ~14 mil caracteres) e passa por `mascararPII` (CPF, telefone, e-mail e tokens viram `[cpf]`, `[telefone]`, `[email]`, `[segredo]`). Campos de código (EAN, chave de acesso, CNPJ de empresa, ids) não passam pelo mascaramento, para não estragar o código. Erro sempre volta com `erro` e `proximoPasso`.

### Leitura (`readOnlyHint: true`)

| Ferramenta | Entrada | O que responde |
|---|---|---|
| `estoque_por_codigo` | `codigo` (EAN) | Produto, tamanho (confirmado pela caixa?), **comprado** (NF-e) e **localizado** por loja, com alerta se localizado > comprado. Recusa `"SEM GTIN"`. Código sem card mostra se ele está em NF-e de entrada ou só em transferência. |
| `estoque_por_produto` | `busca` (ref ou nome), `incluirInativos?`, `limite?` | Cards com os tamanhos: código, comprado e localizado por loja. |
| `vendas_do_dia` | `data?` (AAAA-MM-DD), `loja?` | Total, vendas, peças, desconto, TenisCash usado e ticket médio por loja, no dia de **America/Fortaleza**. Conta só vendas concluídas. Canceladas e estornadas aparecem à parte. |
| `nfe_por_chave` | `chave` (44 dígitos) | Emitente (fornecedor = emissor), destinatário e loja, valor e itens (vinculados, sem vínculo, sem GTIN, amostra). Diz se é **entrada** ou **transferência** pela regra (CNPJ raiz ou CFOP 5152/6152) e avisa se diverge do gravado. |
| `produto_nuvemshop_status` | `produto` (id, ref ou EAN) | Roda a **mesma trava** do site (`nuvemshopEligibility`): 4 classificações, foto, descrição, preço > custo, cor, nome limpo, estoque físico nas lojas do site. Lista cada motivo que barra e diz se já está mapeado. |
| `propostas_pendentes` | `limite?` | Propostas `rna_*` aguardando o dono, com prévia, evidência, risco, neurônio e traceId. |
| `rastro_da_rede` | `traceId` | Sinais, ativações (status, custo, ms, erro) e propostas do evento. |
| `painel_da_rede` | (nenhuma) | Ligada ou não, gasto de IA hoje e teto, pendentes, neurônios, objetivos, candidatos a poda. |
| `medalhas_do_atleta` | `handle` | Medalhas verificáveis públicas (quando o módulo `Medal` estiver no ar) e badges do app. Nunca devolve CPF, sal ou credencial. |

### Propor (não executa)

| Ferramenta | O que faz |
|---|---|
| `perguntar_a_rede` | Emite o sinal `dono.pergunta` e devolve o `traceId`. Os mini agentes só analisam e propõem. Pode gastar IA dentro do teto diário. |
| `criar_objetivo_rascunho` | `objetivos.compilar` transforma o texto em **rascunho** (KPIs, região, restrições, prazo, orçamento). **Não cria nem ativa** o objetivo. Limite de 20 rascunhos por dia. |

### Decidir (`destructiveHint: true`)

`decidir_proposta(propostaId, decisao, nota?, confirmar?)` aceita `approved`, `rejected` ou `correction_requested` (este último exige nota).

1. Se o cliente suporta **elicitation** (Claude Code suporta), o servidor pergunta ao dono na tela, dentro da própria chamada, e só decide se ele marcar "confirmo". Recusar ou fechar a pergunta não decide nada, mesmo com `confirmar=true`.
2. Se o cliente **não** suporta, a primeira chamada só devolve a **prévia** (`aguardandoConfirmacao: true`). O agente mostra a prévia ao dono e só chama de novo com `confirmar=true` depois do "sim" explícito dele.
3. A gravação é atômica: só decide se a proposta ainda estiver pendente. Fica registrado quem decidiu e como foi confirmado (`[via MCP, elicitation]` ou `[via MCP, confirmar=true]`). Em seguida, `aprendizado.aoDecidir` ajusta pesos e limiares.
4. **Aprovar não executa a ação.** A execução continua no painel da rede, feita por pessoa.

### O que NÃO existe (de propósito)

Não há ferramenta que muda preço ou markup, envia WhatsApp ou mensagem a cliente, publica no Nuvemshop ou no Instagram, ajusta estoque, apaga bipe ou executa proposta. Tudo isso continua passando por proposta, aprovação do dono e pessoa.

## Transporte

O endpoint usa Streamable HTTP em modo **híbrido**:

- O `initialize` abre uma **sessão em memória**, necessária para a elicitation: o pedido de confirmação viaja no mesmo fluxo SSE da chamada.
- Requisição com sessão desconhecida (por exemplo, depois que um deploy apaga a memória) ou sem sessão é atendida **sem estado**: um servidor por requisição, resposta JSON. O cliente não quebra, só perde a elicitation naquela chamada.
- `GET /mcp` (stream de notificações) e `DELETE /mcp` (encerrar) só valem com sessão. Sem sessão, devolvem 405 ou 404.
- O header `accept-encoding` é anulado na rota, para o `compression()` do app não segurar o SSE.

## Riscos e pendências

- **OAuth.** claude.ai e o celular só conectam com OAuth. Hoje é só JWT por header: Claude Code direto, Desktop via `mcp-remote`.
- **JWT de 30 dias.** Um token vazado dá leitura total até expirar ou até a conta ser desativada. Desativar o usuário corta o acesso na hora, porque o banco é a autoridade.
- **Sessões em memória.** Funcionam porque o Railway roda 1 réplica. Com mais réplicas, a elicitation precisaria de sessão aderente (sticky) ou de `MCP_SESSOES=0`.
- **SDK 1.x × 2.x.** O pacote `@modelcontextprotocol/sdk` 1.x é a linha mantida, com correções. A 2.x (`@modelcontextprotocol/server`) já saiu, com protocolo 2026-07-28. Migrar quando os clientes Claude usarem a versão nova.
- **`CANONICAL_HOST`.** Se essa env for ligada, `GET /mcp` em `teniscash.com.br` recebe 301. Use a URL `clubsportsetennis.com.br`.
