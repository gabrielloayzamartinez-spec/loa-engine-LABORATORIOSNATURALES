/**
 * LOA META TRACKER - GOOGLE APPS SCRIPT (AUTO-GENERADOR DE SEDES + TURNOS)
 * 
 * Conexión: Meta Graph API → Google Sheets (por Sede y Turno)
 * Ejecuta: Google Apps Script (cloud, no local)
 * Triggers: setupDiario (1:00 AM diario), sincronizarSedesHaciaMadre (cada hora)
 */

const META_ACCESS_TOKEN = 'EAAPBItTNhNwBSeOPwB8k1yMTiuwja7ePfZCBEIih1WHI6QWQoK4PW5qarVr9fslip6xAbk1vWUjWGM5ZA17ijgpJoyFOXBZAMQ3pmZAqan5oFIrInWNJhfMZC3GkrCErI6vhaTzEdEc3NZA71qoeoGhc8XVtur6rnlAeSZCVLl7UUD4sqZA9rZBMjxJKqddY4gL6JH5YCzVJS37KKfL02kP49Y69pewfVZBd8mLvpn88iYtnQM5haYt49SRYfSTaPWaxHqAaZCDkotLLkE2vqWHcSBw';
const GRAPH_VERSION = 'v20.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// HORA DE CORTE ENTRE TURNOS (Formato 24h). Ej: 14 = 2:00 PM
const HORA_CORTE_TURNO = 14; 

// MAPEO OFICIAL
const MAPPING_PAGINAS = {
  // SEDE PALACIOS
  "Naturales BioNatural": { sede: "PALACIOS", persona: "Naturales BioNatural", id: "566501466542620" },
  "Laboratorios Naturales BIO": { sede: "PALACIOS", persona: "Naturales BioNatural", id: "718150351371765" },
  "BIO Naturales Laboratorio": { sede: "PALACIOS", persona: "Naturales BioNatural", id: "UNKNOWN" }, // Agregado desde Node.js sync
  "BioNatural - Ultra": { sede: "PALACIOS", persona: "BioNatural Ultra", id: "111906554968800" },
  
  // SEDE BENAVIDES
  "Naturales Bio Corp": { sede: "BENAVIDES", persona: "Redes Benavides 1", id: "510617778807469" },
  "Bio Natural": { sede: "BENAVIDES", persona: "Redes Benavides 2", id: "126154270581792" },
  "BioNatural Fuerza": { sede: "BENAVIDES", persona: "Redes Benavides 2", id: "1147742788423762" },
  "Bio Natural Salud": { sede: "BENAVIDES", persona: "Redes Benavides 2", id: "UNKNOWN" }, // Agregado desde Node.js sync
  
  // SEDE ROOSEVELT
  "Bio Naturales": { sede: "ROOSEVELT", persona: "Redes Roosevelt", id: "568453466348355" },
  "BioNatural Plus": { sede: "ROOSEVELT", persona: "Redes Roosevelt", id: "1075001465705985" },
  "Bio Naturales Plus": { sede: "ROOSEVELT", persona: "Redes Roosevelt", id: "UNKNOWN" }, // Agregado desde Node.js sync
  
  // SEDE PIURA
  "BioNatural": { sede: "PIURA", persona: "Redes Piura", id: "1057863707412893" },
  "Natural Bio": { sede: "PIURA", persona: "Redes Piura", id: "1147257965133802" }
};

const LISTA_SEDES = ["PALACIOS", "BENAVIDES", "ROOSEVELT", "PIURA"];

function setupDiario() {
  const ssUniversal = SpreadsheetApp.getActiveSpreadsheet();
  const todayStr = Utilities.formatDate(new Date(), "GMT-05:00", "dd/MM/yyyy");
  
  const idsSedes = gestionarArchivosSedes(ssUniversal);
  const todasLasMetricas = extraerMetricasDeMeta();
  
  let sheetUniversalHoy = ssUniversal.getSheetByName(todayStr);
  if (!sheetUniversalHoy) {
    sheetUniversalHoy = ssUniversal.insertSheet(todayStr, 0);
  }
  crearEncabezados(sheetUniversalHoy);
  sheetUniversalHoy.getRange(2, 1, sheetUniversalHoy.getMaxRows(), sheetUniversalHoy.getMaxColumns()).clearContent();
  volcarDatos(sheetUniversalHoy, todasLasMetricas, todayStr);
  
  for (let sede in idsSedes) {
    let idSede = idsSedes[sede];
    if (!idSede) continue;
    try {
      let ssSede = SpreadsheetApp.openById(idSede);
      bloquearHojasAnteriores(ssSede);
      
      let sheetSedeHoy = ssSede.getSheetByName(todayStr);
      if (!sheetSedeHoy) {
        sheetSedeHoy = ssSede.insertSheet(todayStr, 0);
      }
      crearEncabezados(sheetSedeHoy);
      sheetSedeHoy.getRange(2, 1, sheetSedeHoy.getMaxRows(), sheetSedeHoy.getMaxColumns()).clearContent();
      
      let metricasSede = todasLasMetricas.filter(m => MAPPING_PAGINAS[m.pagina].sede === sede);
      volcarDatos(sheetSedeHoy, metricasSede, todayStr);
      
    } catch (err) {
      Logger.log(`Error sede ${sede}: ` + err.message);
    }
  }
}

function gestionarArchivosSedes(ssUniversal) {
  let sheetConfig = ssUniversal.getSheetByName("Configuración");
  if (!sheetConfig) {
    sheetConfig = ssUniversal.insertSheet("Configuración", ssUniversal.getNumSheets());
    sheetConfig.getRange("A1:B1").setValues([["SEDE", "ID DEL ARCHIVO (NO BORRAR)"]]).setFontWeight("bold");
    sheetConfig.setColumnWidth(2, 400);
  }

  const data = sheetConfig.getDataRange().getValues();
  const idsGuardados = {};
  for (let i = 1; i < data.length; i++) idsGuardados[data[i][0]] = data[i][1];

  let filaVacia = data.length + 1;
  const idsFinales = {};

  for (let i = 0; i < LISTA_SEDES.length; i++) {
    let sede = LISTA_SEDES[i];
    if (idsGuardados[sede]) {
      idsFinales[sede] = idsGuardados[sede];
    } else {
      let nuevoExcel = SpreadsheetApp.create(`TRACKER SEDE - ${sede}`);
      let nuevoId = nuevoExcel.getId();
      sheetConfig.getRange(filaVacia, 1, 1, 2).setValues([[sede, nuevoId]]);
      idsFinales[sede] = nuevoId;
      filaVacia++;
    }
  }
  return idsFinales;
}

function bloquearHojasAnteriores(ss) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    let protection = sheets[i].protect().setDescription('Bloqueo Automático Pasado');
    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
  }
}

function crearEncabezados(sheet) {
  const headers = [
    "X (Fecha)", "SEDE", "PERSONA", "PÁGINA (Agencia)", "TURNO", "Mensajes Recibidos", // Automáticos (1-6)
    "Números (#)", "Total de mensajes", "% Conversion", "NC (No Contesta)", "NC %",    // Manuales (7-17)
    "Ingresos Dobles", "Duplicados", "Error / Blockeo", "Otro País", 
    "Corte Previo", "CONVERSION 1"
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  
  // Estilo Automáticas (Columnas 1 al 6)
  sheet.getRange(1, 1, 1, 6)
       .setBackground("#1155cc") // Azul oscuro
       .setFontColor("#ffffff")  // Letras blancas
       .setFontSize(14)
       .setFontWeight("bold");

  // Estilo Manuales (Columnas 7 al 17)
  sheet.getRange(1, 7, 1, 11)
       .setBackground("#34a853") // Verde
       .setFontColor("#000000")  // Letras negras
       .setFontSize(14)
       .setFontWeight("bold");
}

function extraerMetricasDeMeta() {
  const url = `${GRAPH_BASE}/me/accounts?access_token=${META_ACCESS_TOKEN}`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  
  if (response.getResponseCode() !== 200) return [];
  
  const pagesData = JSON.parse(response.getContentText());
  const pages = pagesData.data || [];
  const metricas = [];
  
  // Forzar medianoche en la zona horaria del usuario (GMT-5) para evitar traer mensajes de ayer en la noche
  let dateStr = Utilities.formatDate(new Date(), "GMT-05:00", "yyyy-MM-dd");
  let midnightLocal = new Date(dateStr + "T00:00:00-05:00");
  const sinceTimestamp = Math.floor(midnightLocal.getTime() / 1000);

  for (let i = 0; i < pages.length; i++) {
    let page = pages[i];
    let pageName = page.name;
    
    if (!MAPPING_PAGINAS[pageName]) continue;

    let convUrl = `${GRAPH_BASE}/${page.id}/conversations?fields=updated_time,messages%7Bcreated_time,from,message%7D&access_token=${page.access_token}&since=${sinceTimestamp}`;
    let convRes = UrlFetchApp.fetch(convUrl, { muteHttpExceptions: true });
    
    let msgManana = 0; let numManana = 0;
    let msgTarde = 0;  let numTarde = 0;
    
    if (convRes.getResponseCode() === 200) {
      let convData = JSON.parse(convRes.getContentText());
      let convs = convData.data || [];
      for (let j = 0; j < convs.length; j++) {
        let msgs = convs[j].messages ? convs[j].messages.data : [];
        for (let k = 0; k < msgs.length; k++) {
          let msg = msgs[k];
          if (msg.from && msg.from.id !== page.id) {
            
            // Forzar la extracción de la hora exacta en GMT-5
            let msgDate = new Date(msg.created_time);
            let msgUnix = Math.floor(msgDate.getTime() / 1000);
            
            // REGLA DE ORO: Solo contar el mensaje si realmente se envió HOY (después de la medianoche)
            // Facebook devuelve historial viejo de la conversación, hay que ignorarlo.
            if (msgUnix >= sinceTimestamp) {
              let hour = parseInt(Utilities.formatDate(msgDate, "GMT-05:00", "H"), 10);
              let isManana = (hour < HORA_CORTE_TURNO);

              if (isManana) {
                msgManana++;
              } else {
                msgTarde++;
              }
            }
          }
        }
      }
    }
    
    // Asignamos prefijos para forzar el ordenamiento
    metricas.push({ pagina: pageName, turno: "1-MAÑANA", mensajes: msgManana, numeros: numManana });
    metricas.push({ pagina: pageName, turno: "2-TARDE", mensajes: msgTarde, numeros: numTarde });
  }
  return metricas;
}

function volcarDatos(sheet, metricas, fechaStr) {
  if (metricas.length === 0) return;
  
  const tempRows = [];
  for (let i = 0; i < metricas.length; i++) {
    let m = metricas[i];
    let mapeo = MAPPING_PAGINAS[m.pagina];
    tempRows.push([
      fechaStr, mapeo.sede, mapeo.persona, m.pagina, m.turno, m.mensajes, m.numeros, 
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]);
  }
  
  // Agregar WhatsApp
  let currentSedes = [...new Set(tempRows.map(r => r[1]))];
  for (let s of currentSedes) {
    tempRows.push([fechaStr, s, "WHATSAPP (Llenar Manual)", "", "1-MAÑANA", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    tempRows.push([fechaStr, s, "WHATSAPP (Llenar Manual)", "", "2-TARDE", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }

  // 1. ORDENAR POR SEDE -> TURNO -> PERSONA -> PÁGINA
  tempRows.sort((a, b) => {
    return a[1].localeCompare(b[1]) || // Sede
           a[4].localeCompare(b[4]) || // Turno (1-MAÑANA vs 2-TARDE)
           a[2].localeCompare(b[2]) || // Persona
           a[3].localeCompare(b[3]);   // Página
  });
  
  // 2. CONSTRUIR FILAS FINALES CON ESPACIOS EN BLANCO
  const finalRows = [];
  let currentTurno = tempRows[0][4]; // Inicializar con el primer turno (Ej. 1-MAÑANA)
  let currentSede = tempRows[0][1];
  
  // Fila vacía base (17 columnas vacías)
  const emptyRow = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];

  for(let r of tempRows) {
    // Si cambiamos de Turno dentro de la misma Sede, O si cambiamos de Sede, agregamos una fila en blanco
    if (r[1] !== currentSede || r[4] !== currentTurno) {
      finalRows.push([...emptyRow]); // Fila de espacio visual
      currentSede = r[1];
      currentTurno = r[4];
    }
    
    // Modificar nombre del turno visualmente de vuelta a normal
    if (r[4] === "1-MAÑANA") r[4] = "MAÑANA";
    if (r[4] === "2-TARDE") r[4] = "TARDE";
    
    finalRows.push(r);
  }

  let dataRange = sheet.getRange(2, 1, finalRows.length, finalRows[0].length);
  dataRange.setValues(finalRows);
  
  // Aplicar colores a las celdas de datos para que combinen con los encabezados
  // Automáticas (Columnas 1-6)
  sheet.getRange(2, 1, finalRows.length, 6)
       .setBackground("#4a86e8") // Azul un poco más claro que el header
       .setFontColor("#ffffff")  // Letras blancas
       .setFontSize(14);
       
  // Manuales (Columnas 7-17)
  sheet.getRange(2, 7, finalRows.length, 11)
       .setBackground("#b6d7a8") // Verde claro
       .setFontColor("#000000")  // Letras negras
       .setFontSize(14);
}

function instalarGatilloDiario() {
  // Gatillo 1: Extraer Meta y crear hojas (1:00 AM)
  ScriptApp.newTrigger('setupDiario').timeBased().everyDays(1).atHour(1).create();
  // Gatillo 2: Sincronizar manuales a la Madre (cada hora para que el admin lo vea en vivo)
  ScriptApp.newTrigger('sincronizarSedesHaciaMadre').timeBased().everyHours(1).create();
}

/**
 * RECOPILA LO QUE LAS SEDES ESCRIBIERON A MANO Y LO TRAE A LA MADRE
 */
function sincronizarSedesHaciaMadre() {
  const ssUniversal = SpreadsheetApp.getActiveSpreadsheet();
  const todayStr = Utilities.formatDate(new Date(), "GMT-05:00", "dd/MM/yyyy");
  
  let sheetUniversalHoy = ssUniversal.getSheetByName(todayStr);
  if (!sheetUniversalHoy) return;
  
  const idsSedes = gestionarArchivosSedes(ssUniversal);
  let allRows = [];
  
  for (let sede in idsSedes) {
    let idSede = idsSedes[sede];
    if (!idSede) continue;
    try {
      let ssSede = SpreadsheetApp.openById(idSede);
      let sheetSede = ssSede.getSheetByName(todayStr);
      if (sheetSede) {
        let maxRow = sheetSede.getLastRow();
        if (maxRow > 1) {
          let data = sheetSede.getRange(2, 1, maxRow - 1, sheetSede.getLastColumn()).getValues();
          // Limpiar filas 100% vacías antes de concatenar
          data = data.filter(row => row.join("").trim() !== "");
          allRows = allRows.concat(data);
        }
      }
    } catch(e) {
      Logger.log("Error sincronizando " + sede + ": " + e.message);
    }
  }
  
  if (allRows.length > 0) {
    sheetUniversalHoy.getRange(2, 1, sheetUniversalHoy.getMaxRows(), sheetUniversalHoy.getMaxColumns()).clearContent();
    sheetUniversalHoy.getRange(2, 1, allRows.length, allRows[0].length).setValues(allRows);
  }
}
