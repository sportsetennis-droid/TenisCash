// Teste local de geração DANFE NFCe a partir do XML armazenado
import fs from 'node:fs';
import { DANFCe } from 'node-sped-pdf';

const xml = fs.readFileSync('tmp/nfce/nfce-100000-signed.xml', 'utf8');
console.log('XML lido:', xml.length, 'bytes');

console.log('Gerando DANFE...');
const pdf = await DANFCe({ xml });
console.log('PDF gerado:', pdf.length || pdf.byteLength, 'bytes');

const out = 'tmp/nfce/danfe-100000.pdf';
fs.writeFileSync(out, Buffer.from(pdf));
console.log('✓ Salvo em', out);
