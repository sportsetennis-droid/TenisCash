# Runbook — Cupom Fiscal NFC-e + Impressora Térmica (TM-T20X)

> Última atualização: **2026-06-06**. Cobre tudo que foi feito/corrigido no dia e como
> replicar pra outras lojas (02, 03, 05, 06).

---

## 1. O que mudou em 2026-06-06 (resumo executivo)

Tudo abaixo é **código CENTRAL** (deploy único no Railway) → **vale pra TODAS as lojas
automaticamente**. Não há nada de código pra "instalar por loja".

| # | Mudança | Efeito | Commit |
|---|---|---|---|
| 1 | **Protocolo da DANFE deixou de sair zerado** | Cupom imprimia `Protocolo 000000000000000`; agora mostra o protocolo real da SEFAZ | `c51d739` |
| 2 | **Cupom de impressão virou HTML 80mm** (era PDF) | Corta no fim do conteúdo, sem rolo de papel em branco | `8f59b39` |
| 3 | **Largura calibrada 62mm** | A TM-T20X só imprime ~64mm úteis dos 80mm; 62mm não corta a lateral | `e6e90ec`→`1b0df98` |
| 4 | **Centralização + offset de 4mm** | A impressora imprime deslocada ~3,5mm; compensado pra centralizar | `6f77c31`→`1061762` |
| 5 | **Fonte maior + números em negrito** | Térmica imprime negrito muito mais nítido (tira o "comido") | `a6edee2` |
| — | **LOJA01 (Baratão) instalada ponta a ponta** | Emissão NFC-e + impressora TM-T20X física | (setup) |

### 1.1 Detalhe técnico de cada mudança

**(1) Protocolo zerado** — A biblioteca `node-sped-pdf` (DANFCe) cravava o protocolo como
zeros e ignorava o real. Além disso o `xmlContent` guarda só a NFe assinada, sem `protNFe`.
Correção em 2 partes:
- `src/routes/fiscal.js` → `buildNfeProcForDanfe()`: envolve a NFe assinada num `nfeProc`
  com o `protNFe` montado de `doc.protocol`/`accessKey`/`createdAt`. Usado no `/documents/:id/danfe`.
- `scripts/patch-sped-pdf.js` (roda no **postinstall** do `package.json`): corrige no
  `node-sped-pdf` o protocolo, a data de autorização e a URL de consulta (estava cravada em
  `sefaz.mt.gov.br` → passa a usar a `urlChave` do XML = PB). **Idempotente**, sobrevive a
  redeploy (o Railway reconstrói `node_modules`). Só afeta a IMPRESSÃO, não o XML da SEFAZ.

**(2)–(5) Cupom HTML térmico** — `src/services/cupomThermal.js` (`buildCupomThermalHtml(doc)`),
servido por `GET /api/admin/fiscal/documents/:id/print` (em `src/routes/fiscal.js`).
- Monta o DANFE NFC-e como **HTML nativo** a partir do XML autorizado (emitente, itens,
  totais, forma de pagamento, chave, consumidor, nº/série, protocolo, **QR gerado via `qrcode`**,
  tributos Lei 12.741).
- `@page { size: 80mm auto }` → altura = conteúdo → impressora corta no fim (sem desperdício).
- **O PDF legal continua intacto** em `GET /api/admin/fiscal/documents/:id/danfe`.

---

## 2. Calibração da impressora (valores no `cupomThermal.js`)

A TM-T20X tem papel de 80mm mas **só imprime ~64mm úteis**, e desloca a impressão ~3,5mm pra
direita. Calibração atual (no CSS do `cupomThermal.js`):

```
@page { size: 80mm auto; margin: 0 }   /* página = papel (sem escala) */
html  { width: 80mm }
body  { width: 62mm; margin: 0 0 0 5mm } /* 62mm útil, deslocado 5mm p/ centralizar */
font-size: 10.5px; números/valores em negrito (.b = 800); chave 10px bold
```

> ⚠️ **Replicação:** isso foi calibrado na impressora da LOJA01. Outras TM-T20X (mesmo modelo)
> devem imprimir igual. **Se alguma loja sair descentralizada**, ajustar só o `margin-left` do
> `body` em `cupomThermal.js` (mais à esquerda = menos mm; mais à direita = mais mm) e
> redeployar. Como o arquivo é central, a calibração é compartilhada por todas as lojas.

---

## 3. Runbook A — Instalar a impressora TM-T20X numa loja

Pré: a loja já emite NFC-e (ver Runbook B). Feito na máquina **da loja** (via AnyDesk).

1. **Baixar o driver** (EPSON Advanced Printer Driver 6 / APD):
   `https://download-center.epson.com` → digitar `TM-T20X` → SO Windows 64-bit →
   "Advanced Printer Driver" (arquivo `APD_612_T20X_WM.zip`, ~35 MB).
   - Alternativa por comando (PowerShell, baixa direto):
     `Invoke-WebRequest "<url do zip>" -OutFile "$env:TEMP\apd.zip" -UseBasicParsing`
2. **Extrair** e rodar **`APD_612_T20X.exe` como administrador**.
   - ⚠️ AnyDesk precisa **mostrar o aviso de permissão (UAC)** — se não aparecer, a instalação
     trava. (Na LOJA01 funcionou; se não aparecer, habilitar elevação no AnyDesk.)
3. No instalador: **Install** → impressora **ligada no USB** → instala **"EPSON TM-T20X Receipt"**.
4. Na tela **"EPSON TM Printer Settings"**: Port Type = **Auto Setup** → marcar
   **Set as Default Printer** → **Save Settings** → **Test Print** → **Close**.
5. Conferir (PowerShell): `Get-Printer | ft Name,DriverName,PortName` → deve aparecer
   `EPSON TM-T20X Receipt`.
6. Testar um cupom real pelo PDV → confere largura (não corta lateral) e que corta no fim.

**Densidade (deixar mais escuro, opcional):** ajuste de densidade fica na impressora
(EPSON TM-T20X Utility / driver). Vem média de fábrica.

---

## 4. Runbook B — Habilitar uma loja a emitir NFC-e (agente fiscal)

Para **LOJA05 (Tambaú)** e **LOJA06 (Tambiá)** — hoje **sem agente fiscal**. Ver detalhes em
`memory/project_teniscash_fiscal_agent.md`. Resumo:

1. Instalar o **fiscal-agent** (stateless v2.0) na máquina da loja (Node + `setup.ps1` +
   certificado PFX da empresa via Tailscale).
2. Subir o **Tailscale funnel** da máquina e pegar a URL pública (`https://<host>.tailXXXX.ts.net`).
3. No banco, gravar na `Store` da loja: `fiscalAgentUrl` + `fiscalAgentToken` (X-Agent-Token).
4. Conferir `FiscalIssuer`: CNPJ, `nfceSerie` (evitar colisão com a Chianca — TenisCash usa
   série diferente), `nfceNextNumber`, `environment=production`, `active=true`.
5. Emitir 1 cupom de teste (R$1) → validar cStat 100 (autorizado).
6. Instalar a impressora (Runbook A).

**Armadilhas conhecidas** (do histórico): Tailscale conta Apple; funnel "frio" (~30s);
setup.ps1 em ASCII; PowerShell admin + `ExecutionPolicy Bypass`; AnyDesk não cola multi-linha
(usar comando de 1 linha) e quebra o copy-from-loja.

---

## 5. Status fiscal por loja (2026-06-06)

| Loja | CNPJ | Agente fiscal | Série | NFC-e emit. | Cupom novo (código) | Impressora TM-T20X | Pendência |
|---|---|---|---|---|---|---|---|
| **01** Baratão | …0001-26 | ✅ máquina própria | 2 | 22 | ✅ ativo | ✅ instalada hoje | — |
| **02** Bessa | …0002-07 | ✅ | 1 | 5 | ✅ **já vale** (verificado) | ⏳ instalar | impressora |
| **03** Rainha | …0003-98 | ✅ | 2 | 2 | ✅ **já vale** (verificado) | ⏳ instalar | impressora |
| **04** Ecom | …0004-79 | ✅ agent | 1 | 0 | ✅ vale | n/a (online) | — |
| **05** Tambaú | …0005-50 | ❌ | 1 | 0 | ✅ valerá ao emitir | ⏳ instalar | **agente + impressora** |
| **06** Tambiá | …0006-30 | ❌ | 1 | 0 | ✅ valerá ao emitir | ⏳ instalar | **agente + impressora** |

### Checklist de execução
- **02 e 03 (agora):** código ✅ (verificado renderizando os cupons reais deles). Falta só a
  **impressora física** (Runbook A) na máquina de cada uma.
- **05 e 06 (próxima sessão, ~horas):** Runbook B (agente fiscal) + Runbook A (impressora).
  CNPJ/série já cadastrados; falta `fiscalAgentUrl`+`token` e o setup na máquina.

---

## 6. Arquivos-chave (onde mexer)

| Arquivo | Função |
|---|---|
| `src/services/cupomThermal.js` | **Cupom térmico HTML** (layout, calibração 62mm/offset, fonte/negrito) |
| `src/routes/fiscal.js` | Rotas `/documents/:id/print` (HTML) e `/danfe` (PDF) + `buildNfeProcForDanfe` |
| `scripts/patch-sped-pdf.js` | Patch do `node-sped-pdf` (protocolo/data/URL) — roda no postinstall |
| `package.json` | `"postinstall": "node scripts/patch-sped-pdf.js"` |
| `memory/project_teniscash_fiscal_agent.md` | Detalhes do agente fiscal por loja |

**Endpoints:** impressão = `GET /api/admin/fiscal/documents/:id/print?token=…` (HTML, auto-print).
PDF legal = `GET /api/admin/fiscal/documents/:id/danfe?token=…`.
