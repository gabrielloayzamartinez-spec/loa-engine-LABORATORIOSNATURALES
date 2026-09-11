import crypto from 'crypto';
import { VTIGER_CONFIG } from '../config/index.js';
import { learningBrain } from './learning_brain.js';

let currentSessionName = null;

export async function loginToVTiger() {
  const { url, username, accessKey } = VTIGER_CONFIG;
  if (!url || !username || !accessKey) {
    throw new Error('Credenciales de vTiger incompletas en la configuración.');
  }

  const endpoint = `${url.replace(/\/$/, '')}/webservice.php`;

  // 1. Get Challenge
  const challengeUrl = `${endpoint}?operation=getchallenge&username=${encodeURIComponent(username)}`;
  const challengeRes = await fetch(challengeUrl);
  const challengeData = await challengeRes.json();
  
  if (!challengeData.success) {
    throw new Error(`Error en getchallenge: ${challengeData.error?.message}`);
  }
  
  const token = challengeData.result.token;
  
  // 2. MD5 Hash
  const generatedKey = crypto.createHash('md5').update(token + accessKey).digest('hex');
  
  // 3. Login
  const loginBody = new URLSearchParams({
    operation: 'login',
    username: username,
    accessKey: generatedKey
  });

  const loginRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: loginBody
  });
  
  const loginData = await loginRes.json();
  if (!loginData.success) {
    throw new Error(`Error en login vTiger: ${loginData.error?.message}`);
  }
  
  currentSessionName = loginData.result.sessionName;
  console.log(`[VTiger API] ✅ Login exitoso. Session: ${currentSessionName.substring(0,6)}...`);
  return currentSessionName;
}

export async function queryVTiger(queryStr) {
  if (!currentSessionName) {
    await loginToVTiger();
  }
  
  const { url } = VTIGER_CONFIG;
  const endpoint = `${url.replace(/\/$/, '')}/webservice.php`;
  let cleanQuery = queryStr.trim();
  if (!cleanQuery.endsWith(';')) cleanQuery += ';';

  let res = await fetch(`${endpoint}?operation=query&sessionName=${currentSessionName}&query=${encodeURIComponent(cleanQuery)}`);
  let data = await res.json();

  if (!data.success) {
    const errMsg = data.error?.message || '';
    if (errMsg.toLowerCase().includes('session') || errMsg.toLowerCase().includes('auth')) {
      console.log(`[VTiger API] 🔄 Sesión expirada. Reautenticando...`);
      await loginToVTiger();
      res = await fetch(`${endpoint}?operation=query&sessionName=${currentSessionName}&query=${encodeURIComponent(cleanQuery)}`);
      data = await res.json();
      if (!data.success) throw new Error(data.error?.message);
    } else {
      throw new Error(errMsg);
    }
  }

  return data.result || [];
}

/**
 * Sanitiza un valor para uso seguro en queries SQL de vTiger.
 * Escapa comillas simples y elimina caracteres de control.
 */
function sanitizeForVtigerQuery(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/'/g, "\\'")    // Escapar comillas simples (SQL injection)
    .replace(/[\x00-\x1F]/g, '') // Eliminar caracteres de control
    .substring(0, 100);       // Limitar longitud para evitar queries enormes
}

/**
 * Compara dos cadenas de teléfono por los últimos N dígitos.
 */
function phonesMatch(phone1, phone2, digits = 10) {
  if (!phone1 || !phone2) return false;
  const p1 = String(phone1).replace(/\D/g, '');
  const p2 = String(phone2).replace(/\D/g, '');
  if (p1.length < 7 || p2.length < 7) return false;
  return p1.slice(-digits) === p2.slice(-digits);
}

export async function findVTigerContact(ghlContact) {
  const cleanPhone = ghlContact.phone ? ghlContact.phone.replace(/\D/g, '') : '';
  const firstName = sanitizeForVtigerQuery(ghlContact.firstName);
  const lastName = sanitizeForVtigerQuery(ghlContact.lastName);
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 1: Búsqueda por Nombre + Apellido (LIKE para tolerancia a tildes/variaciones)
  // ────────────────────────────────────────────
  if (firstName.length >= 2 && lastName.length >= 2) {
    // Intentar primero con igualdad exacta (más rápido)
    let q = `SELECT * FROM Contacts WHERE firstname = '${firstName}' AND lastname = '${lastName}';`;
    let potentialContacts = await queryVTiger(q);
    
    // Si no hay resultados exactos, intentar con LIKE (tolerante a tildes)
    if (!potentialContacts || potentialContacts.length === 0) {
      // Tomar los primeros 3 caracteres como ancla para LIKE
      const fnPrefix = firstName.substring(0, Math.min(4, firstName.length));
      const lnPrefix = lastName.substring(0, Math.min(4, lastName.length));
      q = `SELECT * FROM Contacts WHERE firstname LIKE '${fnPrefix}%' AND lastname LIKE '${lnPrefix}%';`;
      potentialContacts = await queryVTiger(q);
    }
    
    if (potentialContacts && potentialContacts.length > 0) {
      // Prioridad 1: Match exacto por teléfono
      if (cleanPhone) {
        for (const v of potentialContacts) {
          const vPhones = [v.homephone, v.mobile, v.phone, v.otherphone].filter(Boolean);
          if (vPhones.some(p => phonesMatch(cleanPhone, p))) {
            return v;
          }
        }
      }
      
      // Prioridad 2: Si solo hay 1 resultado y los nombres coinciden suficientemente, devolverlo
      if (potentialContacts.length === 1) {
        return potentialContacts[0];
      }
      
      // Prioridad 3: Si hay múltiples resultados sin teléfono para desempatar,
      // devolver el que tenga compras (más probable que sea relevante)
      const withSales = potentialContacts.find(v => parseInt(v.spl_num_compras || '0', 10) > 0);
      if (withSales) return withSales;
      
      // Si nada desempata, devolver el primero
      return potentialContacts[0];
    }
  }
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 2: Búsqueda por Email
  // ────────────────────────────────────────────
  const email = ghlContact.email;
  if (email && email.includes('@')) {
    const cleanEmail = sanitizeForVtigerQuery(email);
    const q = `SELECT * FROM Contacts WHERE email = '${cleanEmail}' LIMIT 1;`;
    const contacts = await queryVTiger(q);
    if (contacts.length > 0) return contacts[0];
  }
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 3: Búsqueda por solo nombre O solo apellido (último recurso)
  // ────────────────────────────────────────────
  if (cleanPhone && (firstName.length >= 3 || lastName.length >= 3)) {
    const nameToSearch = lastName.length >= 3 ? lastName : firstName;
    const field = lastName.length >= 3 ? 'lastname' : 'firstname';
    const q = `SELECT * FROM Contacts WHERE ${field} = '${nameToSearch}' LIMIT 20;`;
    try {
      const contacts = await queryVTiger(q);
      if (contacts && contacts.length > 0) {
        // Solo devolver si hay match de teléfono (evitar falsos positivos)
        for (const v of contacts) {
          const vPhones = [v.homephone, v.mobile, v.phone, v.otherphone].filter(Boolean);
          if (vPhones.some(p => phonesMatch(cleanPhone, p))) {
            return v;
          }
        }
      }
    } catch (e) {
      // Silenciar errores de esta búsqueda de último recurso
    }
  }
  
  return null;
}

export async function getSalesHistory(contactId) {
  if (!contactId) return [];
  // contactId viene con prefijo, ej "12x456"
  try {
    const q = `SELECT * FROM SalesOrder WHERE contact_id = '${contactId}';`;
    const sales = await queryVTiger(q);
    return sales;
  } catch(e) {
    console.log(`[VTiger API] ⚠️ No se pudo consultar SalesOrder: ${e.message}`);
    return [];
  }
}

/**
 * Consulta las compras/contactos confirmados más recientes en vTiger para alimentar el Cerebro de Autoaprendizaje.
 */
export async function fetchRecentConfirmedSales(limit = 25) {
  try {
    const q = `SELECT id, firstname, lastname, cf_2610, cf_3472, createdtime FROM Contacts ORDER BY createdtime DESC LIMIT 0, ${limit};`;
    const contacts = await queryVTiger(q);
    return contacts || [];
  } catch (err) {
    console.error(`[VTiger API] Error al obtener ventas recientes:`, err.message);
    return [];
  }
}

/**
 * Sincroniza las ventas recientes de vTiger CRM directamente en el Cerebro de Autoaprendizaje como Ground Truth.
 */
export async function syncVtigerGroundTruthToBrain(limit = 25) {
  try {
    console.log(`[VTiger Sync] 🔄 Consultando últimas ${limit} ventas en vTiger para calibrar el Cerebro...`);
    const recentContacts = await fetchRecentConfirmedSales(limit);
    let trainedCount = 0;

    for (const c of recentContacts) {
      const rawCondition = c.cf_2610 || '';
      const campaign = c.cf_3472 || '';

      // Mapear condición a uno de los 7 tratamientos oficiales
      let treatment = null;
      const lower = rawCondition.toLowerCase();
      if (lower.includes('potencia') || lower.includes('vigor') || lower.includes('sexual')) treatment = 'Potencia';
      else if (lower.includes('diabet') || lower.includes('azucar') || lower.includes('nopal')) treatment = 'Diabetes';
      else if (lower.includes('prostat')) treatment = 'Prostata';
      else if (lower.includes('colagen') || lower.includes('piel')) treatment = 'Colageno';
      else if (lower.includes('vision') || lower.includes('ojos')) treatment = 'Vision';
      else if (lower.includes('gastro') || lower.includes('gastrit') || lower.includes('colon')) treatment = 'Gastro';
      else if (lower.includes('artrit') || lower.includes('articul') || lower.includes('rodilla')) treatment = 'Artritis';

      if (treatment) {
        learningBrain.learnFromVtigerSale({
          treatment,
          chatText: `${c.firstname || ''} ${c.lastname || ''} ${campaign}`,
          campaignName: campaign
        });
        trainedCount++;
      }
    }

    console.log(`[VTiger Sync] ✅ Calibración completada: ${trainedCount} registros de vTiger entrenaron el Cerebro.`);
    return { success: true, trainedCount };
  } catch (err) {
    console.error(`[VTiger Sync] ⚠️ Error en calibración de vTiger:`, err.message);
    return { success: false, error: err.message };
  }
}

