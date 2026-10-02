/**
 * Convierte el documento de análisis (Markdown) a HTML autocontenido y con estilo
 * corporativo, para compartir (navegador, PDF o Word).
 *
 * Uso: node tools/md_to_html.js <entrada.md> <salida.html>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , entrada, salida] = process.argv;
if (!entrada || !salida) {
  console.error('Uso: node tools/md_to_html.js <entrada.md> <salida.html>');
  process.exit(1);
}

const md = readFileSync(entrada, 'utf8');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Formato inline: **negrita**, `codigo`, *cursiva*. */
function inline(t = '') {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return s;
}

const lineas = md.split(/\r?\n/);
const out = [];
let i = 0;
let enCodigo = false;
let bufferCodigo = [];

const esFilaTabla = l => /^\s*\|.*\|\s*$/.test(l);
const esSeparadorTabla = l => /^\s*\|[\s:|-]+\|\s*$/.test(l);

while (i < lineas.length) {
  const l = lineas[i];

  // --- Bloques de código ---
  if (/^\s*```/.test(l)) {
    if (!enCodigo) { enCodigo = true; bufferCodigo = []; }
    else {
      out.push(`<pre><code>${esc(bufferCodigo.join('\n'))}</code></pre>`);
      enCodigo = false;
    }
    i++; continue;
  }
  if (enCodigo) { bufferCodigo.push(l); i++; continue; }

  // --- Tablas ---
  if (esFilaTabla(l) && esFilaTabla(lineas[i + 1] || '') && esSeparadorTabla(lineas[i + 1])) {
    const cab = l.split('|').slice(1, -1).map(c => c.trim());
    i += 2;
    const filas = [];
    while (i < lineas.length && esFilaTabla(lineas[i])) {
      filas.push(lineas[i].split('|').slice(1, -1).map(c => c.trim()));
      i++;
    }
    out.push('<table><thead><tr>' + cab.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
    for (const f of filas) {
      out.push('<tr>' + f.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
    }
    out.push('</tbody></table>');
    continue;
  }

  // --- Encabezados ---
  const h = l.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const n = h[1].length;
    out.push(`<h${n}>${inline(h[2])}</h${n}>`);
    i++; continue;
  }

  // --- Cita ---
  if (/^\s*>\s?/.test(l)) {
    const cita = [];
    while (i < lineas.length && /^\s*>\s?/.test(lineas[i])) {
      cita.push(lineas[i].replace(/^\s*>\s?/, ''));
      i++;
    }
    out.push('<blockquote>' + cita.map(c => esFilaTabla(c) ? inline(c) : `<p>${inline(c)}</p>`).join('') + '</blockquote>');
    continue;
  }

  // --- Separador ---
  if (/^\s*---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }

  // --- Listas ---
  if (/^\s*[-*]\s+/.test(l)) {
    const items = [];
    while (i < lineas.length && /^\s*[-*]\s+/.test(lineas[i])) {
      items.push(lineas[i].replace(/^\s*[-*]\s+/, ''));
      i++;
    }
    out.push('<ul>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ul>');
    continue;
  }
  if (/^\s*\d+\.\s+/.test(l)) {
    const items = [];
    while (i < lineas.length && /^\s*\d+\.\s+/.test(lineas[i])) {
      items.push(lineas[i].replace(/^\s*\d+\.\s+/, ''));
      i++;
    }
    out.push('<ol>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ol>');
    continue;
  }

  // --- Parrafo ---
  if (l.trim() === '') { i++; continue; }
  out.push(`<p>${inline(l)}</p>`);
  i++;
}

const css = `
  :root { --azul:#1a3a5c; --acento:#2e7d9a; --gris:#f5f7fa; --borde:#d8e0e8; }
  * { box-sizing:border-box; }
  body { font-family:'Segoe UI',Calibri,Arial,sans-serif; line-height:1.65; color:#222;
         max-width:1000px; margin:0 auto; padding:40px 32px; background:#fff; }
  h1 { color:var(--azul); font-size:2em; border-bottom:3px solid var(--acento); padding-bottom:12px; margin-top:8px; }
  h2 { color:var(--azul); font-size:1.45em; margin-top:38px; border-bottom:1px solid var(--borde); padding-bottom:6px; }
  h3 { color:var(--acento); font-size:1.15em; margin-top:26px; }
  table { border-collapse:collapse; width:100%; margin:16px 0; font-size:0.92em; }
  th { background:var(--azul); color:#fff; text-align:left; padding:9px 11px; font-weight:600; }
  td { padding:8px 11px; border-bottom:1px solid var(--borde); vertical-align:top; }
  tr:nth-child(even) td { background:var(--gris); }
  code { background:var(--gris); padding:2px 6px; border-radius:4px; font-family:Consolas,monospace; font-size:0.9em; color:#b03060; }
  pre { background:#1e2a38; color:#e8eef4; padding:14px 16px; border-radius:6px; overflow-x:auto; }
  pre code { background:none; color:inherit; padding:0; }
  blockquote { border-left:4px solid var(--acento); background:var(--gris); margin:16px 0; padding:12px 18px; border-radius:0 6px 6px 0; }
  blockquote p { margin:6px 0; }
  hr { border:none; border-top:1px solid var(--borde); margin:30px 0; }
  ul,ol { margin:10px 0 10px 22px; }
  li { margin:5px 0; }
  @media print { body { padding:0; max-width:none; } h2 { page-break-after:avoid; } table { page-break-inside:avoid; } }
`;

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LOA Engine - Analisis General del Desarrollo</title>
<style>${css}</style>
</head>
<body>
${out.join('\n')}
</body>
</html>`;

mkdirSync(dirname(salida), { recursive: true });
writeFileSync(salida, html, 'utf8');
console.log(`[OK] Generado: ${salida} (${Math.round(html.length / 1024)} KB)`);
