import { GHL_CONFIG } from '../config/index.js';

const { apiKey } = GHL_CONFIG;
const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

async function fixAlfredoLopez() {
  console.log(`\n🪄 Corrigiendo Alfredo Lopez (DPxKIJDKKVZu07Y760cB)...`);
  const contactId = 'DPxKIJDKKVZu07Y760cB';
  
  // Obtener contacto actual
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: HEADERS });
  const data = await res.json();
  const c = data.contact || data;

  const cleanTags = (c.tags || []).filter(t => 
    t !== 'producto-artritis' && 
    t !== 'alerta-duplicado-clic' && 
    !t.startsWith('pauta-clic-x')
  );
  if (!cleanTags.includes('producto-potencia')) cleanTags.push('producto-potencia');

  const customFields = [
    { id: 'WcrrCIL4A2203kIbeFsJ', value: 'Potencia' }, // Tratamiento comprado / actual
    { id: '8EQtKkiW7Z022bcN0vhS', value: 'SIN VENTA' }, // Estado Comercial
    { id: 'RLxFOTXkICXLWShjaLaB', value: '2026-09-10' }, // Fecha Ultima Asignacion
    { id: 'cZu95uKBqVydDEh24enl', value: '' }, // Limpiar nota falsa de homónimo
    { id: 'GZKRu2z1Z156lRUfyrpo', value: '' }, // Purgar fecha compra
    { id: '5js0Lfbh5XDLq87SDgdT', value: '' } // Purgar precio venta
  ];

  const payload = {
    source: 'BENAVIDES-CLICK2RING-FB-MSGR-Potencia',
    tags: cleanTags,
    customFields
  };

  const putRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify(payload)
  });

  console.log(`Alfredo Lopez actualizado. Status: ${putRes.status}`);
}

async function fixMarisolDegollado() {
  console.log(`\n🪄 Corrigiendo Marisol Degollado (bRWGCR2OdmxtKurS7lsN)...`);
  const contactId = 'bRWGCR2OdmxtKurS7lsN';

  const customFields = [
    { id: '8EQtKkiW7Z022bcN0vhS', value: 'SIN VENTA' },
    { id: '5TY5AIOpu1c8f6WosyF2', value: '1-POR ASIGNAR' },
    { id: 'RLxFOTXkICXLWShjaLaB', value: '2026-09-10' },
    { id: 'GZKRu2z1Z156lRUfyrpo', value: '' }, // PURGA Fecha compra falsa (Jan 27, 2023)
    { id: 'OJYOXVqKp33A6T5HZK5I', value: '' },
    { id: 'cyn0Ar7GMvmzYBKw0SJu', value: '' },
    { id: '1U0XzfuI9HUQDqQVMeSV', value: '' },
    { id: '5js0Lfbh5XDLq87SDgdT', value: '' }  // PURGA Precio venta falso (0.00)
  ];

  const payload = {
    customFields
  };

  const putRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify(payload)
  });

  console.log(`Marisol Degollado actualizada. Status: ${putRes.status}`);
}

async function run() {
  await fixAlfredoLopez();
  await fixMarisolDegollado();
}

run();
