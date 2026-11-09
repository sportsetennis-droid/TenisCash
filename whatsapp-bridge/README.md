# Ponte WhatsApp do TenisCash (não-oficial, via QR)

Programa que você roda **na sua máquina que fica ligada** (PC da loja ou uma VPS).
Mostra um **QR**, você escaneia com o WhatsApp, e os **avisos do TenisCash**
(treino marcado, lembrete, etc.) passam a sair no **seu WhatsApp**.

## ⚠️ Leia antes
- Isso é **WhatsApp Web automatizado** (não é a API oficial). **É contra as regras
  da Meta** e o número que escanear **pode ser banido**.
- **Use um número DEDICADO**, não o do seu atendimento principal. Se banir um chip
  dedicado, você não perde o atendimento do negócio.
- Não envie propaganda em massa por aqui — só os avisos operacionais. Quanto menos
  volume e mais devagar, menor o risco.

## Onde roda
Qualquer máquina com **Node 18+** que **fique ligada o tempo todo**:
- Um **PC da loja** que não desliga, ou
- Uma **VPS barata** (Contabo, Hetzner, DigitalOcean, etc.).

**Não roda no Railway** — o servidor reinicia e perde a sessão do WhatsApp.

## Passo a passo
1. Instale o Node 18+ (https://nodejs.org).
2. Nesta pasta, rode:
   ```
   npm install
   ```
3. Defina a chave secreta (a MESMA que está no servidor, variável `WA_BRIDGE_KEY`):
   - Windows (PowerShell): `$env:WA_BRIDGE_KEY="suachave"`
   - Mac/Linux: `export WA_BRIDGE_KEY=suachave`
4. Rode:
   ```
   npm start
   ```
5. Vai aparecer um **QR no terminal**. No WhatsApp do número dedicado:
   **Configurações → Aparelhos conectados → Conectar um aparelho** → aponte pro QR.
6. Apareceu `✅ WhatsApp conectado` = pronto. **Deixe o programa aberto.**
   A sessão fica salva na pasta `.wwebjs_auth` — não precisa reescanear toda vez
   (só se ela for apagada ou o WhatsApp desconectar o aparelho).

## Como funciona por dentro
- A cada ~15s o programa pergunta pro servidor: "tem aviso pra mandar?"
  (`GET /api/wa/pending`), envia um por vez com pausa, e marca como enviado
  (`POST /api/wa/sent`). Tudo protegido pela `WA_BRIDGE_KEY`.
- No servidor, os avisos são enfileirados automaticamente quando a `WA_BRIDGE_KEY`
  está configurada. Sem a chave, nada é enfileirado (fica só o aviso no app).

## Parar
Feche o programa (Ctrl+C). Os avisos voltam a ficar só no app (sininho) até você
abrir de novo.
