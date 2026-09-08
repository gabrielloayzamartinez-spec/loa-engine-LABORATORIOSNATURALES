/**
 * 🧪 TEST DE VALIDACIÓN: TIEMPO DE GRACIA (4 DÍAS / 96H), MUDANZA Y RESERVA DE VENTA
 * 
 * Reglas de Negocio:
 * 1. CLIENTE CON VENTA (CONVERTIDO): Reservado permanentemente para su oficina de venta.
 *    Nunca se muda de sede para recompras.
 * 2. PROSPECTO SIN VENTA <= 96 HORAS (4 DÍAS): Bloqueado por Tiempo de Gracia.
 *    La sede original mantiene exclusividad durante sus 4 días de gestión.
 * 3. PROSPECTO SIN VENTA > 96 HORAS: MUDANZA LEGÍTIMA.
 *    Transfiere al nuevo asesor/sede que reactivó la conversación para darle oportunidad de cierre.
 * 4. SANITIZACIÓN DE FECHAS (Anti-Bug Luisa Israel):
 *    - Prospectos SIN VENTA: Fecha de compra purgada a vacía '', y Fecha Última Asignación poblada con hoy.
 *    - Clientes CON VENTA: Mantienen su fecha y monto de compra real de vTiger.
 */

export function runCooldownMudanzaSanityCheck() {
  console.log('🧪 [TEST] Verificando Reglas de Cooldown (4 Días de Gracia), Mudanza y Sanitización...');

  const GRACE_PERIOD_HOURS = 96; // 4 días

  function evaluateCooldownAndAssignment({
    contactAssignedTo,
    targetAdvisorId,
    detectedPageName,
    isWon,
    hoursSinceLastInteraction
  }) {
    let cooldownBlocked = false;
    let finalAdvisorId = targetAdvisorId;
    let reason = '';

    if (targetAdvisorId && contactAssignedTo && targetAdvisorId !== contactAssignedTo) {
      if (isWon) {
        // REGLA 1: CLIENTE CON VENTA -> RESERVADO PERMANENTE
        cooldownBlocked = true;
        finalAdvisorId = contactAssignedTo;
        reason = `RESERVADO_OFICINA_VENTA`;
      } else {
        // REGLA 2 Y 3: PROSPECTO SIN VENTA -> 4 DÍAS DE GRACIA
        if (hoursSinceLastInteraction <= GRACE_PERIOD_HOURS) {
          cooldownBlocked = true;
          finalAdvisorId = contactAssignedTo;
          reason = `TIEMPO_GRACIA_ACTIVO_${Math.round(hoursSinceLastInteraction)}H`;
        } else {
          cooldownBlocked = false;
          finalAdvisorId = targetAdvisorId;
          reason = `MUDANZA_LEGITIMA_${Math.round(hoursSinceLastInteraction)}H`;
        }
      }
    }

    return { cooldownBlocked, finalAdvisorId, reason };
  }

  function buildCustomFields({ isWon, vContact, todayStr }) {
    const fields = [
      { id: '8EQtKkiW7Z022bcN0vhS', value: isWon ? 'CONVERTIDO' : 'SIN VENTA' },
      { id: '5TY5AIOpu1c8f6WosyF2', value: vContact?.cf_994 || (isWon ? 'VENDIDO' : 'SIN TRABAJAR') }
    ];

    if (!isWon) {
      fields.push({ id: 'RLxFOTXkICXLWShjaLaB', value: todayStr }); // Fecha Ultima Asignacion
      fields.push({ id: 'GZKRu2z1Z156lRUfyrpo', value: '' }); // Fecha compra PURGADA
      fields.push({ id: 'OJYOXVqKp33A6T5HZK5I', value: '' }); // vTiger Fecha Primera Compra PURGADA
      fields.push({ id: 'cyn0Ar7GMvmzYBKw0SJu', value: '' }); // vTiger Fecha Ultima Compra PURGADA
      fields.push({ id: '5js0Lfbh5XDLq87SDgdT', value: '' }); // Precio venta PURGADO
    } else {
      if (vContact?.spl_fecha_primera_compra) {
        fields.push({ id: 'GZKRu2z1Z156lRUfyrpo', value: vContact.spl_fecha_primera_compra });
        fields.push({ id: 'OJYOXVqKp33A6T5HZK5I', value: vContact.spl_fecha_primera_compra });
      }
    }
    return fields;
  }

  // TEST 1: Cliente con Venta (CONVERTIDO) intenta escribir a otra oficina (ej. Benavides a Palacios)
  const test1 = evaluateCooldownAndAssignment({
    contactAssignedTo: 'advisor_benavides',
    targetAdvisorId: 'advisor_palacios',
    detectedPageName: 'Naturales BioNatural',
    isWon: true,
    hoursSinceLastInteraction: 200 // Más de 4 días
  });

  if (!test1.cooldownBlocked || test1.finalAdvisorId !== 'advisor_benavides') {
    throw new Error(`❌ Test 1 Falló: Cliente CON VENTA debió ser reservado para la oficina vendedora.`);
  }
  console.log('  ✅ Test 1 Superado: Cliente con venta reservado permanentemente para oficina de venta.');

  // TEST 2: Prospecto SIN VENTA dentro del periodo de gracia de 4 días (48 horas transcurridas)
  const test2 = evaluateCooldownAndAssignment({
    contactAssignedTo: 'advisor_palacios',
    targetAdvisorId: 'advisor_benavides',
    detectedPageName: 'Naturales Bio Corp',
    isWon: false,
    hoursSinceLastInteraction: 48 // 48h <= 96h
  });

  if (!test2.cooldownBlocked || test2.finalAdvisorId !== 'advisor_palacios') {
    throw new Error(`❌ Test 2 Falló: Lead en período de gracia (48h) no debió mudarse de sede.`);
  }
  console.log('  ✅ Test 2 Superado: Lead sin venta protegido dentro de los 4 días de gracia (48h).');

  // TEST 3: Prospecto SIN VENTA con gracia vencida (120 horas transcurridas > 96h)
  const test3 = evaluateCooldownAndAssignment({
    contactAssignedTo: 'advisor_palacios',
    targetAdvisorId: 'advisor_benavides',
    detectedPageName: 'Naturales Bio Corp',
    isWon: false,
    hoursSinceLastInteraction: 120 // 120h > 96h
  });

  if (test3.cooldownBlocked || test3.finalAdvisorId !== 'advisor_benavides') {
    throw new Error(`❌ Test 3 Falló: Lead sin venta tras 120h debió permitirse la mudanza.`);
  }
  console.log('  ✅ Test 3 Superado: Mudanza legítima permitida tras expirar 4 días sin venta (120h).');

  // TEST 4: Sanitización de Datos para Prospecto SIN VENTA (Caso Luisa Israel)
  const today = '2026-09-08';
  const unsoldFields = buildCustomFields({
    isWon: false,
    vContact: { cf_994: 'SIN TRABAJAR' },
    todayStr: today
  });

  const estadoComercial = unsoldFields.find(f => f.id === '8EQtKkiW7Z022bcN0vhS')?.value;
  const fechaAsignacion = unsoldFields.find(f => f.id === 'RLxFOTXkICXLWShjaLaB')?.value;
  const fechaCompra = unsoldFields.find(f => f.id === 'GZKRu2z1Z156lRUfyrpo')?.value;
  const precioVenta = unsoldFields.find(f => f.id === '5js0Lfbh5XDLq87SDgdT')?.value;

  if (estadoComercial !== 'SIN VENTA' || fechaAsignacion !== today || fechaCompra !== '' || precioVenta !== '') {
    throw new Error(`❌ Test 4 Falló: Prospecto sin venta no sanitizó campos de compra o no asignó Fecha Ultima Asignacion.`);
  }
  console.log('  ✅ Test 4 Superado: Prospecto SIN VENTA purga fechas falsas y registra Fecha Última Asignación.');

  // TEST 5: Registro íntegro de Cliente CON VENTA
  const soldFields = buildCustomFields({
    isWon: true,
    vContact: { cf_994: 'VENDIDO', spl_fecha_primera_compra: '2024-03-15' },
    todayStr: today
  });

  const estadoComercialSold = soldFields.find(f => f.id === '8EQtKkiW7Z022bcN0vhS')?.value;
  const fechaCompraSold = soldFields.find(f => f.id === 'GZKRu2z1Z156lRUfyrpo')?.value;

  if (estadoComercialSold !== 'CONVERTIDO' || fechaCompraSold !== '2024-03-15') {
    throw new Error(`❌ Test 5 Falló: Cliente CON VENTA no preservó fecha real de compra.`);
  }
  console.log('  ✅ Test 5 Superado: Cliente CON VENTA preserva fecha de compra real legítima.');

  console.log('🎉 [TEST PASSED] Todas las reglas de Cooldown (4 Días), Mudanza y Blindaje aprobadas con éxito.');
  return true;
}

if (process.argv[1]?.includes('test_cooldown_mudanza.js')) {
  const ok = runCooldownMudanzaSanityCheck();
  process.exit(ok ? 0 : 1);
}
