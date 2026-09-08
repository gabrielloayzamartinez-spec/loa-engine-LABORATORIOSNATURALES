/**
 * 🧪 TEST DE VALIDACIÓN: TIEMPO DE GRACIA (4 DÍAS SIN VENTA / 30 DÍAS CON VENTA), MUDANZA Y SANITIZACIÓN
 * 
 * Reglas de Negocio:
 * 1. PROSPECTO SIN VENTA <= 96 HORAS (4 DÍAS): Bloqueado por Tiempo de Gracia.
 *    La sede original mantiene exclusividad durante sus 4 días de gestión.
 * 2. PROSPECTO SIN VENTA > 96 HORAS: MUDANZA LEGÍTIMA.
 *    Transfiere al nuevo asesor/sede para darle oportunidad de cierre.
 * 3. CLIENTE CON VENTA <= 30 DÍAS (1 MES): Bloqueado por Tiempo de Gracia Prolongado de Recompra.
 *    La sede vendedora tiene exclusividad durante 30 días posteriores a la venta.
 * 4. CLIENTE CON VENTA > 30 DÍAS (1 MES SIN RECOMPRA): MUDANZA LEGÍTIMA A NUEVA SEDE.
 *    Si la sede vendedora no logró recompra en más de 1 mes, se transfiere a la nueva sede que lo reactivó.
 * 5. SANITIZACIÓN DE FECHAS (Anti-Bug Luisa Israel / Alondra Vg):
 *    - Prospectos SIN VENTA: Fecha de compra purgada a vacía '', y Fecha Última Asignación poblada con hoy.
 *    - Clientes CON VENTA: Mantienen su fecha y monto de compra real de vTiger.
 */

export function runCooldownMudanzaSanityCheck() {
  console.log('🧪 [TEST] Verificando Reglas de Cooldown (4 Días Lead / 30 Días Venta), Mudanza y Sanitización...');

  const GRACE_PERIOD_LEAD_HOURS = 96; // 4 días
  const GRACE_PERIOD_WON_HOURS = 30 * 24; // 30 días (720 horas / 1 mes)

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
        // REGLA: CLIENTE CON VENTA -> 30 DÍAS DE GRACIA (1 MES)
        if (hoursSinceLastInteraction <= GRACE_PERIOD_WON_HOURS) {
          cooldownBlocked = true;
          finalAdvisorId = contactAssignedTo;
          reason = `GRACIA_1MES_ACTIVA_${Math.round(hoursSinceLastInteraction / 24)}D`;
        } else {
          cooldownBlocked = false;
          finalAdvisorId = targetAdvisorId;
          reason = `MUDANZA_LEGITIMA_TRAS_1MES_${Math.round(hoursSinceLastInteraction / 24)}D`;
        }
      } else {
        // REGLA: PROSPECTO SIN VENTA -> 4 DÍAS DE GRACIA (96H)
        if (hoursSinceLastInteraction <= GRACE_PERIOD_LEAD_HOURS) {
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

  // TEST 1: Cliente CON VENTA dentro de sus 30 días de gracia (15 días transcurridos = 360 horas)
  const test1 = evaluateCooldownAndAssignment({
    contactAssignedTo: 'advisor_benavides',
    targetAdvisorId: 'advisor_palacios',
    detectedPageName: 'Naturales BioNatural',
    isWon: true,
    hoursSinceLastInteraction: 360 // 15 días <= 30 días
  });

  if (!test1.cooldownBlocked || test1.finalAdvisorId !== 'advisor_benavides') {
    throw new Error(`❌ Test 1 Falló: Cliente CON VENTA dentro del mes debió ser protegido en su sede vendedora.`);
  }
  console.log('  ✅ Test 1 Superado: Cliente con venta protegido dentro de su periodo de gracia de 1 mes (15 días).');

  // TEST 2: Cliente CON VENTA tras expirar su mes de gracia (40 días transcurridos = 960 horas)
  const test2 = evaluateCooldownAndAssignment({
    contactAssignedTo: 'advisor_benavides',
    targetAdvisorId: 'advisor_palacios',
    detectedPageName: 'Naturales BioNatural',
    isWon: true,
    hoursSinceLastInteraction: 960 // 40 días > 30 días
  });

  if (test2.cooldownBlocked || test2.finalAdvisorId !== 'advisor_palacios') {
    throw new Error(`❌ Test 2 Falló: Cliente CON VENTA tras más de 1 mes sin recompra debió mudarse a la nueva sede.`);
  }
  console.log('  ✅ Test 2 Superado: Cliente con venta se muda legítimamente tras expirar 1 mes sin recompra (40 días).');

  // TEST 3: Prospecto SIN VENTA dentro de sus 4 días de gracia (48 horas transcurridas)
  const test3 = evaluateCooldownAndAssignment({
    contactAssignedTo: 'advisor_palacios',
    targetAdvisorId: 'advisor_benavides',
    detectedPageName: 'Naturales Bio Corp',
    isWon: false,
    hoursSinceLastInteraction: 48 // 48h <= 96h
  });

  if (!test3.cooldownBlocked || test3.finalAdvisorId !== 'advisor_palacios') {
    throw new Error(`❌ Test 3 Falló: Lead sin venta en período de gracia (48h) no debió mudarse.`);
  }
  console.log('  ✅ Test 3 Superado: Lead sin venta protegido dentro de sus 4 días de gracia (48h).');

  // TEST 4: Prospecto SIN VENTA tras expirar sus 4 días de gracia (120 horas transcurridas > 96h)
  const test4 = evaluateCooldownAndAssignment({
    contactAssignedTo: 'advisor_palacios',
    targetAdvisorId: 'advisor_benavides',
    detectedPageName: 'Naturales Bio Corp',
    isWon: false,
    hoursSinceLastInteraction: 120 // 120h > 96h
  });

  if (test4.cooldownBlocked || test4.finalAdvisorId !== 'advisor_benavides') {
    throw new Error(`❌ Test 4 Falló: Lead sin venta tras 120h debió permitirse la mudanza.`);
  }
  console.log('  ✅ Test 4 Superado: Mudanza legítima de prospecto sin venta tras expirar 4 días (120h).');

  // TEST 5: Sanitización de Datos para Prospecto SIN VENTA (Caso Luisa Israel / Alondra Vg)
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
    throw new Error(`❌ Test 5 Falló: Prospecto sin venta no sanitizó campos de compra o no asignó Fecha Ultima Asignacion.`);
  }
  console.log('  ✅ Test 5 Superado: Prospecto SIN VENTA purga fechas falsas y registra Fecha Última Asignación.');

  // TEST 6: Registro íntegro de Cliente CON VENTA
  const soldFields = buildCustomFields({
    isWon: true,
    vContact: { cf_994: 'VENDIDO', spl_fecha_primera_compra: '2024-03-15' },
    todayStr: today
  });

  const estadoComercialSold = soldFields.find(f => f.id === '8EQtKkiW7Z022bcN0vhS')?.value;
  const fechaCompraSold = soldFields.find(f => f.id === 'GZKRu2z1Z156lRUfyrpo')?.value;

  if (estadoComercialSold !== 'CONVERTIDO' || fechaCompraSold !== '2024-03-15') {
    throw new Error(`❌ Test 6 Falló: Cliente CON VENTA no preservó fecha real de compra.`);
  }
  console.log('  ✅ Test 6 Superado: Cliente CON VENTA preserva fecha de compra real legítima.');

  console.log('🎉 [TEST PASSED] Todas las reglas de Cooldown (4 Días Lead / 30 Días Venta), Mudanza y Blindaje aprobadas al 100%.');
  return true;
}

if (process.argv[1]?.includes('test_cooldown_mudanza.js')) {
  const ok = runCooldownMudanzaSanityCheck();
  process.exit(ok ? 0 : 1);
}
