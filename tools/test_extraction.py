from pathlib import Path
import json
from src.agent_migration.data_extractor import extract_data_from_file
from src.loa_engine.enrichment_module import EnrichmentModule
from src.config import INPUT_DIR

def run_test():
    file_path = Path("data/output/contactos_vtiger_ghl_parte_1.csv")
    print(f"Testing on {file_path}")
    
    # Extract records
    records = extract_data_from_file(file_path)
    print(f"Extracted {len(records)} records. Testing first 2...")
    
    with open('data/custom_fields_map.json', 'r') as f:
        field_id_map = json.load(f)
        
    for i, record in enumerate(records[:2]):
        print(f"\n--- RECORD {i+1} ---")
        normalized, ghl_payload = EnrichmentModule.enrich(record, field_id_map)
        
        print("Raw Record:", record.model_dump_json(indent=2))
        print("GHL Payload (Custom Fields Count):", len(ghl_payload.customFields))
        print("GHL Payload Dump:")
        print(ghl_payload.model_dump_json(indent=2))

if __name__ == "__main__":
    run_test()
