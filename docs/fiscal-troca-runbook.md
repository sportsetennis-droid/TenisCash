# Runbook FISCAL — agentes v2.1, TROCA, cancelamento, 2ª via

> Estado consolidado em 2026-06-11. Commits-chave: `5f3b801` (troca completa), `2bc266e` (roteamento mod-55), `295d8a0` (failover), `a554a0a` (timezone cupom), `954ae3e` (NSU único).

## 1. Arquitetura (como uma nota sai)

```
PDV (loja.html) ──► Central (Railway) ──► Store.fiscalAgentUrl (funnel Tailscale DA PRÓPRIA LOJA)
                                              │
                                              ▼
                            Agente fiscal v2.1-troca (PC da loja, C:\TenisCashAgent)
                            assina com PFX local (cert do GRUPO, raiz 44052617 —
                            assina QUALQUER filial) e transmite pra SEFAZ/SVRS
```

- **Agente é STATELESS**: CNPJ/IE/CSC/série/número vão no corpo de cada chamada. Por isso **qualquer agente vivo emite por qualquer loja**.
- **FAILOVER automático** (`src/services/fiscalAgentClient.js`): agente da loja fora → a chamada sai pelo agente de outra loja viva. Não troca de agente quando a SEFAZ já respondeu (cStat) nem em timeout (anti-duplicata; a SEFAZ barra duplicado com 539 de qualquer jeito).
- **Roteamento por versão**: payload de troca (`payments[]`, `finNFe=4`, `refNFe`) ou QUALQUER operação em chave **modelo 55** só vai pra agente **>= 2.1** (cache de versão 120s). Motivo: o 2.0 não conhece os campos e apontava o modelo 55 pro host morto.
- **Matriz fora da rota** desde 2026-06-11: nenhuma Store aponta pra ela; `FISCAL_EXTRA_AGENTS` removida do Railway; funnels da matriz desligados. Os diretórios `C:\TenisCashAgent*` na matriz ficam de **reserva manual** (emergência: `cd C:\TenisCashAgent; node index.js` + `tailscale funnel --bg 8765` + setar `FISCAL_EXTRA_AGENTS=url|token` no Railway).

## 2. Mapa por loja

| Loja | CNPJ | Host tailnet | URL do agente | NFC-e série |
|---|---|---|---|---|
| 01 Baratão | 0001-26 | `desktop` (100.70.144.119) | https://desktop.tail0386f5.ts.net | 2 |
| 02 Bessa | 0002-07 | `desktop-rs4674n` (100.105.243.83) | https://desktop-rs4674n.tail0386f5.ts.net | 1 |
| 03 Rainha | 0003-98 | `loja03-rainha` (100.91.132.63) | https://loja03-rainha.tail0386f5.ts.net | 2 |
| 04 Ecommerce | 0004-79 | (sem máquina) | usa o agente da Rainha | 1 |
| 05 Tambaú | 0005-50 | `sportsetennis-1` (100.111.158.15) | https://sportsetennis-1.tail0386f5.ts.net | 2 |
| 06 Tambiá | 0006-30 | `sportsetennis` (100.99.238.38) | https://sportsetennis.tail0386f5.ts.net | 2 |

- **CSC é do GRUPO (CNPJ-raiz)** — o portal SEFAZ lista os 2 códigos no CNPJ da matriz mesmo consultando pela IE da filial. Em uso: `2418…/ID 000002` (todas) e `B31D…/ID 1` (LOJA01). Valores: banco `FiscalIssuer.csc/cscId` + backup local (seção 8).
- **Séries**: NFC-e = série 1 (LOJA02/04) ou 2 (demais) com numeração a partir de 100000. **NFe 55 própria (devolução/ecommerce) = SÉRIE 2 em TODAS** a partir de 100000 — a Chianca emite 55 na série 1, colisão impossível.
- **Token do agente**: `C:\TenisCashAgent\.env` (AGENT_TOKEN) em cada loja = `Store.fiscalAgentToken` no banco. **PFX**: `C:\Chianca\NFe_Emissao0XX\Certificado2026.pfx` em cada máquina (caminho no `.env` do agente).
- Logins/segredos (senhas, CSC, tokens): **NÃO ficam neste arquivo** — ver o backup local `C:\Users\sport\TenisCashBackups\` (fora do repo) e o banco (`FiscalIssuer`/`Store`).

## 3. Operações do caixa (PDV → seção "🧾 Cupom fiscal")

- **🔄 TROCA**: escolhe o cupom original → marca o que voltou (stepper, máx = vendido − já devolvido) → bipa o que levou → diferença + forma de pagamento → EMITIR. O sistema emite **(1) NF-e 55 de DEVOLUÇÃO** (entrada, série 2, `finNFe=4`, `tpNF=0`, CFOP 1202, `NFref` = chave do cupom original, destinatário = a própria empresa, pagamento tPag 90/0,00) e **(2) cupom NOVO pelo VALOR CHEIO** com pagamento dividido: `05 Crédito Loja` (= valor devolvido) + a diferença (01/03/04/17). **Nunca existe "cupom da diferença".**
  - Diferença **negativa** (levou mais barato): cupom 100% Crédito Loja + **VALE manual** pro cliente (o PDV avisa o valor).
  - **Estoque**: devolvido **volta** e novo **sai** — só `StoreStock` (localização). `ProductSize.stock` (comprado) é INTOCADO (regra do dono).
  - **Retry idempotente**: se a devolução autorizou e só o cupom falhou, o PDV reapresenta o botão — reenvia com `devolucaoDocId`+`saleId` e NÃO duplica nada.
  - Cartão na diferença: NSU obrigatório + regra de **NSU único** (1 transação = 1 cupom).
- **🚫 CANCELAR CUPOM**: motivo 15+ chars → evento na SEFAZ via agente. Caixa só cancela **NFC-e**; modelo 55 é admin. Janela legal de NFC-e ≈ **30 min** (quem nega depois é a SEFAZ; o erro volta literal).
- **🖨️ 2ª VIA**: reimprime o cupom térmico (`/api/admin/fiscal/documents/:id/print`).

Rotas: `GET /api/admin/fiscal/troca/cupons?storeId&q=` · `POST /api/admin/fiscal/troca` · `POST /api/admin/fiscal/documents/:id/cancel`. Guard do caixa: lista `CAIXA_FISCAL_OK` em `src/routes/fiscal.js` (cancel/troca registrados ANTES do `adminMiddleware`).

## 4. Procedimentos

**Verificar tudo (read-only):** `node scripts/fiscal-status.js` — roteamento, saúde/versão de cada agente, séries e numeração.

**Testar uma loja com emissão real (R$2, cancela sozinho):** `node scripts/fiscal-test-emit.js LOJA0X 9000NN` — usar nNF de teste novo a cada rodada (número autorizado+cancelado NÃO pode ser reutilizado → 539).

**Atualizar o agente de uma loja** (PowerShell ADMIN no PC da loja):
1. Na matriz, subir o file server: `node "$env:TEMP\serve_agent.js"` (serve `agents/fiscal-agent` na :8000).
2. Na loja: `Invoke-WebRequest http://100.106.212.108:8000/index.js -OutFile C:\TenisCashAgent\index.js; Invoke-WebRequest http://100.106.212.108:8000/fiscalSefazDirect.mjs -OutFile C:\TenisCashAgent\fiscalSefazDirect.mjs; Stop-ScheduledTask TenisCashFiscalAgent; Start-ScheduledTask TenisCashFiscalAgent`
3. Validar: `/health` da loja deve responder `version: 2.1-troca`.

**Agente caiu numa loja:** o Scheduled Task `TenisCashFiscalAgent` reinicia sozinho (boot + 99x/1min). Manual: `Stop-ScheduledTask TenisCashFiscalAgent; Start-ScheduledTask TenisCashFiscalAgent`. Enquanto isso o failover cobre pelas outras lojas.

**Matar agente na mão (matriz/teste):** matar pelo PORT (`Get-NetTCPConnection -LocalPort 8765`), NUNCA por CommandLine — `Start-Process node index.js` não carrega o path no CommandLine e o processo velho continua servindo.

**Loja nova / credenciamento:** runbook `agents/fiscal-agent/DEPLOY-NOVA-LOJA.md` + `scripts/fiscal-register-store.js`. Credenciar NFC-e na SEFAZ-PB: DTE primeiro, depois o credenciamento (LOJA06 ativou ~2h depois do DTE). Enquanto não ativa, a SEFAZ devolve **781** pra qualquer CSC. Testar: emissão real R$1 e cancelar.

## 5. Armadilhas conhecidas (cada uma já mordeu)

- **`nfe.sefaz.pb.gov.br` NÃO EXISTE** — PB é SVRS no modelo 55 também (autorização/eventos/consulta = `nfe.svrs.rs.gov.br`). Corrigido no agente 2.1; agente 2.0 quebra em QUALQUER operação de 55 (por isso o roteamento por versão).
- **node-forge** precisa existir no `node_modules` do agente (package.json já lista; instalação antiga pode não ter → `npm install node-forge` no dir do agente).
- **Funnel frio**: 1º hit público após religar leva 10–30s.
- **Número fiscal não se reusa** após autorizado (mesmo cancelado) → 539. Testes: usar 9000xx sempre crescente.
- **`api()` do PDV descarta o corpo em HTTP de erro** → respostas de negócio parcial da troca voltam **200 com `ok:false`**.
- **Railway CLI**: remover variável = `railway variable delete NOME` (não existe `--unset` nem valor vazio).
- Cancelamento via central usa o **agente** (PFX local `pfxPathFor` só funciona fora do Railway).

## 6. Backup da configuração fiscal

`scripts/fiscal-backup-config.js` exporta FiscalIssuer completo + campos fiscais de Store pra **`C:\Users\sport\TenisCashBackups\fiscal-config-<data>.json`** (CONTÉM CSC e tokens → fica FORA do repositório, NUNCA commitar). Rodar após qualquer mudança de emitente/roteamento. Restauração = upsert por CNPJ.
