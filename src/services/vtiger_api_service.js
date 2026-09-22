import crypto from 'crypto';
import { VTIGER_CONFIG } from '../config/index.js';
import { learningBrain } from './learning_brain.js';

let currentSessionName = null;

export async function checkVTigerHealth() {
  try {
    await loginToVTiger();
    return { status: 'OK' };
  } catch (e) {
    return { status: 'ERROR', message: e.message };
  }
}

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
  console.log(`[VTiger API] [SUCCESS] Login exitoso. Session: ${currentSessionName.substring(0,6)}...`);
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
      console.log(`[VTiger API] [REAUTH] Sesión expirada. Reautenticando...`);
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
 * Compara dos cadenas de teléfono por los últimos N dígitos (10 dígitos en Estados Unidos - NANP).
 */
function phonesMatch(phone1, phone2, digits = 10) {
  if (!phone1 || !phone2) return false;
  const p1 = String(phone1).replace(/\D/g, '');
  const p2 = String(phone2).replace(/\D/g, '');
  if (p1.length < 7 || p2.length < 7) return false;
  const d = Math.min(digits, Math.min(p1.length, p2.length));
  return p1.slice(-d) === p2.slice(-d);
}

export async function findVTigerContact(ghlContact, targetSede = null) {
  const cleanPhone = ghlContact.phone ? ghlContact.phone.replace(/\D/g, '') : '';
  
  // [REGLA DE ORO: SIN NÚMERO NO HAY BÚSQUEDA]
  // Previene falsos positivos por nombres comunes (ej. "Maria Rodriguez") en leads que aún no han dejado su celular.
  if (cleanPhone.length < 7) {
    console.log(`[VTiger API] [SHIELD] Lead sin teléfono válido detectado (${ghlContact.firstName || 'Desconocido'}). Búsqueda en vTiger abortada para evitar homonimia.`);
    return null;
  }

  const firstName = sanitizeForVtigerQuery(ghlContact.firstName);
  const lastName = sanitizeForVtigerQuery(ghlContact.lastName);

  // [RESOLUCIÓN INFALIBLE DE SEDE OBJETIVO]:
  let targetSedeUpper = (targetSede || ghlContact?.targetSede || ghlContact?.sede || '').toUpperCase().trim();
  if (!targetSedeUpper && ghlContact?.locationId) {
    if (ghlContact.locationId.includes('QXcNBK6XCgpQaZ81Z8pv')) targetSedeUpper = 'BENAVIDES';
    else if (ghlContact.locationId.includes('5NqOaPYqWyIw2FPBfoRg')) targetSedeUpper = 'PALACIOS';
    else if (ghlContact.locationId.includes('ATPYNnsfZ1W8sd6WgWIV')) targetSedeUpper = 'CENTRAL';
    else if (ghlContact.locationId.includes('ROOSEVELT')) targetSedeUpper = 'ROOSEVELT';
    else if (ghlContact.locationId.includes('PIURA')) targetSedeUpper = 'PIURA';
  }

  // Cláusula SQL física para aislamiento de sede
  const sedeClause = targetSedeUpper ? ` AND cf_3451 = '${targetSedeUpper}'` : '';
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 0: Búsqueda Directa por Teléfono (10 dígitos exactos - Estados Unidos NANP)
  // En EE.UU. los números telefónicos tienen 10 dígitos (Código de Área 3 dígitos + 7 dígitos locales).
  // Con prefijo internacional +1 son 11 dígitos. Al extraer los últimos 10 dígitos (last10),
  // se empata inmediatamente (0.2s) con el número registrado en vTiger (mobile, phone, homephone).
  // ────────────────────────────────────────────
  if (cleanPhone && cleanPhone.length >= 10) {
    const last10 = cleanPhone.slice(-10);
    try {
      const qPhone = `SELECT * FROM Contacts WHERE homephone = '${last10}' OR mobile = '${last10}' OR phone = '${last10}' OR mobile = '${cleanPhone}' OR phone = '${cleanPhone}' LIMIT 10;`;
      let phoneMatches = await queryVTiger(qPhone);
      if (phoneMatches && phoneMatches.length > 0) {
        // Blindaje estricto: Si hay sede objetivo, exigir coincidencia estricta. CERO FALLBACK a otra sede.
        if (targetSedeUpper) {
          phoneMatches = phoneMatches.filter(v => (v.cf_3451 || '').toUpperCase().trim() === targetSedeUpper);
        }

        if (phoneMatches.length > 0) {
          // [ESCUDO DE HOMONIMIA ESTRICTA]: Cruzar el nombre/apellido.
          // Previene que familiares que comparten celular (ej. Perez vs Martinez) sean fusionados.
          const strictMatches = phoneMatches.filter(v => {
            const vFirst = sanitizeForVtigerQuery(v.firstname || '');
            const vLast = sanitizeForVtigerQuery(v.lastname || '');
            
            // Si en GHL no tenemos nombre, lo dejamos pasar (no hay forma de validar).
            if (!firstName && !lastName) return true;

            // Validar que al menos el Nombre o el Apellido (mínimo 3 letras) compartan raíz
            // Ej: "MART" y "MARTINEZ" coincidirán. "PEREZ" y "MARTINEZ" fallarán.
            const lastMatch = (lastName.length >= 3 && vLast.includes(lastName)) || (vLast.length >= 3 && lastName.includes(vLast));
            const firstMatch = (firstName.length >= 3 && vFirst.includes(firstName)) || (vFirst.length >= 3 && firstName.includes(vFirst));

            // Debe coincidir apellido O nombre para considerarse la misma persona.
            return lastMatch || firstMatch;
          });

          if (strictMatches.length > 0) {
            // Prioridad A: Match con compras registradas
            const withSales = strictMatches.find(v => parseInt(v.spl_num_compras || '0', 10) > 0);
            if (withSales) return withSales;

            // Prioridad B: Primer match disponible dentro de la sede
            return strictMatches[0];
          } else {
            console.warn(`[VTiger API] [ESCUDO HOMONIMIA] Teléfono ${last10} existe, pero los apellidos/nombres no coinciden. Evitando fusión errónea.`);
          }
        }
      }
    } catch (pErr) {
      console.warn(`[VTiger API] [WARN] Error en búsqueda directa por teléfono (${last10}):`, pErr.message);
    }
  }
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 1: Búsqueda por Nombre + Apellido
  // ────────────────────────────────────────────
  if (firstName.length >= 2 && lastName.length >= 2) {
    // 1. Intentar primero con igualdad exacta + filtro de sede
    let q = `SELECT * FROM Contacts WHERE firstname = '${firstName}' AND lastname = '${lastName}'${sedeClause};`;
    let potentialContacts = await queryVTiger(q);
    
    // 2. Si no hay resultados exactos, intentar con LIKE + filtro de sede
    if (!potentialContacts || potentialContacts.length === 0) {
      const fnPrefix = firstName.substring(0, Math.min(4, firstName.length));
      const lnPrefix = lastName.substring(0, Math.min(4, lastName.length));
      q = `SELECT * FROM Contacts WHERE firstname LIKE '${fnPrefix}%' AND lastname LIKE '${lnPrefix}%'${sedeClause};`;
      potentialContacts = await queryVTiger(q);
    }
    
    if (potentialContacts && potentialContacts.length > 0) {
      // [REGLA 1 - AISLAMIENTO ABSOLUTO]: Filtrar estrictamente por la sede objetivo
      if (targetSedeUpper) {
        potentialContacts = potentialContacts.filter(v => (v.cf_3451 || '').toUpperCase().trim() === targetSedeUpper);
      }

      // Si no hay ningún contacto para esta sede, retorno NULL de inmediato (CERO FALLBACK A OTRAS SEDES)
      if (potentialContacts.length === 0) {
        return null;
      }

      // [REGLA 2 - BLINDAJE DE HOMÓNIMOS POR TELÉFONO]:
      // Si el lead en GHL ya tiene un número telefónico conocido,
      // comparamos contra los teléfonos que tenga el candidato en vTiger.
      // Si el candidato tiene teléfonos y NINGUNO coincide con el lead, es un homónimo diferente -> DESCARTADO.
      if (cleanPhone) {
        const matchingByPhone = [];
        const withoutPhone = [];
        
        for (const v of potentialContacts) {
          const vPhones = [v.homephone, v.mobile, v.phone, v.otherphone].filter(Boolean);
          if (vPhones.length > 0) {
            if (vPhones.some(p => phonesMatch(cleanPhone, p))) {
              matchingByPhone.push(v);
            }
            // Si tiene teléfonos pero ninguno coincide, NO se agrega (homónimo rechazado)
          } else {
            // El candidato en vTiger no tiene teléfono registrado
            withoutPhone.push(v);
          }
        }

        if (matchingByPhone.length > 0) {
          const withSales = matchingByPhone.find(v => parseInt(v.spl_num_compras || '0', 10) > 0);
          return withSales || matchingByPhone[0];
        }

        // Si todos los candidatos tenían teléfonos y ninguno coincidió, ABORTAR vinculación
        if (withoutPhone.length === 0) {
          console.log(`[VTiger API] [SEDE-SHIELD] Homónimo de ${firstName} ${lastName} en sede ${targetSedeUpper} descartado por teléfono en conflicto.`);
          return null;
        }

        // Si hay candidatos en la misma sede sin teléfono registrado, nos quedamos con ellos
        potentialContacts = withoutPhone;
      }

      // Prioridad: El que tenga compras dentro de la sede
      const withSales = potentialContacts.find(v => parseInt(v.spl_num_compras || '0', 10) > 0);
      if (withSales) return withSales;
      
      return potentialContacts[0];
    }
  }
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 2: Búsqueda por Email
  // ────────────────────────────────────────────
  const email = ghlContact.email;
  if (email && email.includes('@')) {
    const cleanEmail = sanitizeForVtigerQuery(email);
    const q = `SELECT * FROM Contacts WHERE email = '${cleanEmail}'${sedeClause} LIMIT 1;`;
    let contacts = await queryVTiger(q);
    if (contacts && contacts.length > 0) {
      if (targetSedeUpper) {
        contacts = contacts.filter(v => (v.cf_3451 || '').toUpperCase().trim() === targetSedeUpper);
      }
      if (contacts.length > 0) return contacts[0];
    }
  }
  
  // ────────────────────────────────────────────
  // ESTRATEGIA 3: Búsqueda por solo nombre O solo apellido (último recurso)
  // ────────────────────────────────────────────
  if (cleanPhone && (firstName.length >= 3 || lastName.length >= 3)) {
    const nameToSearch = lastName.length >= 3 ? lastName : firstName;
    const field = lastName.length >= 3 ? 'lastname' : 'firstname';
    const q = `SELECT * FROM Contacts WHERE ${field} = '${nameToSearch}'${sedeClause} LIMIT 20;`;
    try {
      let contacts = await queryVTiger(q);
      if (contacts && contacts.length > 0) {
        if (targetSedeUpper) {
          contacts = contacts.filter(v => (v.cf_3451 || '').toUpperCase().trim() === targetSedeUpper);
        }
        // Solo devolver si hay match de teléfono estricto
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
    console.log(`[VTiger API] [WARN] No se pudo consultar SalesOrder: ${e.message}`);
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
    console.log(`[VTiger Sync] [SYNC] Consultando últimas ${limit} ventas en vTiger para calibrar el Cerebro...`);
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

    console.log(`[VTiger Sync] [SUCCESS] Calibración completada: ${trainedCount} registros de vTiger entrenaron el Cerebro.`);
    return { success: true, trainedCount };
  } catch (err) {
    console.error(`[VTiger Sync] [WARN] Error en calibración de vTiger:`, err.message);
    return { success: false, error: err.message };
  }
}

