'use strict';
// Reglas del inventario. Todas las funciones reciben el negocio de la sesión y filtran por él:
// un negocio nunca ve ni modifica datos de otro.
const { uno, todos, transaccion, esDuplicado } = require('./db');
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
    stockMinimo: p.stock_minimo, activo: p.activo, estado: estadoStock(p)
  };
}

// Con `bloquear`, la fila queda reservada hasta el fin de la transacción: dos ventas
// simultáneas del mismo producto se atienden una tras otra y el stock nunca queda negativo.
async function obtenerProducto(db, negocioId, id, bloquear) {
  const p = await uno(db, 'SELECT * FROM productos WHERE id = $1 AND negocio_id = $2' + (bloquear ? ' FOR UPDATE' : ''), [id, negocioId]);
  if (!p) { throw new ErrorApi(404, 'Ese producto no existe en este negocio.'); }
  return p;
}

async function listarProductos(db, negocioId, incluirInactivos) {
  return (await todos(db, 'SELECT * FROM productos WHERE negocio_id = $1 AND (activo OR $2) ORDER BY lower(nombre), id',
    [negocioId, Boolean(incluirInactivos)])).map(conEstado);
}

async function insertarMovimiento(db, datos) {
  const ahora = datos.ahora || new Date();
  return (await uno(db, 'INSERT INTO movimientos (negocio_id, producto_id, usuario_id, tipo, cantidad, precio_unitario, stock_resultante, origen, texto_original, fecha_local, creado_en) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
    [datos.negocioId, datos.productoId, datos.usuarioId, datos.tipo, datos.cantidad, datos.precio,
      datos.stockResultante, datos.origen, datos.texto || null, fechaLocal(ahora), ahora])).id;
}

function duplicado(e) {
  return esDuplicado(e) ? new ErrorApi(409, 'Ya existe un producto con ese nombre.') : e;
}

// El stock inicial se registra como una entrada para que el historial cuadre con el stock.
async function crearProducto(db, negocioId, usuarioId, datos) {
  const nombre = nombreProducto(datos.nombre);
  const precio = entero(datos.precio, 'El precio', 0, MAX_PRECIO);
  const stock = entero(datos.stock === undefined ? 0 : datos.stock, 'El stock inicial', 0, MAX_CANTIDAD);
  const minimo = entero(datos.stockMinimo === undefined ? 0 : datos.stockMinimo, 'El stock mínimo', 0, MAX_CANTIDAD);
  try {
    return await transaccion(db, async function (t) {
      const id = (await uno(t, 'INSERT INTO productos (negocio_id, nombre, precio, stock, stock_minimo) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [negocioId, nombre, precio, stock, minimo])).id;
      if (stock > 0) {
        await insertarMovimiento(t, { negocioId, productoId: id, usuarioId, tipo: 'entrada', cantidad: stock, precio, stockResultante: stock, origen: 'inicial', texto: 'Stock inicial', ahora: datos.ahora });
      }
      return conEstado(await obtenerProducto(t, negocioId, id));
    });
  } catch (e) { throw duplicado(e); }
}

// Edita datos descriptivos. El stock no se edita aquí: solo cambia con movimientos.
async function actualizarProducto(db, negocioId, id, datos) {
  const p = await obtenerProducto(db, negocioId, id);
  const nombre = datos.nombre === undefined ? p.nombre : nombreProducto(datos.nombre);
  const precio = datos.precio === undefined ? p.precio : entero(datos.precio, 'El precio', 0, MAX_PRECIO);
  const minimo = datos.stockMinimo === undefined ? p.stock_minimo : entero(datos.stockMinimo, 'El stock mínimo', 0, MAX_CANTIDAD);
  const activo = datos.activo === undefined ? p.activo : Boolean(datos.activo);
  try {
    await db.query('UPDATE productos SET nombre = $1, precio = $2, stock_minimo = $3, activo = $4 WHERE id = $5 AND negocio_id = $6',
      [nombre, precio, minimo, activo, id, negocioId]);
  } catch (e) { throw duplicado(e); }
  return conEstado(await obtenerProducto(db, negocioId, id));
}

async function registrarMovimiento(db, negocioId, usuarioId, datos) {
  const productoId = entero(datos.productoId, 'El producto', 1, 2147483647);
  const cantidad = entero(datos.cantidad, 'La cantidad', 1, MAX_CANTIDAD);
  if (TIPOS.indexOf(datos.tipo) === -1) { throw new ErrorApi(400, 'El tipo debe ser venta, entrada o merma.'); }
  const origen = ORIGENES.indexOf(datos.origen) === -1 ? 'manual' : datos.origen;
  const texto = typeof datos.textoOriginal === 'string' ? datos.textoOriginal.trim().slice(0, 300) : null;

  return transaccion(db, async function (t) {
    const p = await obtenerProducto(t, negocioId, productoId, true);
    if (!p.activo) { throw new ErrorApi(409, p.nombre + ' está desactivado. Actívalo en Inventario para registrar movimientos.'); }
    const signo = datos.tipo === 'entrada' ? 1 : -1;
    const nuevo = p.stock + signo * cantidad;
    if (nuevo < 0) {
      throw new ErrorApi(409, 'Stock insuficiente: solo quedan ' + p.stock + ' unidades de ' + p.nombre + ' y se intentó descontar ' + cantidad + '.');
    }
    if (nuevo > MAX_CANTIDAD) { throw new ErrorApi(400, 'El stock no puede superar ' + MAX_CANTIDAD.toLocaleString('es-CO') + ' unidades.'); }
    await t.query('UPDATE productos SET stock = $1 WHERE id = $2 AND negocio_id = $3', [nuevo, p.id, negocioId]);
    const id = await insertarMovimiento(t, { negocioId, productoId: p.id, usuarioId, tipo: datos.tipo, cantidad, precio: p.precio, stockResultante: nuevo, origen, texto, ahora: datos.ahora });
    return { id: id, tipo: datos.tipo, cantidad: cantidad, stockAnterior: p.stock, producto: conEstado(Object.assign({}, p, { stock: nuevo })) };
  });
}

function listarMovimientos(db, negocioId, filtro) {
  const tipo = TIPOS.indexOf(filtro.tipo) === -1 ? null : filtro.tipo;
  const limite = Math.min(Math.max(Number(filtro.limite) || 100, 1), 500);
  return todos(db, 'SELECT m.id, m.tipo, m.cantidad, m.precio_unitario AS "precioUnitario", m.stock_resultante AS "stockResultante", m.origen, m.texto_original AS "textoOriginal", m.creado_en AS "creadoEn", p.nombre AS producto, u.nombre AS usuario FROM movimientos m JOIN productos p ON p.id = m.producto_id LEFT JOIN usuarios u ON u.id = m.usuario_id WHERE m.negocio_id = $1 AND ($2::text IS NULL OR m.tipo = $2) ORDER BY m.creado_en DESC, m.id DESC LIMIT $3',
    [negocioId, tipo, limite]);
}

// Las sumas se hacen en bigint: cantidad × precio puede pasar del límite de integer (2.147 millones).
async function panel(db, negocioId, ahora) {
  const hoy = fechaLocal(ahora);
  const desde = diasAtras(ahora, 6);
  const productos = await listarProductos(db, negocioId, false);
  const porDia = await todos(db, "SELECT fecha_local AS fecha, SUM(cantidad::bigint * precio_unitario)::bigint AS total FROM movimientos WHERE negocio_id = $1 AND tipo = 'venta' AND fecha_local >= $2 GROUP BY fecha_local",
    [negocioId, desde]);
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
    recientes: await listarMovimientos(db, negocioId, { limite: 8 })
  };
}

async function reporte(db, negocioId, ahora, dias) {
  const periodo = dias === 30 ? 30 : 7;
  const desde = diasAtras(ahora, periodo - 1);
  const totales = await todos(db, "SELECT tipo, SUM(cantidad)::bigint AS unidades, SUM(cantidad::bigint * precio_unitario)::bigint AS valor FROM movimientos WHERE negocio_id = $1 AND fecha_local >= $2 AND origen <> 'inicial' GROUP BY tipo",
    [negocioId, desde]);
  const top = function (tipo) {
    return todos(db, 'SELECT p.nombre, SUM(m.cantidad)::bigint AS unidades, SUM(m.cantidad::bigint * m.precio_unitario)::bigint AS valor FROM movimientos m JOIN productos p ON p.id = m.producto_id WHERE m.negocio_id = $1 AND m.tipo = $2 AND m.fecha_local >= $3 GROUP BY p.id ORDER BY unidades DESC, lower(p.nombre) LIMIT 5',
      [negocioId, tipo, desde]);
  };
  const de = function (tipo) {
    return totales.find(function (t) { return t.tipo === tipo; }) || { unidades: 0, valor: 0 };
  };
  return {
    dias: periodo, desde: desde, hasta: fechaLocal(ahora),
    vendido: de('venta'), entradas: de('entrada'), mermas: de('merma'),
    topVendidos: await top('venta'), topMermas: await top('merma')
  };
}

module.exports = {
  fechaLocal, MAX_CANTIDAD, listarProductos, crearProducto, actualizarProducto, registrarMovimiento,
  listarMovimientos, panel, reporte
};
