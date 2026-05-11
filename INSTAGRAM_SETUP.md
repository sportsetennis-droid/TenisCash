# Setup Instagram — Sports & Tennis

Passos para conectar o Instagram da loja ao orquestrador. Você precisa fazer **uma vez** e nunca mais — depois é só usar pelo admin.

## 1. Conta Instagram Business

- Abre o Instagram da loja no celular
- **Configurações → Conta → Mudar para Conta Profissional → Empresa**
- Escolhe categoria (ex.: "Loja de artigos esportivos")

## 2. Página do Facebook

- Cria/usa uma Página do Facebook da Sports & Tennis (Página, não perfil pessoal)
- No Instagram: **Configurações → Conta → Compartilhar em outros apps → Facebook → Vincular Página**
- A Página do FB precisa ser **administrada pela mesma conta** que vai gerar o token

## 3. App no Meta for Developers

1. Vai em <https://developers.facebook.com/apps>
2. **Criar App → Empresa → Avançar**
3. Nome do app: "TenisCash" (ou qualquer um)
4. Adiciona o produto **Instagram Graph API**
5. Adiciona o produto **Facebook Login for Business**

## 4. Permissões necessárias

No app, adiciona estas permissões (em Acesso Avançado se for app de produção):
- `instagram_basic`
- `instagram_content_publish`
- `pages_show_list`
- `pages_read_engagement`
- `business_management`

## 5. Gerar token de longa duração

1. Abre o **Graph API Explorer**: <https://developers.facebook.com/tools/explorer/>
2. Seleciona o app **TenisCash**
3. Em **User Token**, marca todas as permissões acima
4. **Generate Access Token** → autoriza com a conta da loja
5. Esse token dura 1h. Para deixar de 60 dias:
   - Cola o token em <https://developers.facebook.com/tools/debug/accesstoken/>
   - Clica em **Extend Access Token**
   - Copia o novo (dura ~60 dias)

## 6. Pegar o Instagram Business Account ID

No Graph API Explorer, faz esta consulta:

```
GET /me/accounts
```

Pega o **id** da Página do Facebook. Depois:

```
GET /{PAGE_ID}?fields=instagram_business_account
```

Anota o **instagram_business_account.id** — esse é o seu `META_IG_BUSINESS_ID`.

## 7. Colocar no Railway

No Railway → projeto TenisCash → **Variables** → adicionar:

```
META_IG_ACCESS_TOKEN=<token de 60 dias>
META_IG_BUSINESS_ID=<id do passo 6>
META_GRAPH_VERSION=v21.0
```

Salva. O Railway vai redeployar automaticamente.

## 8. Testar

No admin **Central IA**, vai ter um botão "Status Instagram" — clica. Deve aparecer o nome da conta, foto, seguidores. Se der erro, copia a mensagem e me manda.

## 9. Renovar token (a cada 60 dias)

Token de 60 dias expira. Quando expirar:
- Volta no Graph API Explorer
- Gera novo token
- Estende para 60 dias
- Atualiza `META_IG_ACCESS_TOKEN` no Railway

Pra evitar isso, pode fazer um **System User Token** que não expira (mais complexo, faz só se quiser):
- Meta Business Suite → Configurações → Usuários do Sistema → criar → atribuir permissões → gerar token

## Limitações que você precisa saber

- **Toda imagem precisa estar em URL pública** (jpg/png). Instagram não aceita upload de arquivo via API.
  - Solução simples: subir a arte pro próprio servidor TenisCash (pasta `public/`) ou pra um Cloudinary/S3
- **Stories**: API aceita imagem ou vídeo, mas **não aceita stickers interativos** (enquete, link, etc.) — pra isso só pelo app mesmo
- **Limite**: 25 posts por dia por conta
- **Carrossel**: dá suporte futuro, não está implementado ainda
- **Reels**: requer vídeo, não está implementado ainda

## O fluxo dentro do TenisCash

1. Rodar orquestrador no admin
2. Marketing-agent + Design-brief-agent geram conceito + briefing visual
3. Você gera a arte (claude.ai/design, Canva, designer)
4. Sobe a arte pra um URL público (servidor, Cloudinary, etc)
5. Cola o URL no admin → cria uma aprovação `instagram_feed` ou `instagram_story`
6. Aprova
7. Sistema posta automaticamente
