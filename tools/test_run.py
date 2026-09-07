import asyncio
from src.core.ghl_client import GHLClient
from src.core.vtiger_client import VTigerClient
from src.agent_migration.full_transformer import transform_full_vtiger_record

async def test_run():
    ghl = GHLClient()
    vt = VTigerClient()
    await vt.login()
    
    res = await ghl._request('GET', 'opportunities/search?location_id='+ghl.location_id+'&pipeline_id=w62fzyP9nCmTBurH4HIi')
    opps = res.get('opportunities', [])[:5]
    
    print("\n--- REPORTE DE PRUEBA (5 TARJETAS) ---")
    for o in opps:
        c_res = await ghl._request('GET', f'contacts/{o["contactId"]}')
        v_id = next((cf['value'] for cf in c_res.get('contact', {}).get('customFields', []) if cf['id'] == 'PNr3LsTpXAwmyvPnvI11'), None)
        
        vt_res = await vt.query(f"SELECT * FROM Contacts WHERE id = '{v_id}'")
        if not vt_res: continue
            
        fd = transform_full_vtiger_record(vt_res[0])
        canal = fd['vtiger_raw'].get('canal_origen', '')
        cond = fd['vtiger_raw'].get('condicion', '')
        monto = fd['vtiger_raw'].get('monto_usd', 0)
        
        nn = f"{fd.get('name')} - {canal} - {cond}" if canal and cond else fd.get('name')
        print(f"Original: {o['name']}")
        print(f"Nuevo   : {nn}")
        print(f"Monto   : ${monto}")
        print("-" * 40)
        
    await ghl.close()

if __name__ == '__main__':
    asyncio.run(test_run())
