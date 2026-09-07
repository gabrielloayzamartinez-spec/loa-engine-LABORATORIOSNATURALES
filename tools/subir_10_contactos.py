"""
Script de Envío Rápido de 10 Contactos de Prueba con TODOS LOS DATOS (vTiger ➡️ GoHighLevel)
Extrae campos completos: Montos, Compras, Campañas, Estados USA, Zonas Horarias, Asesores y Notas Clínicas/Comerciales.
"""

import sys
import asyncio
import httpx
from src.config import settings
from src.core.logger import logger
from src.core.vtiger_client import vtiger_client
from src.agent_migration.full_transformer import transform_full_vtiger_record

sys.stdout.reconfigure(encoding='utf-8')


async def upload_10_full_contacts(webhook_url: str = None):
    logger.info("🚀 Conectando a vTiger CRM para extraer 10 registros con TODO EL HISTORIAL COMPLETO...")
    
    # 1. Fetch live 10 contacts from vTiger
    logged_in = await vtiger_client.login()
    if not logged_in:
        logger.error("❌ No se pudo autenticar en vTiger CRM")
        return

    q = "SELECT * FROM Contacts LIMIT 0, 10;"
    raw_contacts = await vtiger_client.query(q)
    logger.info(f"✅ Recuperados {len(raw_contacts)} contactos de vTiger con todos sus campos nativos.")

    headers = {
        "Authorization": f"Bearer {settings.ghl_api_key}",
        "Version": settings.ghl_api_version,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

    success_count = 0
    fail_count = 0

    print("\n" + "="*80)
    print("📋 DETALLE COMPLETO DE LOS 10 CONTACTOS A SINCRONIZAR:")
    print("="*80)

    async with httpx.AsyncClient(timeout=20.0) as client:
        for idx, raw_c in enumerate(raw_contacts, 1):
            full_data = transform_full_vtiger_record(raw_c)
            v_meta = full_data["vtiger_raw"]

            print(f"\n[{idx}/10] 👤 {full_data['name']} | 📞 {full_data['phone']}")
            print(f"     📍 Estado: {v_meta['estado_usa']} ({v_meta['zona_horaria']})")
            print(f"     💰 Monto Compras: ${v_meta['monto_usd']:.2f} USD ({v_meta['num_compras']} compras)")
            print(f"     🎯 Condición/Producto: {v_meta['condicion']}")
            print(f"     📢 Campaña: {v_meta['campana']}")
            print(f"     👩‍💼 Asesor: {v_meta['asesor']}")
            print(f"     🏷️ Tags en GHL: {full_data['tags']}")

            # Build payload for GHL with 100% mapped custom fields
            ghl_payload = {
                "locationId": settings.ghl_location_id,
                "firstName": full_data["firstName"],
                "lastName": full_data["lastName"],
                "name": full_data["name"],
                "phone": full_data["phone"],
                "email": full_data["email"],
                "city": full_data["city"],
                "state": full_data["state"],
                "timezone": full_data["timezone"],
                "source": full_data["source"],
                "tags": full_data["tags"],
                "customFields": full_data["customFields"]
            }

            if webhook_url:
                webhook_payload = {**ghl_payload, "notes": full_data["notes"]}
                try:
                    res = await client.post(webhook_url, json=webhook_payload)
                    if res.status_code in [200, 201, 202]:
                        logger.info(f"  --> ✅ [{idx}/10] {full_data['name']} ENVIADO A GHL VÍA WEBHOOK")
                        success_count += 1
                    else:
                        logger.warning(f"  --> ⚠️ [{idx}/10] Webhook Status {res.status_code}: {res.text[:60]}")
                        fail_count += 1
                except Exception as e:
                    logger.error(f"  --> ❌ Error enviando a Webhook: {e}")
                    fail_count += 1
            else:
                # Direct REST API
                try:
                    url_api = f"{settings.ghl_api_base_url}/contacts/upsert"
                    res = await client.post(url_api, json=ghl_payload, headers=headers)
                    if res.status_code in [200, 201]:
                        ghl_contact = res.json().get("contact", {})
                        ghl_id = ghl_contact.get("id", "OK")
                        logger.info(f"  --> ✅ [{idx}/10] {full_data['name']} CREADO EN GHL (ID: {ghl_id})")

                        # Attach internal note to contact
                        if ghl_id and ghl_id != "OK":
                            try:
                                note_url = f"{settings.ghl_api_base_url}/contacts/{ghl_id}/notes"
                                await client.post(note_url, json={"body": full_data["notes"]}, headers=headers)
                            except Exception:
                                pass

                        success_count += 1
                    else:
                        logger.error(f"  --> ❌ [{idx}/10] Error GHL {res.status_code}: {res.text[:80]}")
                        fail_count += 1
                except Exception as e:
                    logger.error(f"  --> ❌ Error enviando a GHL REST: {e}")
                    fail_count += 1

            await asyncio.sleep(0.4)

    print("\n" + "="*80)
    print(f"📊 RESUMEN FINAL:")
    print(f"  • Enviados con éxito: {success_count}")
    print(f"  • Pendientes/Fallidos: {fail_count}")
    print("="*80 + "\n")


if __name__ == "__main__":
    hook = sys.argv[1] if len(sys.argv) > 1 else None
    asyncio.run(upload_10_full_contacts(webhook_url=hook))
