/**
 * after-sign.js — Notarización con Apple después de firmar.
 *
 * Soporta DOS métodos de autenticación con Apple Notary Service:
 *
 *   Método A — API Key (RECOMENDADO, sin 2FA):
 *     APPLE_API_KEY_PATH    (ruta al .p8 descargado de App Store Connect)
 *     APPLE_API_KEY_ID      (Key ID, ej: ABC123DEF4)
 *     APPLE_API_ISSUER_ID   (Issuer ID, UUID largo)
 *
 *   Método B — Apple ID + Password (clásico, requiere 2FA):
 *     APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 *
 * Para SKIPEAR la notarización (build local de testing): SKIP_NOTARIZE=true
 */

const { execSync } = require('child_process');
const path = require('path');

module.exports = async function afterSign(context) {
  if (process.platform !== 'darwin') return;
  if (process.env.SKIP_NOTARIZE === 'true') {
    console.log('⏭️  [after-sign] SKIP_NOTARIZE=true → salteando notarización.');
    return;
  }

  const useApiKey = process.env.APPLE_API_KEY_PATH && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER_ID;
  const usePassword = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;

  if (!useApiKey && !usePassword) {
    console.warn('⚠  [after-sign] Sin credenciales para notarizar — salteando.');
    console.warn('   Configurá API Key (APPLE_API_KEY_PATH / _ID / _ISSUER_ID)');
    console.warn('   o Apple ID (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID).');
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log(`\n📤 [after-sign] Notarizando ${path.basename(appPath)} via ${useApiKey ? 'API Key' : 'Apple ID + Password'}…`);
  console.log(`   (esto tarda 1-5 minutos)\n`);

  try {
    // 1) Comprimir la .app a un .zip (notarytool requiere zip/dmg/pkg)
    const zipPath = appPath + '.zip';
    execSync(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${zipPath}"`, { stdio: 'inherit' });

    // 2) Submit a Apple
    let cmd;
    if (useApiKey) {
      cmd = `xcrun notarytool submit "${zipPath}" --key "${process.env.APPLE_API_KEY_PATH}" --key-id "${process.env.APPLE_API_KEY_ID}" --issuer "${process.env.APPLE_API_ISSUER_ID}" --wait --timeout 20m`;
    } else {
      cmd = `xcrun notarytool submit "${zipPath}" --apple-id "${process.env.APPLE_ID}" --team-id "${process.env.APPLE_TEAM_ID}" --password "${process.env.APPLE_APP_SPECIFIC_PASSWORD}" --wait --timeout 20m`;
    }
    execSync(cmd, { stdio: 'inherit' });

    // 3) Staple el sello a la .app
    execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });

    // 4) Cleanup zip
    execSync(`rm -f "${zipPath}"`);

    console.log('✅ [after-sign] Notarización OK + sello adjunto.\n');
  } catch (e) {
    console.error('❌ [after-sign] Notarización falló:', e.message.split('\n').slice(0, 3).join(' | '));
    throw e;
  }
};
