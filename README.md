# TenisCash - Banco Digital Esportivo

Moeda digital da Sports & Tennis.

## Como publicar no Railway (passo a passo)

### 1. Suba o código pro GitHub

No seu computador (ou peça pra alguém fazer):

```bash
git clone [seu-repo]
# copie todos esses arquivos pra dentro da pasta
git add .
git commit -m "TenisCash v1.0"
git push origin main
```

### 2. No Railway (railway.com)

1. Clique em **+ Novo** > **Deploy from GitHub repo**
2. Selecione o repositório do TenisCash
3. Aguarde o deploy inicial (vai falhar porque falta o banco - normal)

### 3. Adicione o banco de dados PostgreSQL

1. No projeto do Railway, clique em **+ Novo** > **Database** > **PostgreSQL**
2. O Railway vai criar automaticamente a variável `DATABASE_URL`
3. Clique no serviço do app > **Variables** > adicione:
   - `JWT_SECRET` = (uma string aleatória longa, tipo: `tc-2026-sportsetennis-segredo-forte`)
   - `FRONTEND_URL` = `*`

### 4. Redeploy

1. Clique no serviço do app
2. Vá em **Deployments** > clique nos 3 pontos do último deploy > **Redeploy**
3. Aguarde o build completar
4. Clique em **Settings** > **Networking** > **Generate Domain**
5. Anote a URL gerada (ex: teniscash-production.up.railway.app)

### 5. Pronto!

Acesse a URL e teste:
- Login admin: `83999990001` / PIN: `1234`
- **TROQUE O PIN DO ADMIN IMEDIATAMENTE**

## API Endpoints

### Auth
- `POST /api/auth/register` - Cadastro
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Perfil (auth)

### Carteira
- `GET /api/wallet/balance` - Saldo (auth)
- `GET /api/wallet/transactions` - Extrato (auth)

### Transferência
- `POST /api/transfer/send` - Enviar TenisCash (auth)
- `GET /api/transfer/lookup?q=telefone` - Buscar usuário (auth)

### QR Code
- `GET /api/qr/generate` - Gerar QR (auth)
- `POST /api/qr/validate` - Validar QR (admin)

### Promoções
- `GET /api/promos` - Listar promos (auth)
- `GET /api/promos/brands` - Regras por marca (auth)

### Admin
- `GET /api/admin/dashboard` - Dashboard (admin)
- `POST /api/admin/credit` - Creditar TenisCash (admin)
- `POST /api/admin/debit` - Debitar TenisCash (admin)
- `POST /api/admin/sale` - Registrar venda (admin)
- `POST /api/admin/use` - Usar TenisCash na compra (admin)
- `POST /api/admin/promos` - Criar promo (admin)
- `PUT /api/admin/promos/:id` - Atualizar promo (admin)
- `POST /api/admin/brands` - Configurar regra de marca (admin)
- `GET /api/admin/brands` - Listar regras (admin)
- `POST /api/admin/config` - Atualizar config (admin)
- `GET /api/admin/users` - Listar usuários (admin)
- `GET /api/admin/log` - Log de ações (admin)

## Regras do TenisCash

- R$1 gasto = 1 TenisCash
- Saldo eterno, nunca expira
- Transferência ilimitada entre usuários
- Abatimento máximo varia por marca (configurável)
- Promoções com abatimento sem limite (configurável)
- Bônus de boas-vindas configurável

## Stack

- Node.js + Express
- PostgreSQL + Prisma ORM
- JWT para autenticação
- Railway para hospedagem
