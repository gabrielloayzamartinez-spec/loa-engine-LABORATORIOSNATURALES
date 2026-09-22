"""
Smart Tag Generator for GoHighLevel Lead Segmentation & Targeted Campaigns.
Generates dynamic tags based on purchase year, branch, product category, and customer value.
"""

import re
import unicodedata
from datetime import datetime, date
from typing import List, Optional


def slugify(text: str) -> str:
    """Converts a string to a clean lowercase tag slug."""
    if not text:
        return "general"
    # Normalize unicode accents
    nfkd = unicodedata.normalize('NFKD', text)
    clean = "".join([c for c in nfkd if not unicodedata.combining(c)])
    # Remove non alphanumeric, replace with hyphens
    clean = re.sub(r'[^a-zA-Z0-9]+', '-', clean).strip('-').lower()
    return clean or "general"


def generate_smart_tags(
    year: Optional[int],
    branch: Optional[str],
    product: Optional[str],
    amount: float = 0.0,
    total_spent: float = 0.0,
    purchase_date: Optional[str] = None
) -> List[str]:
    """Generates a comprehensive list of tags for GoHighLevel segmentation."""
    tags = set()
    
    # 1. Base Tag
    tags.add("vtiger-historico")

    # 2. Year Tag
    if year and 2000 <= year <= 2030:
        tags.add(f"vtiger-{year}")

    # 3. Branch / Sede Tag
    if branch:
        slug_branch = slugify(branch)
        tags.add(f"sede-{slug_branch}")

    # 4. Product Type Classification
    if product:
        p_lower = product.lower()
        if any(w in p_lower for w in ["multifocal", "bifocal", "progresivo"]):
            tags.add("compra-multifocales")
        elif any(w in p_lower for w in ["antirreflejo", "blue", "filtro", "tratamiento"]):
            tags.add("compra-tratamiento-antirreflejo")
        elif any(w in p_lower for w in ["contacto", "pupilentes"]):
            tags.add("compra-lentes-contacto")
        elif any(w in p_lower for w in ["montura", "armazon", "marco"]):
            tags.add("compra-montura")
        elif any(w in p_lower for w in ["sol", "polarizado"]):
            tags.add("compra-lentes-sol")
        else:
            tags.add("compra-optica-general")

    # 5. Customer Value / Ticket Size Tag
    if amount >= 500 or total_spent >= 800:
        tags.add("cliente-vip-alto-valor")

    # 6. Repurchase Opportunity Tag (if purchase was > 10 months ago)
    if purchase_date:
        try:
            p_dt = datetime.strptime(purchase_date[:10], "%Y-%m-%d")
            months_ago = (datetime.now() - p_dt).days / 30.4
            if months_ago >= 10:
                tags.add("recompra-potencial-anual")
        except Exception:
            pass

    return sorted(list(tags))
