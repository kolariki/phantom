/**
 * after-pack.js — limpia atributos extendidos antes del codesign.
 *
 * NO firma nada — eso lo hace electron-builder con tu cert "Developer ID Application".
 * Solo limpia `xattr` que pueden romper la firma.
 */

const { execSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  try {
    execSync(`xattr -cr "${appPath}"`, { stdio: 'pipe' });
    console.log(`✓ [after-pack] xattr limpiado en ${path.basename(appPath)}`);
  } catch (e) {
    console.warn('⚠ [after-pack] xattr falló:', e.message.split('\n')[0]);
  }
};
