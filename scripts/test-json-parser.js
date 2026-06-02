// Teste unitário do tryParseJSON robusto (sem DB, sem rede).
const { tryParseJSON } = require('../src/ai/ai-client');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('✅', label); }
  else { fail++; console.log('❌', label, '\n   got :', JSON.stringify(got), '\n   want:', JSON.stringify(want)); }
}

// 1) JSON puro (regressão — caso que já funcionava)
eq('objeto puro', tryParseJSON('{"a":1,"b":"x"}'), { a: 1, b: 'x' });

// 2) array no topo (ANTES quebrava — só olhava { })
eq('array no topo', tryParseJSON('[{"id":1},{"id":2}]'), [{ id: 1 }, { id: 2 }]);

// 3) cerca ```json ... ```
eq('cerca json', tryParseJSON('```json\n{"ok":true}\n```'), { ok: true });

// 4) cerca sem rótulo
eq('cerca sem rotulo', tryParseJSON('```\n{"ok":1}\n```'), { ok: 1 });

// 5) prosa antes e depois (ANTES o greedy pegava lixo)
eq('prosa em volta', tryParseJSON('Claro! Aqui está:\n{"plano":"x"}\nEspero ter ajudado.'), { plano: 'x' });

// 6) prosa com chave solta antes do JSON real (greedy first-{ falhava)
eq('chave solta na prosa', tryParseJSON('Custa R$ {valor} hoje. Resposta: {"v":2}'), { v: 2 });

// 7) vírgula pendurada (LLM comum)
eq('virgula pendurada obj', tryParseJSON('{"a":1,"b":2,}'), { a: 1, b: 2 });
eq('virgula pendurada arr', tryParseJSON('{"itens":[1,2,3,]}'), { itens: [1, 2, 3] });

// 8) string contendo chave (não pode confundir o scanner)
eq('chave dentro de string', tryParseJSON('{"texto":"use } com cuidado"}'), { texto: 'use } com cuidado' });

// 9) objeto aninhado com prosa em volta
eq('aninhado', tryParseJSON('saída:\n{"a":{"b":[1,{"c":2}]}}\nfim'), { a: { b: [1, { c: 2 }] } });

// 10) truncado (sem fechar) → deve devolver null sem lançar
eq('truncado -> null', tryParseJSON('{"a":1,"b":"incompl'), null);

// 11) vazio / lixo
eq('vazio -> null', tryParseJSON(''), null);
eq('sem json -> null', tryParseJSON('nenhum json aqui'), null);

console.log(`\n${'─'.repeat(50)}\n${pass} passou, ${fail} falhou`);
process.exit(fail === 0 ? 0 : 1);
