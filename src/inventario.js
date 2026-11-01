'use strict';
// Reglas del inventario. Todas las funciones reciben el negocio de la sesión y filtran por él:
// un negocio nunca ve ni modifica datos de otro.
const { transaccion } = require('./db');
const { ErrorApi } = require('./errores');

const TIPOS = ['venta', 'entrada', 'merma'];
const ORIGENES = ['voz', 'texto', 'manual'];
const MAX_CANTIDAD = 100000;
const MAX_PRECIO = 100000000;
const ZONA = 'America/Bogota';

// Fecha del calendario en Colombia ("2026-10-31"), base de "hoy" y de los reportes por día.
function fechaLocal(fecha) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
}

function diasAtras(ahora, n) {
  return fechaLocal(new Date(ahora.getTime() - n * 86400000));
}

function entero(valor, campo, min, max) {
  const n = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ErrorApi(400, campo + ' debe ser un número entero entre ' + min + ' y ' + max.toLocaleString('es-CO') + '.');
  }
  return n;
}

function nombreProducto(valor) {
  const v = typeof valor === 'string' ? valor.trim().replace(/\s+/g, ' ') : '';
  if (v.length < 2 || v.length > 80) { throw new ErrorApi(400, 'El nombre del producto debe tener entre 2 y 80 caracteres.'); }
  return v;
}

function estadoStock(p) {
  if (p.stock === 0) { return 'agotado'; }
  return p.stock <= p.stock_minimo ? 'bajo' : 'ok';
}

function conEstado(p) {
  return {
    id: p.id, nombre: p.nombre, precio: p.precio, stock: p.stock,
    stockMinimo: p.stock_minimo, activo: Boolean(p.activo), estado: estadoStock(p)
  };
}

function obtenerProducto(db, negocioId, id) {
  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND negocio_id = ?').get(id, negocioId);
  if (!p) { throw new ErrorApi(404, 'Ese producto no existe en este negocio.'); }
  return p;
}

function listarProductos(db, negocioId, incluirInactivos) {
  return db.prepare('SELECT * FROM productos WHERE negocio_id = ? AND (activo = 1 OR ?) ORDER BY nombre')
    .all(negocioId, incluirInactivos ? 1 : 0).map(conEstado);
}

function insertarMovimiento(db, datos) {
  const ahora = datos.ahora || new Date();
  return Number(db.prepare('INSERT INTO movimientos (negocio_id, producto_id, usuario_id, tipo, cantidad, precio_unitario, stock_resultante, origen, texto_original, fecha_local, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(datos.negocioId, datos.productoId, datos.usuarioId, datos.tipo, datos.cantidad, datos.precio,
      datos.stockResultante, datos.origen, datos.texto || null, fechaLocal(ahora), ahora.toISOString()).lastInsertRowid);
}

function duplicado(e) {
  return /UNIQUE/.test(e.message) ? new ErrorApi(409, 'Ya existe un producto con ese nombre.') : e;
}

// El stock inicial se registra como una entrada para que el historial cuadre con el stock.
function crearProducto(db, negocioId, usuarioId, datos) {
  const nombre = nombreProducto(datos.nombre);
  const precio = entero(datos.precio, 'El precio', 0, MAX_PRECIO);
  const stock = entero(datos.stock === undefined ? 0 : datos.stock, 'El stock inicial', 0, MAX_CANTIDAD);
  const minimo = entero(datos.stockMinimo === undefined ? 0 : datos.stockMinimo, 'El stock mínimo', 0, MAX_CANTIDAD);
  try {
    return transaccion(db, function () {
      const id = Number(db.prepare('INSERT INTO productos (negocio_id, nombre, precio, stock, stock_minimo) VALUES (?, ?, ?, ?, ?)')
        .run(negocioId, nombre, precio, stock, minimo).lastInsertRowid);
      if (stock > 0) {
        insertarMovimiento(db, { negocioId, productoId: id, usuarioId, tipo: 'entrada', cantidad: stock, precio, stockResultante: stock, origen: 'inicial', texto: 'Stock inicial', ahora: datos.ahora });
      }
      return conEstado(obtenerProducto(db, negocioId, id));
    });
  } catch (e) { throw duplicado(e); }
}

// Edita datos descriptivos. El stock no se edita aquí: solo cambia con movimientos.
function actualizarProducto(db, negocioId, id, datos) {
  const p = obtenerProducto(db, negocioId, id);
  const nombre = datos.nombre === undefined ? p.nombre : nombreProducto(datos.nombre);
  const precio = datos.precio === undefined ? p.precio : entero(datos.precio, 'El precio', 0, MAX_PRECIO);
  const minimo = datos.stockMinimo === undefined ? p.stock_minimo : entero(datos.stockMinimo, 'El stock mínimo', 0, MAX_CANTIDAD);
  const activo = datos.activo === undefined ? p.activo : (datos.activo ? 1 : 0);
  try {
    db.prepare('UPDATE productos SET nombre = ?, precio = ?, stock_minimo = ?, activo = ? WHERE id = ? AND negocio_id = ?')
      .run(nombre, precio, minimo, activo, id, negocioId);
  } catch (e) { throw duplicado(e); }
  return conEstado(obtenerProducto(db, negocioId, id));
}

function registrarMovimiento(db, negocioId, usuarioId, datos) {
  const productoId = entero(datos.productoId, 'El producto', 1, Number.MAX_SAFE_INTEGER);
  const cantidad = entero(datos.cantidad, 'La cantidad', 1, MAX_CANTIDAD);
  if (TIPOS.indexOf(datos.tipo) === -1) { throw new ErrorApi(400, 'El tipo debe ser venta, entrada o merma.'); }
  const origen = ORIGENES.indexOf(datos.origen) === -1 ? 'manual' : datos.origen;
  const texto = typeof datos.textoOriginal === 'string' ? datos.textoOriginal.trim().slice(0, 300) : null;

  return transaccion(db, function () {
    const p = obtenerProducto(db, negocioId, productoId);
    if (!p.activo) { throw new ErrorApi(409, p.nombre + ' está desactivado. Actívalo en Inventario para registrar movimientos.'); }
    const signo = datos.tipo === 'entrada' ? 1 : -1;
    const nuevo = p.stock + signo * cantidad;
    if (nuevo < 0) {
      throw new ErrorApi(409, 'Stock insuficiente: solo quedan ' + p.stock + ' unidades de ' + p.nombre + ' y se intentó descontar ' + cantidad + '.');
    }
    if (nuevo > MAX_CANTIDAD) { throw new ErrorApi(400, 'El stock no puede superar ' + MAX_CANTIDAD.toLocaleString('es-CO') + ' unidades.'); }
    db.prepare('UPDATE productos SET stock = ? WHERE id = ? AND negocio_id = ?').run(nuevo, p.id, negocioId);
    const id = insertarMovimiento(db, { negocioId, productoId: p.id, usuarioId, tipo: datos.tipo, cantidad, precio: p.precio, stockResultante: nuevo, origen, texto, ahora: datos.ahora });
    return { id: id, tipo: datos.tipo, cantidad: cantidad, stockAnterior: p.stock, producto: conEstado(Object.assign({}, p, { stock: nuevo })) };
  });
}

function listarMovimientos(db, negocioId, filtro) {
  const tipo = TIPOS.indexOf(filtro.tipo) === -1 ? null : filtro.tipo;
  const limite = Math.min(Math.max(Number(filtro.limite) || 100, 1), 500);
  return db.prepare('SELECT m.id, m.tipo, m.cantidad, m.precio_unitario AS precioUnitario, m.stock_resultante AS stockResultante, m.origen, m.texto_original AS textoOriginal, m.creado_en AS creadoEn, p.nombre AS producto, u.nombre AS usuario FROM movimientos m JOIN productos p ON p.id = m.producto_id LEFT JOIN usuarios u ON u.id = m.usuario_id WHERE m.negocio_id = ? AND (? IS NULL OR m.tipo = ?) ORDER BY m.creado_en DESC, m.id DESC LIMIT ?')
    .all(negocioId, tipo, tipo, limite);
}

function panel(db, negocioId, ahora) {
  const hoy = fechaLocal(ahora);
  const desde = diasAtras(ahora, 6);
  const productos = listarProductos(db, negocioId, false);
  const porDia = db.prepare("SELECT fecha_local AS fecha, SUM(cantidad * precio_unitario) AS total FROM movimientos WHERE negocio_id = ? AND tipo = 'venta' AND fecha_local >= ? GROUP BY fecha_local")
    .all(negocioId, desde);
  const ventas7 = [];
  for (let i = 6; i >= 0; i--) {
    const fecha = diasAtras(ahora, i);
    const fila = porDia.find(function (f) { return f.fecha === fecha; });
    ventas7.push({ fecha: fecha, total: fila ? fila.total : 0 });
  }
  return {
    hoy: hoy,
    productosActivos: productos.length,
    ventasHoy: ventas7[6].total,
    alertas: productos.filter(function (p) { return p.estado !== 'ok'; }),
    ventas7: ventas7,
    recientes: listarMovimientos(db, negocioId, { limite: 8 })
  };
}

function reporte(db, negocioId, ahora, dias) {
  const periodo = dias === 30 ? 30 : 7;
  const desde = diasAtras(ahora, periodo - 1);
  const totales = db.prepare("SELECT tipo, SUM(cantidad) AS unidades, SUM(cantidad * precio_unitario) AS valor FROM movimientos WHERE negocio_id = ? AND fecha_local >= ? AND origen <> 'inicial' GROUP BY tipo")
    .all(negocioId, desde);
  const top = function (tipo) {
    return db.prepare('SELECT p.nombre, SUM(m.cantidad) AS unidades, SUM(m.cantidad * m.precio_unitario) AS valor FROM movimientos m JOIN productos p ON p.id = m.producto_id WHERE m.negocio_id = ? AND m.tipo = ? AND m.fecha_local >= ? GROUP BY p.id ORDER BY unidades DESC, p.nombre LIMIT 5')
      .all(negocioId, tipo, desde);
  };
  const de = function (tipo) {
    return totales.find(function (t) { return t.tipo === tipo; }) || { unidades: 0, valor: 0 };
  };
  return {
    dias: periodo, desde: desde, hasta: fechaLocal(ahora),
    vendido: de('venta'), entradas: de('entrada'), mermas: de('merma'),
    topVendidos: top('venta'), topMermas: top('merma')
  };
}

module.exports = {
  fechaLocal, listarProductos, crearProducto, actualizarProducto, registrarMovimiento,
  listarMovimientos, panel, reporte
};
