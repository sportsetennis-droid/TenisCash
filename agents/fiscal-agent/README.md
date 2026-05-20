# TenisCash Fiscal Agent

Agente leve que roda **dentro da máquina de cada loja**. Recebe ordens do TenisCash central via Tailscale, usa o PFX/CSC locais pra assinar NFCe/NFe, envia direto pra SEFAZ-PB e retorna o resultado.

**Segredos (PFX/senha/CSC) nunca saem da máquina da loja.**

## Pré-requisitos por máquina

- Windows 10/11
- **Certificado A1 instalado** (geralmente em `C:\Chianca\NFe_Emissao0XX\Certificado*.pfx`)
- **CSC gerado** no portal SEFAZ-PB pro CNPJ daquela loja
- **Tailscale instalado e logado** na mesma conta (ver `setup-tailscale.md`)
- PowerShell aberto **como Administrador**

## Instalação por loja — comando único

Na máquina remota (via AnyDesk), PowerShell **admin**, cola:

```powershell
New-Item -ItemType Directory -Force -Path C:\TenisCashAgent | Out-Null
Invoke-WebRequest http://100.106.212.108:8000/setup.ps1 -OutFile C:\TenisCashAgent\setup.ps1
cd C:\TenisCashAgent
.\setup.ps1
```

O `setup.ps1`:
1. Detecta/instala Node 20 LTS (sem precisar reabrir terminal)
2. Baixa os arquivos do agente (index.js, fiscalSefazDirect.mjs, fiscalAcquirers.js, package.json) da matriz via Tailscale
3. Roda `npm install`
4. Pergunta: código da loja (LOJA02, LOJA03, etc)
5. **Detecta automaticamente** o PFX em `C:\Chianca\NFe_Emissao*\` e lê a senha do `ConfigNFe.ini` (se não achar, pergunta)
6. Gera AGENT_TOKEN aleatório de 32 chars
7. Cria `.env` (UTF-8 sem BOM, line endings Unix)
8. Registra Scheduled Task que sobe o agente no boot como SYSTEM com restart automático
9. Inicia
10. **Valida** `GET /health` — só imprime sucesso se a resposta voltar correta

Saída esperada no final:

```
=== INSTALAÇÃO VALIDADA ===
Local: C:\TenisCashAgent
Log: agent.log
Health: http://localhost:8765/health

AGENT_TOKEN (passar pra Douglas cadastrar no central):
  <32 chars hex aleatorios>

✓ tudo OK
```

## Pós-instalação — central

Pegando o **AGENT_TOKEN** que o setup imprimiu + IP Tailscale dessa máquina (ver `tailscale ip -4`), cadastrar no admin do TenisCash:

```
Store.fiscalAgentUrl     = "http://100.X.Y.Z:8765"
Store.fiscalAgentToken   = "<AGENT_TOKEN>"
Store.fiscalAgentEnabled = true
```

Depois disso, qualquer venda na loja → `/api/admin/fiscal/emit-nfce-from-sale` roteia via Tailscale → o agente local da loja emite NFCe.

## Endpoints expostos

| Path | Auth | Descrição |
|---|---|---|
| `GET /health` | nenhum | Status do agente + PFX |
| `POST /emit-nfce` | `X-Agent-Token` | Emite NFCe modelo 65 |
| `POST /emit-nfe55` | `X-Agent-Token` | Emite NFe modelo 55 (B2B/ecommerce) |
| `POST /cancel` | `X-Agent-Token` | Cancela documento (até 24h) |
| `POST /correction` | `X-Agent-Token` | CCe (Carta de Correção) NFe 55 |

Body do `POST /emit-nfce`:

```json
{
  "issuer": { "cnpj": "...", "csc": "...", "cscId": "...", "ie": "...", "street": "...", ... },
  "nNF": 12345,
  "items": [{"sku": "X", "name": "Y", "ncm": "64041100", "cfop": "5102", "qty": 1, "unitPrice": 100 }],
  "payment": { "tPag": "01", "valor": 100 },
  "customer": null
}
```

## Troubleshooting

**`/health` não responde:**
```powershell
Get-ScheduledTask TenisCashFiscalAgent | Select State
Start-ScheduledTask TenisCashFiscalAgent
Get-Content C:\TenisCashAgent\agent.log -Tail 20
```

**Cert path com backslash dá erro `pem`:**
O `setup.ps1` salva path com forward-slash (`C:/Chianca/...`). Se o `.env` tiver backslash, edita pra `/`.

**Numeração de NFCe drift:**
Numeração é controlada pelo central (FiscalIssuer.nfceNextNumber no banco Railway). O agente é stateless. Pra retomar após problema, ajusta no banco direto.
