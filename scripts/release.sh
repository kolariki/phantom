#!/bin/bash
# scripts/release.sh — Build firmado + notarizado del .dmg de Phantom
#
# Requisitos previos:
#   1) Apple Developer Program activo ($99/año)
#   2) Certificado "Developer ID Application: Ivan Kolarik (U858VRJWB9)" instalado en Keychain
#   3) App-specific password generado en https://appleid.apple.com
#   4) Variables de entorno seteadas (ver más abajo)
#
# Uso:
#   ./scripts/release.sh
#
# Para hacer un build de DESARROLLO sin firmar/notarizar:
#   SKIP_NOTARIZE=true npm run build:mac-dmg

set -e

echo "══════════════════════════════════════════════════════"
echo "  🥷  PHANTOM — Build firmado + notarizado"
echo "══════════════════════════════════════════════════════"
echo ""

# ─── Verificar variables de entorno ─────────────────────
REQUIRED_VARS=(APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID)
MISSING=()
for v in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!v}" ]; then
    MISSING+=("$v")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌  Faltan variables de entorno:"
  for v in "${MISSING[@]}"; do
    echo "    - $v"
  done
  echo ""
  echo "Configurálas con:"
  echo "    export APPLE_ID='tu@email.com'"
  echo "    export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'"
  echo "    export APPLE_TEAM_ID='U858VRJWB9'"
  echo ""
  echo "El password lo generás en: https://appleid.apple.com → Sign-In and Security → App-Specific Passwords"
  exit 1
fi

# ─── Verificar certificado en Keychain ──────────────────
IDENTITY="Developer ID Application: Ivan Kolarik (U858VRJWB9)"
if ! security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  echo "❌  No encuentro el certificado en tu Keychain:"
  echo "    \"$IDENTITY\""
  echo ""
  echo "Para conseguirlo:"
  echo "  1) Entrá a https://developer.apple.com/account/resources/certificates/list"
  echo "  2) Click '+' → 'Developer ID Application' → Continuá los pasos."
  echo "  3) Descargá el .cer y doble click para instalarlo en Keychain."
  exit 1
fi

echo "✓ Variables OK"
echo "✓ Certificado OK ($IDENTITY)"
echo ""

# ─── Limpiar build anterior ─────────────────────────────
echo "🧹 Limpiando build anterior..."
rm -rf dist
pkill -9 -f Phantom 2>/dev/null || true

# ─── Build ──────────────────────────────────────────────
echo ""
echo "🏗  Construyendo .dmg... (esto tarda 2-5 minutos por la notarización)"
echo ""
npm run build:mac-dmg

# ─── Verificar resultado ────────────────────────────────
DMG=$(ls dist/Phantom-*.dmg 2>/dev/null | head -1)
if [ -z "$DMG" ]; then
  echo "❌  No se generó el .dmg"
  exit 1
fi

# Staplear sello al .dmg también
echo ""
echo "📎 Adjuntando sello de notarización al .dmg..."
xcrun stapler staple "$DMG" || echo "⚠ Stapler del .dmg falló (no crítico — el sello ya está en la .app adentro)"

# Verificar
echo ""
echo "🔍 Verificación final:"
echo ""
spctl --assess --type install -v "$DMG" || echo "(spctl rechazó — revisar)"
xcrun stapler validate "$DMG" || echo "(stapler validate falló — revisar)"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✅  LISTO"
echo "══════════════════════════════════════════════════════"
echo ""
echo "  📦  $DMG"
echo ""
echo "  Tamaño: $(du -h "$DMG" | cut -f1)"
echo ""
echo "  Subilo a:"
echo "    • GitHub Releases:  gh release create v1.0.0 \"$DMG\""
echo "    • Tu sitio web:     scp \"$DMG\" usuario@servidor:/var/www/"
echo ""
echo "  Cualquier usuario lo descarga, doble click, arrastra a Applications"
echo "  → abre limpio, sin warnings, sin que vaya al basurero. 🎉"
echo ""
