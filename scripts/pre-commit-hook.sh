#!/bin/sh
# ==============================================================================
# LOA ENGINE - PRE-COMMIT HOOK: Detección de Secretos
# Bloquea cualquier commit que contenga tokens de GHL, Meta o vTiger.
#
# Instalación local (una sola vez por clon):
#   cp scripts/pre-commit-hook.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
# ==============================================================================

PATTERNS='pit-[a-z0-9]\{8,\}|EAA[A-Za-z0-9]\{15,\}|KkfUOi|fe27d772|ff5d72b7'

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
    echo "❌ [SECURITY] Se detectaron posibles secretos en: $FILE"
    echo "   Líneas afectadas:"
    git show ":$FILE" 2>/dev/null | grep -nE "$PATTERNS" | sed 's/^/     /'
    echo ""
    FOUND=1
  fi
done

if [ "$FOUND" -eq 1 ]; then
  echo "=============================================================="
  echo "  COMMIT BLOQUEADO: no subas tokens de GHL/Meta/vTiger."
  echo "  Usa variables de entorno (.env) o placeholders."
  echo "=============================================================="
  exit 1
fi

exit 0
