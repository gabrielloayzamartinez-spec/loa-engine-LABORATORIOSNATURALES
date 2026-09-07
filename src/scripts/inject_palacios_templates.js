import { GHL_CONFIG } from '../config/index.js';

const { apiKey, locationId } = GHL_CONFIG;

const HEADERS = {
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Catálogo completo de las 37 plantillas de Palacios
export const PALACIOS_TEMPLATES = [
  // ==========================================
  // 1. PALACIOS - REVIVIDO PÁGINA ERNESTO (6)
  // ==========================================
  {
    name: '[PALACIOS] [REVIVIDO ERNESTO] Buenos Días',
    body: '¡Buenos días, {{contact.first_name}}! 🌟 Para asegurarnos de que recibas tu MUESTRA GRATIS. Envíanos tu número de teléfono para registrarte y coordinar el envío. 😊'
  },
  {
    name: '[PALACIOS] [REVIVIDO ERNESTO] Hola Testo',
    body: '¡Hola {{contact.first_name}} 👋, sabemos que cuando algo afecta nuestra vitalidad o rendimiento, también puede influir en cómo nos sentimos día a día, déjanos tu NÚMERO para poder ayudarte y enviarte tu MUESTRA GRATIS 🔥'
  },
  {
    name: '[PALACIOS] [REVIVIDO ERNESTO] Hola Colágeno',
    body: '¡Hola {{contact.first_name}} 👋, A veces el cuerpo solo necesita un pequeño impulso natural para volver a moverse con más facilidad, déjanos tu NÚMERO para poder ayudarte y enviarte tu MUESTRA GRATIS 🌿'
  },
  {
    name: '[PALACIOS] [REVIVIDO ERNESTO] Para Testo (Últimas Unidades)',
    body: '{{contact.first_name}} ⚠️\nÚltimas unidades de tu muestra GRATIS para subir la testosterona.\nMándanos tu número y el lugar de envio YA para enviártela.'
  },
  {
    name: '[PALACIOS] [REVIVIDO ERNESTO] Para Colágeno (Dolores)',
    body: '{{contact.first_name}} ⚠️\nNo pierdas tu muestra GRATIS para ayudarte a con esos dolores.\nEnvíanos tu número y el lugar de envio ahora para asegurar el envío.'
  },
  {
    name: '[PALACIOS] [REVIVIDO ERNESTO] Te Obsequiamos Muestra',
    body: '✨¡TE OBSEQUIAMOS UNA MUESTRA GRATIS!✨\n💜 No dejes pasar esta oportunidad de mejorar tu salud. ¡Obtenla el día de hoy, solo déjanos tu número de teléfono y el lugar a donde la enviaremos para programar el envío! 🎁'
  },

  // ==========================================
  // 2. PALACIOS - REVIVIDO PÁGINA ULTRA (8)
  // ==========================================
  {
    name: '[PALACIOS] [REVIVIDO ULTRA] Buenos Días',
    body: '¡Buenos dias {{contact.first_name}}! Queremos ayudarte a mejorar tu salud de forma natural 💚. Déjanos tu número y uno de nuestros especialistas te orientará sin compromiso.'
  },
  {
    name: '[PALACIOS] [REVIVIDO ULTRA] Hola Diabetes',
    body: 'Hola {{contact.first_name}} 😊 Queremos ayudarte a cuidar tu bienestar. Déjanos tu número de teléfono para coordinar tu envío y brindarte la atención que necesitas. 💚'
  },
  {
    name: '[PALACIOS] [REVIVIDO ULTRA] Hola Testo',
    body: '¡Hola {{contact.first_name}} 👋 Sabemos que cuando algo afecta nuestra vitalidad o rendimiento, también puede influir en cómo nos sentimos día a día. Déjanos tu número de teléfono para poder ayudarte y coordinar tu envío. 🔥'
  },
  {
    name: '[PALACIOS] [REVIVIDO ULTRA] Hola Colágeno',
    body: '¡Hola {{contact.first_name}}! 👋 A veces el cuerpo solo necesita un pequeño impulso natural para volver a moverse con más facilidad. Déjanos tu número de teléfono para poder ayudarte y coordinar tu envío. 🌿'
  },
  {
    name: '[PALACIOS] [REVIVIDO ULTRA] Para Diabetes',
    body: '{{contact.first_name}} ⚠️\nTu tratamiento para ayudar a controlar la diabetes está casi listo.\nEnvíanos tu número y el lugar de envío ahora para completar el proceso y asegurar el envío.'
  },
  {
    name: '[PALACIOS] [REVIVIDO ULTRA] Para Testo',
    body: '{{contact.first_name}} ⚠️ ¡Últimas unidades disponibles!\n💪 Es tu oportunidad para apoyar tu vitalidad y energía.\n📦 Déjanos tu número de teléfono y el lugar de envío para asegurar tu entrega'
  },
  {
    name: '[PALACIOS] [REVIVIDO ULTRA] Para Colágeno',
    body: '¡{{contact.first_name}}! Para que no pierdas tu MUESTRA GRATIS, indícanos tu número de teléfono y el lugar a donde la enviaremos para coordinar el envío. 😊❤'
  },
  {
    name: '[PALACIOS] [REVIVIDO ULTRA] Te Obsequiamos Muestra',
    body: '✨¡Tu envío está casi listo!✨\n💜 No dejes pasar esta oportunidad de apoyar el cuidado de tu salud. Déjanos tu número de teléfono y el lugar a donde enviaremos tu pedido para programar el envío. 📦'
  },

  // ==========================================
  // 3. PALACIOS - TIPIFICACIONES Y CHAT EN VIVO (23)
  // ==========================================
  {
    name: '[PALACIOS] [CHAT] Especialista Telefónico',
    body: 'El especialista te ayudará con toda la información mediante una llamada telefónica, brindame por favor tu número de teléfono para conversar con tu especialista el día de hoy 💚.'
  },
  {
    name: '[PALACIOS] [CHAT] Tipo Diabetes',
    body: '{{contact.first_name}} para orientarte mejor, ¿sabes qué tipo de diabetes te han indicado?'
  },
  {
    name: '[PALACIOS] [CHAT] Síntomas Diabetes',
    body: 'Perfecto {{contact.first_name}} 😊 Para orientarte mejor, cuéntame: ¿qué has notado más últimamente: azúcar alta, cansancio, hormigueo, o dolor en las piernas?'
  },
  {
    name: '[PALACIOS] [CHAT] Combate Dolor / Diabetes',
    body: 'Cuéntame ¿Tienes diabetes, dolor articular o algún otro síntoma?'
  },
  {
    name: '[PALACIOS] [CHAT] Gracias y Confirmación',
    body: 'Muchas Gracias {{contact.first_name}}, en breve nos comunicaremos contigo para coordinar tu entrega 🎁. Ten en cuenta que la MUESTRA GRATIS solo se activa hoy al atender la llamada. 💚'
  },
  {
    name: '[PALACIOS] [CHAT] Compasión y Apoyo',
    body: 'Comprendo como debes de sentirte, te ayudaremos, ¡No te preocupes {{contact.first_name}}! 💙'
  },
  {
    name: '[PALACIOS] [CHAT] Deseo Mejorar Salud',
    body: 'Cuentame ¿Que deseas mejorar en tu salud?'
  },
  {
    name: '[PALACIOS] [CHAT] No Contesta / Buzón',
    body: '{{contact.first_name}}, te hemos llamado y nos manda a buzón de voz 😔, ¿El número está correcto?'
  },
  {
    name: '[PALACIOS] [CHAT] No te Preocupes',
    body: 'Comprendo {{contact.first_name}}, no te preocupes, te vamos ayudar con tus dolencias'
  },
  {
    name: '[PALACIOS] [CHAT] Tiempo con Padecimiento',
    body: '¡Oh! Entiendo {{contact.first_name}}, ¿Y hace cuánto tiempo tienes con ese padecimiento?'
  },
  {
    name: '[PALACIOS] [CHAT] Atención en Español y Gratuita',
    body: 'La atención es en español y completamente gratuita.'
  },
  {
    name: '[PALACIOS] [CHAT] Ubicación y Envíos USA/PR',
    body: 'Te comento {{contact.first_name}}, nos encontramos en Estados Unidos, contamos con envíos a todos los Estados y también a Puerto Rico 🤗'
  },
  {
    name: '[PALACIOS] [CHAT] Opciones Testosterona / Salud Sexual',
    body: 'Perfecto, {{contact.first_name}} 🙌 Para poder darte la muestra más adecuada, ¿Qué es lo que más te gustaría mejorar en tu salud sexual?'
  },
  {
    name: '[PALACIOS] [CHAT] Coméntame Malestar',
    body: 'Coméntame ¿Que dolor o malestar estás sintiendo? 😊'
  },
  {
    name: '[PALACIOS] [CHAT] Perfecto / Falta Teléfono',
    body: 'Perfecto {{contact.first_name}}, ahora solo falta tu número de telefono para poder enviarte la MUESTRA GRATIS 🎁'
  },
  {
    name: '[PALACIOS] [CHAT] Cómo Podemos Ayudarte',
    body: '{{contact.first_name}} cómentame ¿Cómo podemos ayudarte? ❤'
  },
  {
    name: '[PALACIOS] [CHAT] Volver a Comunicarnos',
    body: '¿Nos podemos comunicar contigo para ayudarte? 📞'
  },
  {
    name: '[PALACIOS] [CHAT] Bienvenida Oficial',
    body: 'Hola {{contact.first_name}} ¡Bienvenido a Naturales BioNatural!'
  },
  {
    name: '[PALACIOS] [CHAT] Bienvenida 2 / Interés en Muestra',
    body: '¡Hola {{contact.first_name}}! 😊 Qué gusto saludarte. Vi que te interesa la muestra gratuita, cuéntame un poquito, ¿qué molestia te gustaría aliviar?'
  },
  {
    name: '[PALACIOS] [CHAT] Espera de Respuesta',
    body: '{{contact.first_name}}, estamos a la espera de tu respuesta para poder ayudarte. 😊'
  },
  {
    name: '[PALACIOS] [CHAT] Claro que Sí',
    body: 'Claro que si {{contact.first_name}}, te ayudaremos con la MUESTRA GRATIS ❤'
  },
  {
    name: '[PALACIOS] [CHAT] Finalizar Registro Teléfono',
    body: 'Para finalizar el registro de tu MUESTRA GRATIS, indícame tu número de teléfono para poder coordinar la entrega. 🎁 💛'
  },
  {
    name: '[PALACIOS] [CHAT] Terminar Registro Datos y Envío',
    body: 'Para terminar el registro de tu MUESTRA GRATIS, indícame tu número de teléfono y el lugar de envio para así poder coordinar la entrega 🏡 🏃♂️'
  }
];

export async function injectPalaciosTemplates() {
  console.log("\n=================================================");
  console.log("🚀 INYECTOR DE PLANTILLAS PARA PALACIOS EN GHL");
  console.log(`Total de plantillas a inyectar: ${PALACIOS_TEMPLATES.length}`);
  console.log("=================================================\n");

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < PALACIOS_TEMPLATES.length; i++) {
    const t = PALACIOS_TEMPLATES[i];
    console.log(`[${i + 1}/${PALACIOS_TEMPLATES.length}] Inyectando: ${t.name}...`);

    try {
      const res = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/templates`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          name: t.name,
          type: 'sms',
          template: {
            body: t.body,
            attachments: []
          }
        })
      });

      if (res.status === 201 || res.status === 200) {
        const data = await res.json();
        console.log(`  ✅ Creada con éxito (ID: ${data.template?.id || data.id || 'OK'})`);
        successCount++;
      } else {
        const errText = await res.text();
        console.error(`  ❌ Error (${res.status}): ${errText}`);
        errorCount++;
        if (res.status === 401) {
          console.log("\n⚠️ DETENIDO: El Token de GHL requiere el permiso 'templates.write'.");
          console.log("Ve a GHL > Settings > Developers > Private Integrations > Editar Token > Marcar 'Templates (Write)'.");
          break;
        }
      }
    } catch (e) {
      console.error(`  ❌ Excepción: ${e.message}`);
      errorCount++;
    }

    await sleep(300);
  }

  console.log("\n=================================================");
  console.log(`📊 RESULTADO FINAL:`);
  console.log(`✅ Creadas con éxito: ${successCount}`);
  console.log(`❌ Fallidas / Pendientes: ${errorCount}`);
  console.log("=================================================\n");
}

if (process.argv[1] && process.argv[1].endsWith('inject_palacios_templates.js')) {
  injectPalaciosTemplates();
}
