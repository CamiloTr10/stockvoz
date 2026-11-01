'use strict';
// Datos de demostración para presentar el prototipo. Solo se cargan si la base está vacía.
// Cuentas de prueba (solo para desarrollo local):
//   demo@stockvoz.test      / demo12345  → dueña de dos negocios
//   encargado@stockvoz.test / demo12345  → encargado de la tienda (no puede editar productos)
const { hashClave } = require('./auth');
const { crearProducto, registrarMovimiento } = require('./inventario');

const CLAVE_DEMO = 'demo12345';

const TIENDA = [
  // nombre, precio (COP), stock inicial, mínimo
  ['Gaseosa 1,5 L', 6500, 40, 10], ['Gaseosa 400 ml', 2800, 48, 12], ['Pan tajado', 5800, 30, 8],
  ['Huevos (u)', 600, 90, 30], ['Arroz 500 g', 2900, 60, 15], ['Leche 1 L', 4500, 30, 10],
  ['Café 500 g', 14000, 15, 5], ['Aceite 1 L', 11500, 12, 4]
];
const PAPELERIA = [
  ['Cuaderno 100 hojas', 6000, 35, 10], ['Lápiz HB', 1200, 80, 20], ['Borrador', 800, 50, 15],
  ['Resma carta', 22000, 6, 3]
];

function usuario(db, nombre, correo) {
  return Number(db.prepare('INSERT INTO usuarios (nombre, correo, clave_hash, creado_en) VALUES (?, ?, ?, ?)')
    .run(nombre, correo, hashClave(CLAVE_DEMO), new Date().toISOString()).lastInsertRowid);
}

function negocio(db, nombre, miembros, productos, ahora) {
  const id = Number(db.prepare('INSERT INTO negocios (nombre, creado_en) VALUES (?, ?)').run(nombre, new Date().toISOString()).lastInsertRowid);
  miembros.forEach(function (m) { db.prepare('INSERT INTO membresias (usuario_id, negocio_id, rol) VALUES (?, ?, ?)').run(m[0], id, m[1]); });
  const haceUnaSemana = new Date(ahora.getTime() - 7 * 86400000);
  const ids = productos.map(function (p) {
    return crearProducto(db, id, miembros[0][0], { nombre: p[0], precio: p[1], stock: p[2], stockMinimo: p[3], ahora: haceUnaSemana }).id;
  });
  return { id: id, productos: ids };
}

// Una semana de movimientos con cantidades fijas (deterministas) para que el panel y los
// reportes tengan algo que mostrar.
function historial(db, n, usuarioId, ahora) {
  const ventas = [[0, 3], [2, 2], [3, 6], [4, 4], [1, 4], [5, 2], [3, 5], [0, 4], [2, 3]];
  for (let dia = 6; dia >= 0; dia--) {
    const fecha = new Date(ahora.getTime() - dia * 86400000);
    ventas.slice(0, 4 + (dia % 4)).forEach(function (v, i) {
      registrarMovimiento(db, n.id, usuarioId, { productoId: n.productos[v[0]], tipo: 'venta', cantidad: v[1] + (dia % 3), origen: i % 2 ? 'voz' : 'texto', ahora: fecha });
    });
    if (dia % 3 === 0) {
      registrarMovimiento(db, n.id, usuarioId, { productoId: n.productos[3], tipo: 'merma', cantidad: 2 + dia, origen: 'voz', textoOriginal: 'se dañaron ' + (2 + dia) + ' huevos', ahora: fecha });
    }
  }
  // Deja dos productos en alerta, como en los wireframes.
  registrarMovimiento(db, n.id, usuarioId, { productoId: n.productos[0], tipo: 'venta', cantidad: 4, origen: 'voz', textoOriginal: 'vendí 4 gaseosas de litro y medio', ahora: ahora });
  registrarMovimiento(db, n.id, usuarioId, { productoId: n.productos[2], tipo: 'merma', cantidad: 6, origen: 'texto', textoOriginal: 'se vencieron 6 panes', ahora: ahora });
}

function sembrarSiVacia(db, ahora) {
  if (db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0) { return false; }
  const fecha = ahora || new Date();
  const duena = usuario(db, 'Usuaria demo', 'demo@stockvoz.test');
  const encargado = usuario(db, 'Encargado demo', 'encargado@stockvoz.test');
  const tienda = negocio(db, 'Tienda La Esquina (demo)', [[duena, 'dueno'], [encargado, 'encargado']], TIENDA, fecha);
  negocio(db, 'Papelería Central (demo)', [[duena, 'dueno']], PAPELERIA, fecha);
  historial(db, tienda, duena, fecha);
  return true;
}

module.exports = { sembrarSiVacia, CLAVE_DEMO };
