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

export async function findVTigerContact(ghlContact) {
  // vTiger restringe la búsqueda por 'phone' o 'mobile' en la API (Permission denied).
  // Estrategia: Buscar por Nombre y Apellido, luego filtrar por teléfono en memoria.
  
  let contacts = [];
  const cleanPhone = ghlContact.phone ? ghlContact.phone.replace(/\D/g, '') : '';
  const firstName = (ghlContact.firstName || '').trim().replace(/'/g, '');
  const lastName = (ghlContact.lastName || '').trim().replace(/'/g, '');
  
  if (firstName && lastName) {
    const q = `SELECT * FROM Contacts WHERE firstname = '${firstName}' AND lastname = '${lastName}';`;
    const potentialContacts = await queryVTiger(q);
    
    // Filtrar en memoria comprobando si algún campo de teléfono coincide
    if (potentialContacts && potentialContacts.length > 0) {
       for (const v of potentialContacts) {
          const vPhones = [v.homephone, v.mobile, v.phone, v.otherphone]
            .filter(Boolean)
            .map(p => String(p).replace(/\D/g, ''));
            
          if (cleanPhone && vPhones.some(p => p.includes(cleanPhone.slice(-10)) || cleanPhone.includes(p.slice(-10)))) {
             return v; // Match exacto por teléfono
          }
       }
       // Si no hay match por teléfono, pero solo devolvió 1, podríamos arriesgarnos a devolverlo,
       // pero es más seguro requerir que el teléfono coincida o que al menos haya 1 solo resultado.
       if (potentialContacts.length === 1 && !cleanPhone) {
          return potentialContacts[0];
       }
    }
  }
  
  const email = ghlContact.email;
  if (email) {
    const cleanEmail = email.trim();
    let q = `SELECT * FROM Contacts WHERE email = '${cleanEmail}' LIMIT 1;`;
    contacts = await queryVTiger(q);
    if (contacts.length > 0) return contacts[0];
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

