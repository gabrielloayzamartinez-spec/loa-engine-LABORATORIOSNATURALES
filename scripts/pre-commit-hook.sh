#!/bin/sh
# ==============================================================================
# LOA ENGINE - PRE-COMMIT HOOK: DETECCIÓN DE SECRETOS (GENÉRICO, SIN HUELLAS)
# ==============================================================================
# Bloquea cualquier commit que contenga credenciales reales de GHL, Meta o vTiger.
#
# A diferencia de la versión anterior, este hook NO contiene fragmentos de tokens
# reales (antes incluía prefijos de PIT/App Secret que ya son información filtrada).
# Detecta por ESTRUCTURA, no por valor:
#   - PIT de GHL        : pit-<uuid>
#   - Token Meta        : EAA...
#   - JWT / Bearer      : eyJ...
#   - Asignación directa de secreto con valor no vacío en código fuente
#
# Instalación local (una sola vez por clon):
#   cp scripts/pre-commit-hook.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
# ==============================================================================

# PIT de GHL (formato uuid), tokens de Meta, JWT y claves de acceso vTiger inline.
PATTERNS='pit-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}|EAA[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{20,}\.|(ACCESS_KEY|API_KEY|APP_SECRET|ACCESS_TOKEN|VERIFY_TOKEN)[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_-]{16,}["'"'"']'

FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$FILES" ]; then
  exit 0
fi

FOUND=0
for FILE in $FILES; do
  case "$FILE" in
    *.env.example) continue ;;
    scripts/pre-commit-hook.sh) continue ;;
    .git/hooks/pre-commit) continue ;;
  esac

  if git show ":$FILE" 2>/dev/null | grep -nE "$PATTERNS" > /dev/null 2>&1; then
    echo ""
    echo "[SECURITY] Se detectaron posibles secretos en: $FILE"
    echo "   Líneas afectadas (valores enmascarados):"
    git show ":$FILE" 2>/dev/null | grep -nE "$PATTERNS" | sed -E 's/(pit-[0-9a-fA-F]{8})[0-9a-fA-F-]+/\1****/g; s/(EAA[A-Za-z0-9]{8})[A-Za-z0-9]+/\1****/g' | sed 's/^/     /'
    echo ""
    FOUND=1
  fi
done

if [ "$FOUND" -eq 1 ]; then
  echo "=============================================================="
  echo "  COMMIT BLOQUEADO: no subas tokens de GHL/Meta/vTiger."
  echo "  Usa variables de entorno (.env) o placeholders en .env.example."
  echo "=============================================================="
  exit 1
fi

exit 0
