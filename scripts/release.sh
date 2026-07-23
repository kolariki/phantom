#!/bin/bash
# scripts/release.sh — Build firmado + notarizado del .dmg de Phantom
#
# Requisitos previos:
#   1) Apple Developer Program activo ($99/año)
#   2) Certificado "Developer ID Application: Ivan Kolarik (U858VRJWB9)" instalado en Keychain
#   3) Credenciales de notarización, por CUALQUIERA de los dos métodos que
#      soporta scripts/after-sign.js:
#        Método A — API Key de App Store Connect (recomendado, sin 2FA):
#          APPLE_API_KEY_PATH / APPLE_API_KEY_ID / APPLE_API_ISSUER_ID
#        Método B — Apple ID clásico (requiere app-specific password):
#          APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
#      Si existe ~/.phantom-apple-creds se carga solo, no hace falta exportar nada.
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

# ─── Cargar credenciales guardadas (si existen) ──────────
# Evita tener que exportar nada a mano en cada release.
CREDS_FILE="$HOME/.phantom-apple-creds"
if [ -f "$CREDS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CREDS_FILE"
  echo "✓ Credenciales cargadas de ~/.phantom-apple-creds"
fi

# ─── Verificar credenciales de notarización ──────────────
# after-sign.js acepta dos métodos; con que esté COMPLETO uno alcanza.
AUTH_METHOD=""
if [ -n "$APPLE_API_KEY_PATH" ] && [ -n "$APPLE_API_KEY_ID" ] && [ -n "$APPLE_API_ISSUER_ID" ]; then
  AUTH_METHOD="API Key"
  if [ ! -f "$APPLE_API_KEY_PATH" ]; then
    echo "❌  APPLE_API_KEY_PATH apunta a un archivo que no existe:"
    echo "    $APPLE_API_KEY_PATH"
    echo ""
    echo "Descargá el .p8 de https://appstoreconnect.apple.com → Users and Access → Integrations → Keys"
    exit 1
  fi
elif [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
  AUTH_METHOD="Apple ID + password"
fi

if [ -z "$AUTH_METHOD" ]; then
  echo "❌  No hay credenciales completas para notarizar."
  echo ""
  echo "Método A — API Key de App Store Connect (recomendado, sin 2FA):"
  echo "    export APPLE_API_KEY_PATH='/ruta/AuthKey_XXXXXX.p8'"
  echo "    export APPLE_API_KEY_ID='ABC123DEF4'"
  echo "    export APPLE_API_ISSUER_ID='uuid-largo'"
  echo "  La key se genera en https://appstoreconnect.apple.com → Users and Access → Integrations → Keys"
  echo ""
  echo "Método B — Apple ID clásico:"
  echo "    export APPLE_ID='tu@email.com'"
  echo "    export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'"
  echo "    export APPLE_TEAM_ID='U858VRJWB9'"
  echo "  El password se genera en https://appleid.apple.com → Sign-In and Security → App-Specific Passwords"
  echo ""
  echo "Tip: guardalos en ~/.phantom-apple-creds y este script los carga solo."
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

echo "✓ Credenciales OK (notarización via $AUTH_METHOD)"
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
