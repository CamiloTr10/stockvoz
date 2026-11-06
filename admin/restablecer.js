'use strict';
// Genera un código para cambiar la contraseña de una cuenta. Es para quien administra el
// servidor: StockVoz no manda correos, y un dueño que olvida su clave no tiene a nadie por
// encima en su negocio que se la pueda cambiar.
//   npm run restablecer -- correo@ejemplo.com
// Necesita la misma DATABASE_URL que el servidor. El código sirve una vez y vence en 24 horas.
require('../src/entorno');
const db = require('../src/db');
const auth = require('../src/auth');

async function main() {
  const correo = process.argv[2];
  if (!correo) { console.error('Uso: npm run restablecer -- correo@ejemplo.com'); process.exit(1); }
  const base = await db.abrir(process.env.DATABASE_URL);
  try {
    const r = await auth.restablecerPorCorreo(base, correo);
    const vence = new Date(r.expiraEn).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    console.log('\nCódigo para ' + r.nombre + ': ' + r.codigo + '\nVence: ' + vence + '\n\n' +
      'Pásaselo en persona o por WhatsApp. Con él entra a «¿Olvidaste tu contraseña?», en la\n' +
      'pantalla de ingreso, y pone una nueva. Las sesiones que tenga abiertas se cierran.\n');
  } finally {
    await base.end();
  }
}

main().catch(function (e) { console.error('No se pudo generar el código: ' + e.message); process.exit(1); });
