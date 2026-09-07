import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fetchWithRetry } from '../utils/fetcher.js';
import { GHL_CONFIG } from '../config/index.js';

const BASE_DIR = path.resolve('C:/Users/Lenovo/Desktop/LOA_ENGINE_LABORATORIOS_NATURALES/scratch');
const CSV_DIR = path.join(BASE_DIR, 'csvs_enriched');
const CHECKPOINT_FILE = path.join(BASE_DIR, 'import_checkpoint.json');
const REQUESTS_PER_SECOND = 2; // Rate limit seguro para GHL
const SLEEP_MS = 1000 / REQUESTS_PER_SECOND;

const HEADERS = {
  'Authorization': `Bearer ${GHL_CONFIG.apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

const delay = ms => new Promise(res => setTimeout(res, ms));

// Mapeo de Custom Fields de GHL a las columnas del CSV
const CUSTOM_FIELDS_MAP = {
  'vTiger ID Cliente': 'PNr3LsTpXAwmyvPnvI11',
  'vTiger Contact No': 'eBE29SIhviHr2yDJT1Y6',
  'vTiger Producto Condicion': 'Rr3EXbJwnCOWgFU5FHM3', // Producto Condicion
  'vTiger Última Compra Producto': 'RgE4PAKDFOP89VIZHavV', 
  'Tratamiento Comprado Alias': 'WcrrCIL4A2203kIbeFsJ', // Mapeado desde 'vTiger Producto Condicion'
  'vTiger Total Compras': '3L8KHJEp8fw8ELr081Kl',
  'vTiger Monto Ultima Compra USD': 'OnhkGCi6yQkLnoSE1dnP',
  'vTiger Total Historico Gastado USD': 'cqmj8bfaRB2Gxug0U5Ql',
  'Precio Venta Alias': '5js0Lfbh5XDLq87SDgdT', // Mapeado desde 'vTiger Monto Ultima Compra USD'
  'vTiger Campana Origen': 'SR85C3u6JfnvkdK9hUN6',
  'ID Anuncio Alias': '6w3yMjLgIw6npUKWIosr', // Mapeado desde 'vTiger Campana Origen'
  'vTiger Canal Captacion': 'PzuJCcBcrnu4oUq1zLnN',
  'vTiger Asesor Asignado': 'mgvnRNO04M8CtQ3Kc3fZ',
  'vTiger Estado Comercial': '8EQtKkiW7Z022bcN0vhS',
  'vTiger Sede / Tienda Compra': '50pTZdtYYYcF1Wtz4j4s',
  'vTiger Fecha Primera Compra': 'OJYOXVqKp33A6T5HZK5I',
  'Fecha Compra Alias': 'GZKRu2z1Z156lRUfyrpo', // Mapeado desde 'vTiger Fecha Primera Compra'
  'vTiger Fecha Ultima Compra': 'cyn0Ar7GMvmzYBKw0SJu',
  'vTiger Fecha Creacion': 'EulM7Gjuxt63t9i7qr1y',
  'vTiger Todos Los Productos Comprados': 'CUSTOM_PRODUCTOS_ID' // Opcional, si tienes ID en GHL
};

// Limpieza de Tags
function cleanTags(tagsStr) {
  if (!tagsStr) return [];
  return tagsStr.split(',').map(t => t.trim()).filter(t => t);
}

// Convertir fila a payload GHL
function rowToPayload(row) {
  const customFields = [];
  
  // Mapeos directos
  for (const [csvHeader, fieldId] of Object.entries(CUSTOM_FIELDS_MAP)) {
    let val = row[csvHeader];
    
    // Si es un Alias, tomamos el valor de su columna origen
    if (csvHeader === 'Tratamiento Comprado Alias') val = row['vTiger Producto Condicion'];
    if (csvHeader === 'Precio Venta Alias') val = row['vTiger Monto Ultima Compra USD'];
    if (csvHeader === 'ID Anuncio Alias') val = row['vTiger Campana Origen'];
    if (csvHeader === 'Fecha Compra Alias') val = row['vTiger Fecha Primera Compra'];
    
    if (val && fieldId !== 'CUSTOM_PRODUCTOS_ID') {
      customFields.push({ id: fieldId, field_value: val });
    }
  }

  // Desglose (Notas) a un campo custom si es necesario, pero GHL tiene endpoint separado de Notas.
  // En la V2 de GHL las notas se pueden crear, pero upsert no soporta 'notes' directamente. 
  // Lo manejaremos con llamadas adicionales de Notas luego o lo pasamos si está configurado en algún Custom Field.
  
  return {
    locationId: GHL_CONFIG.locationId,
    firstName: row['First Name'] || '',
    lastName: row['Last Name'] || '',
    email: row['Email'] || undefined,
    phone: row['Phone'] || undefined,
    city: row['City'] || '',
    state: row['State'] || '',
    timezone: row['Timezone'] || 'America/New_York',
    source: row['vTiger Campana Origen'] || 'Importacion Historica',
    type: row['vTiger Estado Comercial'] === 'CONVERTIDO' ? 'customer' : 'lead',
    tags: cleanTags(row['Tags']),
    customFields: customFields
  };
}

async function getCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  }
  return { fileIndex: 0, rowIndex: 0 };
}

function saveCheckpoint(fileIndex, rowIndex) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ fileIndex, rowIndex }), 'utf8');
}

async function processFile(filePath, startRow) {
  console.log(`\n📄 Procesando archivo: ${path.basename(filePath)} desde fila ${startRow}...`);
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        for (let i = startRow; i < results.length; i++) {
          const row = results[i];
          const payload = rowToPayload(row);
          
          try {
            // Upsert contacto
            const res = await fetchWithRetry('https://services.leadconnectorhq.com/contacts/upsert', {
              method: 'POST',
              headers: HEADERS,
              body: JSON.stringify(payload)
            });
            
            const resJson = await res.json();
            const contactId = resJson?.contact?.id;

            // Upsert Nota (Si hay notas en el CSV)
            if (contactId && row['Notes']) {
              await fetchWithRetry(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
                method: 'POST',
                headers: HEADERS,
                body: JSON.stringify({
                  body: row['Notes'],
                  userId: null
                })
              });
            }

            console.log(`[EXITO] Fila ${i} importada: ${payload.firstName} ${payload.lastName} (ID: ${contactId})`);
            
            // Guardar checkpoint (cada 10 filas para no gastar I/O)
            if (i % 10 === 0) saveCheckpoint(globalFileIndex, i);
            
          } catch (err) {
            console.error(`[ERROR] Fila ${i}: Falló importación ->`, err.message);
          }
          
          await delay(SLEEP_MS);
        }
        resolve();
      })
      .on('error', reject);
  });
}

let globalFileIndex = 0;

async function main() {
  const checkpoint = await getCheckpoint();
  globalFileIndex = checkpoint.fileIndex;
  
  const files = fs.readdirSync(CSV_DIR)
    .filter(f => f.endsWith('.csv'))
    .sort() // Sort alphabetico contactos_vtiger_ghl_parte_1.csv
    .map(f => path.join(CSV_DIR, f));

  if (globalFileIndex >= files.length) {
    console.log("✅ Importación completada. Todos los archivos procesados.");
    return;
  }

  console.log(`🚀 Iniciando Agente 2 (Importador Histórico)...`);
  
  for (let i = globalFileIndex; i < files.length; i++) {
    globalFileIndex = i;
    const startRow = (i === checkpoint.fileIndex) ? checkpoint.rowIndex : 0;
    
    await processFile(files[i], startRow);
    
    // Al terminar el archivo, guardamos inicio del siguiente
    saveCheckpoint(i + 1, 0);
  }
  
  console.log("🎉 INYECCION MASIVA COMPLETADA");
}

main().catch(console.error);
