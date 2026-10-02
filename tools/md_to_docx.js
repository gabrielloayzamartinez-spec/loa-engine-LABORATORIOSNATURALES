/**
 * Genera un documento Word (.docx) a partir del Markdown, SIN depender de Word:
 * construye el paquete OpenXML (Content_Types + rels + document.xml) y lo deja
 * listo para comprimir con .NET ZipFile.
 *
 * Uso: node tools/md_to_docx.js <entrada.md> <carpeta_salida>
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [, , entrada, salidaDir] = process.argv;
if (!entrada || !salidaDir) {
  console.error('Uso: node tools/md_to_docx.js <entrada.md> <carpeta_salida>');
  process.exit(1);
}

const md = readFileSync(entrada, 'utf8');
const x = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Runs de Word desde texto con **negrita** y `codigo`. */
function runs(texto = '', base = {}) {
  const partes = String(texto).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return partes.map(p => {
    let txt = p, extra = '';
    if (/^\*\*[^*]+\*\*$/.test(p)) { txt = p.slice(2, -2); extra = '<w:b/>'; }
    else if (/^`[^`]+`$/.test(p)) { txt = p.slice(1, -1); extra = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="B03060"/>'; }
    const rpr = `<w:rPr>${extra}${base.b ? '<w:b/>' : ''}${base.sz ? `<w:sz w:val="${base.sz}"/>` : ''}${base.color ? `<w:color w:val="${base.color}"/>` : ''}</w:rPr>`;
    return `<w:r>${rpr}<w:t xml:space="preserve">${x(txt)}</w:t></w:r>`;
  }).join('');
}

const p = (texto, opts = {}) => {
  const pr = [];
  if (opts.after !== undefined) pr.push(`<w:spacing w:after="${opts.after}"/>`);
  if (opts.color || opts.shade) {
    const sh = opts.shade ? `<w:shd w:val="clear" w:fill="${opts.shade}"/>` : '';
    const bd = opts.bar ? `<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="2E7D9A"/></w:pBdr>` : '';
    pr.push(`<w:pPr>${sh}${bd}</w:pPr>`);
  }
  return `<w:p><w:pPr>${pr.join('')}</w:pPr>${runs(texto, opts)}</w:p>`;
};

const body = [];
const lineas = md.split(/\r?\n/);
let i = 0, enCodigo = false, bufCod = [];

const esFila = l => /^\s*\|.*\|\s*$/.test(l);
const esSep = l => /^\s*\|[\s:|-]+\|\s*$/.test(l);

while (i < lineas.length) {
  const l = lineas[i];

  if (/^\s*```/.test(l)) {
    if (!enCodigo) { enCodigo = true; bufCod = []; }
    else {
      body.push(bufCod.map(c => p(c || ' ', { sz: 18, shade: 'F0F3F7', after: 0 })).join(''));
      body.push(p('', { after: 120 }));
      enCodigo = false;
    }
    i++; continue;
  }
  if (enCodigo) { bufCod.push(l); i++; continue; }

  if (esFila(l) && esFila(lineas[i + 1] || '') && esSep(lineas[i + 1])) {
    const cab = l.split('|').slice(1, -1).map(c => c.trim());
    i += 2;
    const filas = [];
    while (i < lineas.length && esFila(lineas[i])) { filas.push(lineas[i].split('|').slice(1, -1).map(c => c.trim())); i++; }
    const celda = (t, esCab) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${esCab ? '<w:shd w:val="clear" w:fill="1A3A5C"/>' : ''}</w:tcPr>${p(t, { sz: 18, b: esCab, color: esCab ? 'FFFFFF' : undefined, after: 0 })}</w:tc>`;
    const borde = ['top', 'left', 'bottom', 'right'].map(v => `<w:${v} w:val="single" w:sz="4" w:color="D8E0E8"/>`).join('');
    body.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borde}</w:tblBorders></w:tblPr>` +
      `<w:tr>${cab.map(c => celda(c, true)).join('')}</w:tr>` +
      filas.map(f => `<w:tr>${f.map(c => celda(c, false)).join('')}</w:tr>`).join('') +
      `</w:tbl>` + p('', { after: 120 }));
    continue;
  }

  const h = l.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const n = h[1].length;
    const cfg = { 1: { sz: 36, color: '1A3A5C' }, 2: { sz: 28, color: '1A3A5C' }, 3: { sz: 24, color: '2E7D9A' } }[n] || { sz: 22, color: '2E7D9A' };
    body.push(p(h[2], { b: true, ...cfg, after: n === 1 ? 240 : 160 }));
    i++; continue;
  }

  if (/^\s*>\s?/.test(l)) {
    const cita = [];
    while (i < lineas.length && /^\s*>\s?/.test(lineas[i])) { cita.push(lineas[i].replace(/^\s*>\s?/, '')); i++; }
    for (const c of cita) if (c.trim()) body.push(p(c, { shade: 'F5F7FA', bar: true, after: 60 }));
    body.push(p('', { after: 80 }));
    continue;
  }

  if (/^\s*---+\s*$/.test(l)) { body.push(p('', { after: 100 })); i++; continue; }

  if (/^\s*[-*]\s+/.test(l)) {
    while (i < lineas.length && /^\s*[-*]\s+/.test(lineas[i])) {
      body.push(p('•  ' + lineas[i].replace(/^\s*[-*]\s+/, ''), { sz: 20, after: 40 }));
      i++;
    }
    continue;
  }
  if (/^\s*\d+\.\s+/.test(l)) {
    while (i < lineas.length && /^\s*\d+\.\s+/.test(lineas[i])) {
      const m = lineas[i].match(/^\s*(\d+)\.\s+(.*)$/);
      body.push(p(`${m[1]}.  ${m[2]}`, { sz: 20, after: 40 }));
      i++;
    }
    continue;
  }

  if (l.trim() === '') { i++; continue; }
  body.push(p(l, { sz: 21, after: 120 }));
  i++;
}

const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join('\n')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>
</w:body>
</w:document>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

rmSync(salidaDir, { recursive: true, force: true });
mkdirSync(join(salidaDir, '_rels'), { recursive: true });
mkdirSync(join(salidaDir, 'word'), { recursive: true });
writeFileSync(join(salidaDir, '[Content_Types].xml'), contentTypes, 'utf8');
writeFileSync(join(salidaDir, '_rels', '.rels'), rels, 'utf8');
writeFileSync(join(salidaDir, 'word', 'document.xml'), docXml, 'utf8');

console.log(`[OK] Paquete OpenXML generado en ${salidaDir} (document.xml: ${Math.round(docXml.length / 1024)} KB)`);
