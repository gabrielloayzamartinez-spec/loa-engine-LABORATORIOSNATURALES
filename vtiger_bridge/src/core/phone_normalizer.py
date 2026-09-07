"""
E.164 Phone Normalizer and Sanitizer for Latin America (+51 Perú) and International (+1 USA).
Robust regex parsing that handles edge cases, multiple phone numbers, and formatting artifacts.
"""

import re
from typing import Optional, Tuple


def normalize_phone(raw_phone: Optional[str], default_country_code: str = "+1") -> Tuple[Optional[str], bool]:
    """
    Normalizes a raw phone string to strict E.164 format.
    Defaults to USA / Canada (+1).
    
    Handles US formats:
      - (305) 123-4567 -> +13051234567
      - 305.123.4567 -> +13051234567
      - 1-800-123-4567 -> +18001234567
      - 3051234567 -> +13051234567
    
    Returns:
        (normalized_phone_string, is_valid_boolean)
    """
    if not raw_phone:
        return None, False

    text = str(raw_phone).strip()
    if not text or text.lower() in ("null", "none", "nan", "0", "-", "s/n", "no tiene", "n/a"):
        return None, False

    # Extract first phone number if multiple exist (split by slashes, commas, pipes, or words)
    # Note: Do not split single '-' because US numbers use 305-123-4567 format
    first_part = re.split(r'[/,;|\n\r]|\s+o\s+|\s+y\s+|\s+or\s+|\s+and\s+|\s+ext\s+|\s+/\s+', text, flags=re.IGNORECASE)[0]
    
    # Remove all non-numeric characters except leading plus
    has_leading_plus = first_part.strip().startswith("+")
    digits = re.sub(r'\D', '', first_part)

    if not digits or len(digits) < 7:
        return None, False

    # Case 1: Standard 10-digit US Phone Number (e.g. 3051234567) -> +13051234567
    if len(digits) == 10 and digits[0] in "23456789":
        return f"+1{digits}", True

    # Case 2: 11-digit US Phone Number starting with 1 (e.g. 13051234567) -> +13051234567
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}", True

    # Case 3: Standard International with leading plus (+1..., +51..., etc.)
    if has_leading_plus and 10 <= len(digits) <= 15:
        return f"+{digits}", True

    # Case 4: Peruvian Mobile fallback (9 digits starting with 9) if mixed data
    if len(digits) == 9 and digits.startswith("9"):
        return f"+51{digits}", True
    if digits.startswith("51") and len(digits) == 11 and digits[2] == "9":
        return f"+{digits}", True

    # Case 5: 10-digit assuming default country code
    if len(digits) == 10:
        clean_code = default_country_code.lstrip("+")
        return f"+{clean_code}{digits}", True

    # Case 6: Fallback for valid international length
    if 10 <= len(digits) <= 15:
        clean_code = default_country_code.lstrip("+")
        return f"+{clean_code}{digits}", True

    return None, False
