/**
 * TEST — CONTRATO ÚNICO DE ETIQUETAS (src/domain/ghl_tags.js)
 *
 * Valida, sin red, las reglas que la auditoría 27/11 fijó para que el Nivel 1
 * (Meta, en vivo) y el Nivel 2 (vTiger: reverse sync, dual sync, backfills)
 * escriban EXACTAMENTE el mismo vocabulario de etiquetas.
 */
import {
  etiquetaCanal, etiquetaProveedor, etiquetaSede, etiquetaProducto,
  esEtiquetaRuido, aplicarContratoEtiquetas, canalVtigerDesdeTag, CANALES_VALIDOS, TAGS_ESTADO
} from '../domain/ghl_tags.js';

let pasadas = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  pasadas++;
}

console.log('[TEST] Contrato único de etiquetas GHL…');

// 1. CANAL: el valor CRUDO de vTiger (cf_3507) y el transporte de Meta se
//    normalizan a la MISMA etiqueta canónica.
assert(etiquetaCanal('FB-MSGR') === 'canal-messenger', 'FB-MSGR -> canal-messenger');
assert(etiquetaCanal('FB-MESSENGER') === 'canal-messenger', 'FB-MESSENGER -> canal-messenger');
assert(etiquetaCanal('FORM') === 'canal-forms', 'FORM -> canal-forms');
assert(etiquetaCanal('canal-form') === 'canal-forms', 'la variante legada canal-form se normaliza');
assert(etiquetaCanal('WHATSAPP') === 'canal-whatsapp', 'WHATSAPP -> canal-whatsapp');
assert(etiquetaCanal('wsp') === 'canal-whatsapp', 'wsp -> canal-whatsapp');
assert(etiquetaCanal('SMS') === 'canal-sms', 'SMS -> canal-sms');
assert(etiquetaCanal('instagram') === 'canal-instagram', 'instagram -> canal-instagram');
assert(etiquetaCanal('') === null, 'un canal vacío no inventa etiqueta');
assert(etiquetaCanal('OTRA-COSA') === null, 'un canal desconocido NO produce canal-otra-cosa');
for (const c of CANALES_VALIDOS) {
  assert(etiquetaCanal(c) === c, `la canónica ${c} es idempotente`);
}

// 2. PROVEEDOR
assert(etiquetaProveedor('ERNESTO') === 'prov-ernesto', 'ERNESTO -> prov-ernesto');
assert(etiquetaProveedor('IN_HOUSE') === 'prov-in-house', 'IN_HOUSE -> prov-in-house');
assert(etiquetaProveedor('Click2Ring') === 'prov-click2ring', 'Click2Ring -> prov-click2ring');
assert(etiquetaProveedor('REDES 2 BENAVIDES') === 'prov-redes-2-benavides', 'REDES 2 BENAVIDES -> prov-redes-2-benavides');
assert(etiquetaProveedor('') === null, 'proveedor vacío no produce etiqueta');

// 3. SEDE: allow-list dura (nunca inventa una sede)
assert(etiquetaSede('palacios') === 'sede-palacios', 'sede en minúsculas');
assert(etiquetaSede(' ROOSEVELT ') === 'sede-roosevelt', 'sede con espacios');
assert(etiquetaSede('LIMA') === null, 'una sede desconocida no produce etiqueta');

// 4. PRODUCTO: vocabulario clínico canónico
assert(etiquetaProducto('Tetosterona') === 'producto-potencia', 'el alias legado Tetosterona se normaliza');
assert(etiquetaProducto('Diabetes') === 'producto-diabetes', 'Diabetes -> producto-diabetes');
assert(etiquetaProducto('') === null, 'tratamiento vacío no produce etiqueta');

// 4b. INVERSO: etiqueta canónica -> vocabulario CRUDO de vTiger (cf_3507).
//     Es lo que permite que el Nivel 1 escriba "Canal Captación" igual que el N2.
assert(canalVtigerDesdeTag('canal-messenger') === 'FB-MSGR', 'canal-messenger -> FB-MSGR');
assert(canalVtigerDesdeTag('canal-forms') === 'FORM', 'canal-forms -> FORM');
assert(canalVtigerDesdeTag('canal-form') === 'FORM', 'una variante legada también resuelve');
assert(canalVtigerDesdeTag('') === null, 'sin canal no hay valor de vTiger');

// 5. RUIDO declarado — [CONTRATO 27/11] solo prov-* y pagina-* (+ estado comercial)
for (const t of ['vtiger', 'vtiger-sincronizado', 'vtiger-status-vendido', 'form', 'organico',
                 'canal-messenger', 'canal-forms', 'sede-palacios', 'producto-diabetes',
                 'cola-redes-1', 'cola-forms', 'revisar-ruteo', 'facebook-messenger', 'meta-ads',
                 'sin-telefono', 'no-compro', 'lead-caliente']) {
  assert(esEtiquetaRuido(t), `"${t}" debe considerarse ruido`);
}
for (const t of ['cliente-vtiger', 'prospecto-vtiger', 'compro', 'sin-telefono', 'lead-caliente', 'convertido']) {
  assert(esEtiquetaRuido(t), `"${t}" debe considerarse ruido (el estado va en el CF)`);
}
for (const t of ['prov-ernesto', 'pagina-naturales-bionatural', 'alerta-reingreso-pauta']) {
  assert(!esEtiquetaRuido(t), `"${t}" NO es ruido (es una etiqueta de trabajo)`);
}

// 6. CONTRATO: solo sobreviven prov-* y pagina-* (y el estado comercial).
const caso = aplicarContratoEtiquetas({
  actuales: [
    'canal-form', 'canal-forms', 'canal-fb-msgr',
    'prov-in-house', 'prov-ernesto',
    'sede-palacios', 'sede-benavides',
    'producto-tetosterona', 'producto-diabetes',
    'vtiger', 'vtiger-sincronizado', 'vtiger-status-vendido',
    'lead-caliente', 'form-id-4385767568340402', 'compro', 'no-compro',
    'cola-redes-1', 'revisar-ruteo', 'pagina-naturales-bionatural', 'pagina-bio-natural'
  ],
  proveedor: 'prov-in-house',
  pagina: 'pagina-naturales-bionatural'
});
const tiene = t => caso.tags.includes(t);
assert(tiene('prov-in-house') && !tiene('prov-ernesto'), 'un solo proveedor');
assert(tiene('pagina-naturales-bionatural') && !tiene('pagina-bio-natural'), 'una sola página');
assert(!caso.tags.some(t => t.startsWith('canal-')), 'el canal ya no es etiqueta');
assert(!caso.tags.some(t => t.startsWith('sede-')), 'la sede ya no es etiqueta');
assert(!caso.tags.some(t => t.startsWith('producto-')), 'el producto ya no es etiqueta');
assert(!caso.tags.some(t => t.startsWith('cola-')), 'las colas ya no existen');
assert(!tiene('vtiger') && !tiene('vtiger-sincronizado') && !tiene('vtiger-status-vendido'), 'el ruido de vTiger se retira');
assert(!tiene('lead-caliente') && !tiene('form-id-4385767568340402'), 'las etiquetas fuera del contrato también se retiran');
assert(!tiene('revisar-ruteo'), 'revisar-ruteo se retira');
assert(!tiene('compro') && !tiene('no-compro'), 'las etiquetas de estado también se retiran (viven en el CF)');
assert(caso.removidas.includes('vtiger') && caso.removidas.includes('canal-form'), 'se reporta qué se retiró (auditoría)');

// 7. Idempotencia: aplicar el contrato dos veces da el mismo resultado.
const segunda = aplicarContratoEtiquetas({ actuales: caso.tags, proveedor: 'prov-in-house', pagina: 'pagina-naturales-bionatural' });
assert(segunda.tags.sort().join(',') === caso.tags.sort().join(','), 'el contrato es idempotente');

// 8. Sin ganador declarado el contrato NO conserva canal/sede/producto.
const sinGanador = aplicarContratoEtiquetas({ actuales: ['canal-messenger', 'prov-ernesto', 'sede-piura'] });
assert(sinGanador.tags.includes('prov-ernesto') && !sinGanador.tags.includes('canal-messenger') && !sinGanador.tags.includes('sede-piura'),
  'sin ganador solo se conserva el proveedor');

// 9. [DEPURACIÓN 27/11] El contrato retira TODAS las etiquetas de estado.
const estado = aplicarContratoEtiquetas({ actuales: [TAGS_ESTADO.CLIENTE, TAGS_ESTADO.PROSPECTO, TAGS_ESTADO.COMPRO] });
assert(estado.tags.length === 0 && estado.removidas.length === 3, 'las etiquetas de estado se retiran (el estado va en el CF)');

console.log(`[SUCCESS] ${pasadas} aserciones del contrato de etiquetas validadas al 100%.`);
