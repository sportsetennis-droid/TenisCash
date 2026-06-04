# Runbook — Implantar o Fiscal Agent numa nova loja (1 CNPJ por loja)

> Emissão de NFC-e (cupom fiscal modelo 65) pelo TenisCash, reusando o **certificado A1 da Chianca** que já está na máquina da loja. **Validado em produção na LOJA02 (Bessa) em 2026-06-04.**
> Cada loja = **1 CNPJ = 1 FiscalIssuer = 1 certificado = 1 CSC = numeração própria**. Nada é compartilhado entre lojas.

---

## 0. Arquitetura (como o cupom sai)

```
PDV (loja.html) → venda registrada
      │  (auto-emite na hora)
      ▼
central TenisCash (Railway)  ──HTTPS──►  Tailscale Funnel da loja
  /api/admin/fiscal/...                  https://<host-da-loja>.tail0386f5.ts.net
      │                                          │ (→ localhost:8765 dentro da loja)
      │                                          ▼
      │                                   FISCAL AGENT (Node, roda NA loja)
      │                                   - lê o PFX da Chianca local
      │                                   - assina (node-forge) + transmite
      │                                          │
      │                                          ▼
      │                                   SEFAZ-PB via SVRS (NFC-e)
      ◄───────── cStat 100 + chave + protocolo ──┘
      ▼
FiscalDocument 'authorized' → DANFE imprime na térmica (Epson TM-T20)
```

**Por que o agente roda NA loja:** o certificado A1 e a senha **nunca saem da máquina da loja**. O central só manda dados (issuer + itens + nNF); o agente assina localmente.

**Numeração:** `FiscalIssuer.nfceNextNumber` começa em **100000** por CNPJ (acima da faixa que a Chianca já usou — evita colisão/duplicidade na SEFAZ). Cada CNPJ tem a sua sequência.

---

## 1. CNPJs do grupo (Meta Esportes)

| Loja | CNPJ | Status agente | Cert Chianca (padrão) |
|------|------|---------------|------------------------|
| LOJA01 Baratão dos Esportes | 44.052.617/0001-26 | ❌ pendente | `C:\Chianca\NFe_Emissao001\*.pfx` |
| **LOJA02 S&T Bessa** | 44.052.617/0002-07 | ✅ **EM PRODUÇÃO** | `C:\Chianca\NFe_Emissao002\Certificado2026.pfx` |
| LOJA03 S&T Rainha da Borborema | 44.052.617/0003-98 | ❌ pendente (já tem Tailscale 100.91.132.63) | `C:\Chianca\NFe_Emissao003\*.pfx` |
| LOJA04 S&T Ecommerce | 44.052.617/0004-79 | ❌ pendente | (sem loja física — ver nota) |
| LOJA05 S&T Tambaú | 44.052.617/0005-50 | ❌ pendente | `C:\Chianca\NFe_Emissao005\*.pfx` |
| LOJA06 S&T Tambiá | 44.052.617/0006-30 | ❌ pendente | `C:\Chianca\NFe_Emissao006\*.pfx` |

> O padrão `NFe_Emissao00X` casa com o número da loja, mas **confirme na máquina** — pode variar. O `setup.ps1` auto-detecta qualquer `C:\Chianca\NFe_Emissao*` com `.pfx` dentro.
> **LOJA04 (ecommerce)** não tem PDV físico; a emissão dela é NFe modelo 55 (não NFC-e) e segue outro fluxo — não use este runbook pra ela ainda.

---

## 2. Pré-requisitos por loja

1. **A máquina da loja tem a Chianca instalada e emitindo hoje** (logo tem o `.pfx` + a senha no `ConfigNFe.ini` + um **CSC já registrado** na SEFAZ-PB pra aquele CNPJ).
2. **Acesso à máquina** (AnyDesk pra ver a tela + colar comando, OU rodar direto nela).
3. **A matriz precisa estar servindo os arquivos do agente** na porta 8000 (ver passo 3.0).
4. **Conta Tailscale correta:** `bernardo_douglas@icloud.com` (Apple/iCloud). **NÃO** `sportsetennis-droid` (GitHub) — é outra tailnet.

---

## 3. Passo a passo

### 3.0 (Na matriz) garantir o servidor de arquivos do agente

O `setup.ps1` baixa o agente da matriz em `http://100.106.212.108:8000`. Garanta que esse servidor está de pé na matriz:

```powershell
# Na MATRIZ (host SPORTSETENNIS), serve a pasta do agente na porta 8000:
node C:\Users\sport\TenisCash\agents\fiscal-agent\serve_agent.js   # (ou o serve_agent.js no %TEMP%)
```
> O servidor entrega `index.js`, `fiscalSefazDirect.mjs`, `fiscalAcquirers.js`, `package.json`, `setup.ps1` e o `_lojaprobe.mjs`. Ele só é acessível pela tailnet.

### 3.1 (Na loja) Tailscale

Se a loja **não tem** Tailscale:
```powershell
# instala via MSI (não há winget garantido):
Invoke-WebRequest 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile "$env:TEMP\ts.msi" -UseBasicParsing
Start-Process msiexec.exe -ArgumentList '/i', "`"$env:TEMP\ts.msi`"", '/quiet','/norestart' -Wait
```
Logar na conta certa — gere uma **auth key reutilizável** no admin (https://login.tailscale.com/admin/settings/keys, conta Apple) e:
```powershell
& "C:\Program Files\Tailscale\tailscale.exe" up --authkey=tskey-auth-XXXXXXXX --force-reauth
```
> ⚠️ NÃO use o fluxo interativo de login (cai no account-picker e às vezes na tailnet errada). A auth key reutilizável é determinística.
> Confirme: `tailscale status` deve mostrar a conta `...@icloud.com` e a loja com IP `100.x`.

### 3.2 (Na loja) instalar o agente

PowerShell **Administrador**:
```powershell
New-Item -ItemType Directory -Force -Path C:\TenisCashAgent | Out-Null
Invoke-WebRequest http://100.106.212.108:8000/setup.ps1 -OutFile C:\TenisCashAgent\setup.ps1 -UseBasicParsing
cd C:\TenisCashAgent
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup.ps1
```
O `setup.ps1` (idempotente): instala Node 20 (MSI se faltar winget) → baixa o agente → `npm install` → pergunta o **código da loja** (ex `LOJA03`) → **auto-detecta o PFX** em `C:\Chianca\NFe_Emissao*` e a senha no `ConfigNFe.ini` → gera o **AGENT_TOKEN** → registra a Scheduled Task `TenisCashFiscalAgent` (SYSTEM, no boot, auto-restart) → valida `GET /health`.

**Anote o `AGENT_TOKEN`** que ele imprime em amarelo no final (precisa pro cadastro no central).

> **node-forge:** o agente usa node-forge pra ler o PFX (sem openssl). O `npm install` já o traz (está no package.json). Confirme: `Test-Path C:\TenisCashAgent\node_modules\node-forge` → True.

### 3.3 (Na loja) expor o agente — **Funnel da própria loja** (recomendado)

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" funnel --bg 8765
& "C:\Program Files\Tailscale\tailscale.exe" funnel status   # confirma a URL pública
```
Isso publica o agente em **`https://<host-da-loja>.tail0386f5.ts.net`** (o Funnel encaminha pra `localhost:8765` — **não precisa de regra de firewall inbound**, e remove a dependência da matriz).
> O Funnel já está habilitado na tailnet. O host aparece no `tailscale status` (ex LOJA02 = `desktop-rs4674n`).
> **Segurança:** o Funnel é HTTPS público, mas todo endpoint do agente (menos `/health`) exige o header `X-Agent-Token`. Mantenha o token secreto. (Hardening futuro: pôr o central na tailnet via sidecar e dispensar o Funnel.)

### 3.4 (Na matriz/central) cadastrar o emissor + loja

Você precisa de: **CNPJ, IE, CSC + idCSC, endereço completo, a URL do Funnel (3.3) e o AGENT_TOKEN (3.2)**.
- **CSC + idCSC:** pegue da config da Chianca da loja (mesmo lugar do CSC da LOJA02: `<codigo_csc>...</codigo_csc><identificador_csc>...</identificador_csc>`) ou gere no portal SEFAZ-PB. É **por CNPJ**.
- **Endereço/IE:** do cadastro da empresa (ou do próprio certificado).

Rode o script parametrizado (preencha o bloco `CONFIG` no topo dele):
```powershell
# Na MATRIZ:
node C:\Users\sport\TenisCash\scripts\fiscal-register-store.js
```
Ele faz `upsert` do **FiscalIssuer** (CNPJ, IE, CSC, cscId, endereço, `environment='production'`, `nfceNextNumber=100000`, `crt=3`) e liga na **Store** (`fiscalIssuerId`, `fiscalAgentEnabled=true`, `fiscalAgentUrl=<funnel>`, `fiscalAgentToken=<token>`).

### 3.5 (Na matriz) teste de validação em PRODUÇÃO (R$1, cancela na hora)

Antes de soltar pra venda real, valide a ponta: emite R$1 em produção e **cancela**. (Use o template `scripts/_diag_emit_prod.js` ajustando o `issuerId` da loja — ele emite, confere cStat 100 e cancela.)
Esperado: `status=100 (Autorizado)` na emissão e `status=135` no cancelamento.

### 3.6 (Na loja) primeira venda real + impressão

No PDV (`teniscash.com.br/loja` logado como a loja): faça **uma venda pequena real**, confirme **"NFCe AUTORIZADA automaticamente"**, clique **Imprimir DANFE** → sai na térmica.
> **Mantenha a Chianca como backup** até sair 2–3 cupons reais certos por esta loja.

---

## 4. Armadilhas (tudo que quebrou na LOJA02 — já corrigido no código, mas é bom saber)

| Sintoma | Causa | Onde está resolvido |
|---|---|---|
| Agente **trava sem erro** (health para) | `node-sped-nfe` assina via `pem`→`openssl` do sistema, que a loja não tem → callback nunca volta | patch `pem.readPkcs12` → node-forge em `fiscalSefazDirect.mjs` |
| SEFAZ **reseta TLS** no handshake | Node 20 oferece TLS 1.3; SVRS (homolog) derruba | `minVersion/maxVersion: 'TLSv1.2'` |
| `read ECONNRESET` depois do POST | SVRS renegocia pra pedir o cert; OpenSSL 3 bloqueia renegociação legada | `secureOptions: SSL_OP_LEGACY_SERVER_CONNECT \| ALLOW_UNSAFE_LEGACY_RENEGOTIATION` |
| 1ª conexão "fria" cai | instabilidade SEFAZ | `_sefazPost` com retry |
| cStat **725 CFOP inválido** | central mandava o CFOP de **compra** do produto (ex 6101) | força **5102** (venda interna) em `fiscal.js` + `seller.js` |
| cStat **391 dados do cartão** | PIX/cartão (tPag 17/03/04) sem grupo `<card><tpIntegra>` | `buildDetPag` em `fiscalAcquirers.js` |
| **unique constraint** (issuerId,docType,serie,number) | documento fantasma travando o número | numeração `max(nfceNextNumber, maxDoc+1)` + limpeza de fantasma |
| "Token não fornecido" ao imprimir | `/print` exige auth e o link abre sem header | `authMiddleware` aceita `?token=`; PDV anexa o token |
| Cert errado da cadeia | PFX ICP-Brasil traz CA junto; pegar `certBags[0]` cego pega a CA | seleciona o cert-folha que casa com a chave privada |
| Tailscale na conta errada | logou em `sportsetennis-droid` (GitHub) | usar **auth key reutilizável** da conta `bernardo_douglas@icloud.com` |
| `setup.ps1` com mojibake | PS 5.1 lê UTF-8 errado | arquivo é ASCII puro |
| sem winget | — | `setup.ps1` instala Node por MSI direto |

---

## 5. Checklist de validação (por loja)

- [ ] `tailscale status` → conta `@icloud.com`, loja com IP `100.x`
- [ ] `GET http://localhost:8765/health` → `{"ok":true,"store":"LOJAxx","pfxExists":true}`
- [ ] `node_modules\node-forge` existe
- [ ] `tailscale funnel status` → URL pública `https://<host>.tail0386f5.ts.net`
- [ ] FiscalIssuer cadastrado (CNPJ, IE, CSC, cscId, endereço, `nfceNextNumber=100000`, `environment=production`)
- [ ] Store ligada (`fiscalAgentEnabled=true`, `fiscalAgentUrl`=funnel, `fiscalAgentToken`)
- [ ] `GET https://<funnel>/health` (da matriz) → ok
- [ ] Teste R$1 produção → **cStat 100**, cancelado → **cStat 135**
- [ ] Venda real no PDV → "NFCe AUTORIZADA automaticamente" + DANFE imprime
- [ ] Chianca mantida de backup por alguns dias

---

## 6. Pendências / melhorias (revisão ultracode 2026-06-04)

Uma revisão adversarial achou 17 bugs (caminho feliz OK; quebram sob carga/timeout/concorrência). **Hardening em revisão** (corrige antes de escalar pra muitas lojas):
- **Numeração atômica** (transação) — hoje 2 caixas simultâneos podem colidir.
- **Nunca apagar doc em timeout** + **reconciliação** de NFCe presa em `processing` (evita nota órfã autorizada na SEFAZ e ausente do banco).
- **Tratar duplicidade (204/539)** consultando a SEFAZ pra recuperar a autorização.
- **Guardar o `nfeProc`** (NFe + protNFe), não só a NFe assinada — pro arquivo fiscal e pro protocolo na DANFE.
- **IDOR**: hoje qualquer vendedor baixa o DANFE de qualquer loja — falta scope por loja.

> **Recomendação:** aplicar o hardening **antes** de implantar nas 4 lojas restantes — vários desses bugs (numeração/órfã/duplicidade) ficam mais prováveis quanto mais CNPJs/volume.

---

## Arquivos-chave

- Agente (roda na loja): `agents/fiscal-agent/{index.js, fiscalSefazDirect.mjs, fiscalAcquirers.js, setup.ps1}`
- Central: `src/routes/fiscal.js` (emissão/DANFE), `src/routes/seller.js` (auto-emit na venda), `src/services/fiscalAgentClient.js` (chama o agente)
- Cadastro: `scripts/fiscal-register-store.js`
- Memória/contexto: `~/.claude/.../memory/project_teniscash_fiscal_agent.md`
