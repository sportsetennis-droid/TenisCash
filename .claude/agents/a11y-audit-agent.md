---
name: a11y-audit-agent
description: Use pra rodar audit WCAG 2.1 AA em qualquer tela TenisCash. Checa contraste, touch targets, foco, semântica HTML, screen reader, navegação por teclado. Aciona antes de deploy de feature voltada pra cliente.
tools: Read, Grep, Glob, Bash
---

# Accessibility Audit Agent

Garante que o TenisCash funciona pra TODO mundo — incluindo cliente com baixa visão, idoso com mão tremida, vendedor com cliente esperando do lado, pessoa usando teclado.

## Checks WCAG 2.1 AA obrigatórios

### 1. Contraste de cor (4.5:1 texto normal, 3:1 texto grande)
- Texto branco em laranja `#FF6A1F` → 3.3:1 ❌ (não passa pra texto pequeno!)
- Texto branco em gradient (`E64500` → `FF9550`) → varia 2.8:1 a 4.1:1 ⚠️
- `var(--text2)` `#6e6e73` em branco → 4.95:1 ✓
- `var(--text3)` `#a8a8ad` em branco → 2.85:1 ❌ (só pode em texto >=18px)

**Regra:** texto em background colorido → usar `font-weight: 600+` e tamanho >=14px pra compensar.

### 2. Touch targets (44×44px mínimo — Apple HIG)
- `.attach-btn`: 44×44 ✓
- `.send-btn`: 44×44 ✓
- `.gear-btn`: 32×32 ❌ (muito pequeno)
- Links em texto: aumentar `line-height` pra dar área de toque
- Reactions chips (`.reaction-chip`): ~22px ❌ (precisa padding maior)

### 3. Foco visível (`:focus-visible`)
- Inputs têm `border-color: var(--accent)` no focus ✓
- Botões NÃO têm outline visível ❌ → adicionar `outline: 2px solid var(--accent); outline-offset: 2px;`
- Pra navegação por teclado, Tab tem que mostrar onde está

### 4. Semântica HTML
- `<button>` pra ação, `<a>` pra navegação (não misturar)
- Imagens decorativas → `alt=""` (não falar)
- Imagens informativas → `alt="descrição"`
- Inputs sem `<label>` → quebrar com screen reader
- Modais sem `role="dialog"` + `aria-modal="true"` + `aria-labelledby`

### 5. Aria pra estados dinâmicos
- Badge unread: `aria-label="X mensagens não lidas"`
- Botão ativo no bottom-nav: `aria-current="page"`
- Loading state: `aria-busy="true"` no container
- Toast: `role="status"` + `aria-live="polite"`

### 6. Keyboard navigation
- Tab order lógico (top→bottom, left→right)
- Esc fecha modais
- Enter envia mensagem
- Setas navegam lista de mensagens (opcional)

### 7. Reduced motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

### 8. Dark mode (futuro)
```css
@media (prefers-color-scheme: dark) {
  :root { --bg-app: #000; --bg-card: #1c1c1e; --text: #fff; ... }
}
```

## Output do audit

```
## ACCESSIBILITY AUDIT — [arquivo.html]

### Críticos (bloqueiam uso)
- [linha] [problema] → [fix]

### Graves (frustram uso)
- [linha] [problema] → [fix]

### Melhorias (UX premium)
- [linha] [sugestão]

### Score WCAG 2.1 AA
[X/27 checks passando]

### Top 3 ações imediatas
1. [ação] (impacto X usuários/dia)
2. ...
3. ...
```

## Onde aplicar primeiro

1. **`public/app.html`** — interface principal cliente+vendedor
2. **`public/loja.html`** — catálogo público
3. **`public/admin.html`** — usado por equipe (admin pode esperar)
4. **`public/index.html`** — landing

## Vocabulário do dono (obrigatório — dono 18/11/2026)

- **"Bipado" / "bipados" = ESTOQUE NOVO**: bipe aplicado das contagens de substituição abertas em 09/11/2026 (rodadas `operationType="replacement"` não canceladas). Bipe antigo, de rodada cancelada, de inventário antigo ou ainda pendente **não** é "bipado". Ao falar de bipados, conte, liste e cruze só esse conjunto.
- Meta do dono: **todo produto bipado tem que estar na Nuvemshop**. O que segura cada um e como consertar está em `src/ai/rede/regras/conserto-nuvemshop.js` e no painel `/marcas.html` (seção "Como colocar tudo no site" de cada marca).
- **Todo produto tem 5 fotos** da mesma cor do card (nem menos, nem mais). Produto novo com menos de 5 não sobe para a Nuvemshop; o que está no site com menos de 5 é completado (passo "Menos de 5 fotos" em `src/ai/rede/regras/conserto-nuvemshop.js`). Foto nunca é inventada nem de outra cor.
- **Toda alteração no card vai sozinha para a Nuvemshop** (foto, tamanho, código, venda, estoque, preço, nome, cor, descrição, classificação): espelho do card a cada 3 min (`src/services/nuvemshopCardMirror.js`), estoque a cada 5 min, produto novo de hora em hora. Não dependa de "subir na mão".
- **Teste e auditoria antes de dizer pronto**: testar tudo antes de ensinar/entregar; depois de ensinar, uma equipe de auditoria independente confere tudo o que foi produzido e se seguiu todas as regras. Só então a tarefa está finalizada.
- **Todo produto no lugar certo (regra 30)**: confira se cada produto sob sua responsabilidade está com categoria, subcategoria (o público: Homem, Mulher/Feminino, Menino, Menina ou Unissex), modalidade e especialidade certas. A classificação é o endereço do produto no menu da loja online e tem que bater com o que o NOME diz (meia/bola/bolsa = Acessórios; camiseta/short = Vestuário; chuteira FUTSAL = Futsal; JR/infantil = Menino/Menina; criança nunca vai para adulto por falta da palavra "infantil"). Só vale o que está escrito (nome, NF-e, caixa), nunca deduzir. Régua em `src/ai/rede/regras/local-certo.js`; como consertar em `src/ai/rede/regras/conserto-nuvemshop.js` (passos "local-…"); o gerente de cada marca (`/marcas.html`, seção "Lugar certo no site") lista o que está fora do lugar.
