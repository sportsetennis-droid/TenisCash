# Cartão TenisCash na Carteira do Google

O app do cliente pode mostrar o botão **"Adicionar à Carteira do Google"** embaixo do saldo. O botão
só aparece quando as duas variáveis abaixo estão configuradas no Railway. Sem elas, nada muda no app.

## O que o cartão mostra

- Nome do cliente.
- Saldo TenisCash **com a data e a hora em que o cliente salvou** (ex.: `T$ 120,00 (em 17/11/2026 09:30)`).
- Instrução de uso e um link "Abrir o app TenisCash (QR da loja)".

### Por que o cartão não tem QR Code

O QR que a loja lê hoje é `TC:<token>`, gerado pelo app e **válido por 5 minutos** (`src/routes/qr.js`).
Um cartão da carteira é fixo, então esse QR venceria. Para não inventar outro formato que a loja não lê,
o cartão leva o link para o app, onde o cliente abre o QR na hora. Se você quiser QR fixo no cartão,
é preciso decidir antes um identificador de membro permanente e fazer a loja aceitar esse código.

### Atualização do saldo

O saldo é o do momento em que o cliente salvou. Atualizar o cartão sozinho a cada compra exige chamar
a API REST da Google Wallet (próximo passo, não implementado). Enquanto isso, o cliente pode tocar no
botão de novo. Como o cartão tem o mesmo id, o Google mostra o cartão que ele já tem.

## O que você precisa configurar (uma vez)

1. **Google Pay & Wallet Console** — <https://pay.google.com/business/console>
   - Entre com a conta Google da empresa e crie o perfil de emissor (Issuer).
   - Anote o **Issuer ID**: um número com cerca de 19 dígitos.
   - Em "Google Wallet API", peça o acesso. Até a aprovação o cartão funciona em **modo demonstração**,
     só para as contas de teste que você cadastrar no console.
2. **Google Cloud** — <https://console.cloud.google.com>
   - Crie um projeto (ou use um existente) e ative a **Google Wallet API**.
   - Em *IAM e administrador → Contas de serviço*, crie uma conta de serviço e gere uma **chave JSON**.
   - Guarde o arquivo em lugar seguro. Ele é uma senha e **nunca** vai para o Git.
3. **Ligar a conta de serviço ao emissor**
   - No Wallet Console, em *Usuários*, adicione o e-mail da conta de serviço
     (`...@...iam.gserviceaccount.com`) com permissão de **Desenvolvedor**.
4. **Railway → Variables** (serviço da API):

| Variável | Valor |
|---|---|
| `GOOGLE_WALLET_ISSUER_ID` | o Issuer ID (só números) |
| `GOOGLE_WALLET_SA_JSON` | o conteúdo do arquivo JSON da conta de serviço **em base64** |
| `GOOGLE_WALLET_LOGO_URL` (opcional) | URL pública **https** de um logo PNG quadrado (mínimo 660×660). Sem ela, o cartão sai sem logo. |
| `GOOGLE_WALLET_CLASS_SUFFIX` (opcional) | nome da classe do cartão. Padrão: `teniscash_membro`. |

Para gerar o base64 no Windows (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\caminho\chave-wallet.json")) | Set-Clipboard
```

Depois de salvar as variáveis, o Railway reinicia. Confira:

- `GET https://teniscash.com.br/api/google-wallet/status` deve responder `{"enabled":true}`.
- Entre no app como cliente: o botão preto aparece embaixo do saldo.

## Como funciona (técnico)

- `src/services/googleWallet.js` monta um passe **genérico** (`genericObjects`) e assina um JWT RS256
  (`typ: savetowallet`, `aud: google`) com a chave da conta de serviço. O servidor não chama o Google:
  o link `https://pay.google.com/gp/v/save/<jwt>` é aberto pelo celular do cliente.
- Rotas: `GET /api/google-wallet/status` (público, só diz se está ligado) e
  `GET /api/google-wallet/save-link` (cliente logado).
- O id do cartão é um hash do id do cliente, sempre o mesmo para ele.
- `origins` do JWT = `PUBLIC_BASE_URL`. Se o domínio mudar, troque `PUBLIC_BASE_URL`.

## Para desligar

Apague `GOOGLE_WALLET_ISSUER_ID` ou `GOOGLE_WALLET_SA_JSON` no Railway. O botão some.
