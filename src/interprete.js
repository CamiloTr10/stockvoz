'use strict';
// Convierte una instrucción en español ("Vendí 3 gaseosas") en una operación propuesta.
// No guarda nada: el usuario confirma y el backend valida antes de registrar.
// Es un intérprete por reglas; la integración con IA (n8n + modelo de lenguaje) puede
// reemplazarlo siempre que devuelva el mismo formato de resultado.

const NUMEROS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, par: 2
};

// Unidades que forman parte del nombre del producto ("Arroz 500 g"), no de la cantidad.
const UNIDADES = /^(g|gr|grs|gramos?|kg|kilos?|l|lt|lts|litros?|ml|cc|oz)$/;

// Verbos por tipo. Son formas concretas (no prefijos sueltos) para no confundir
// productos como "botella", "ventana" o "Danone" con un verbo.
const MOVIMIENTOS = [
  ['venta', /\b(vend(i|io|imos|ieron|ido|idos|ida|idas|o|e|emos|en)|ventas?|despach(e|o|amos|aron)|compraron|compro|me compr\w*|nos compr\w*|se llev(o|aron))\b/],
  ['merma', /\b(dan(o|aron|ado|ados|ada|adas)|mermas?|venc(io|ieron|ido|idos|ida|idas)|perd(i|io|imos|ieron|ido|idos|ida|idas)|romp(io|ieron|i|imos)|rot[oa]s?|bot(e|o|amos|aron)|malogr\w*|caduc\w*|podri\w*)\b/],
  ['entrada', /\b(entr(o|aron|ada|adas|an|amos)|lleg(o|aron|ada|adas|an)|recib(i|io|imos|ieron)|ingres(e|o|amos|aron)|surt(i|imos|io|ieron)|compre|compramos|agreg(ue|amos|o|aron)|repus(e|o|imos|ieron)|abastec\w*)\b/]
];
const CONSULTA = /\b(cuant[oa]s?|queda\w*|hay|tengo|tenemos|stock|existencias?)\b/;

const VACIAS = new Set(('de del la el los las un una unos unas unidad unidades uds und u se me nos le les ' +
  'y a al por para con hoy mas que en mi cliente clientes paquete paquetes cajas caja docena docenas ' +
  'media par ya acaba acabo acabamos acaban o cuanto cuantos cuanta cuantas queda quedan hay tengo tenemos ' +
  'stock existencia existencias').split(' '));

function normalizar(texto) {
  return String(texto).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/(\d),(\d)/g, '$1.$2')           // 1,5 → 1.5
    .replace(/[^a-z0-9.ñ]+/g, ' ')
    .replace(/\.(?!\d)|(?<!\d)\./g, ' ')       // puntos que no son decimales
    .trim();
}

function tokens(texto) {
  return normalizar(texto).split(/\s+/).filter(Boolean);
}

// "panes" ~ "pan", "leches" ~ "leche", "gaseosas" ~ "gaseosa", "arroces" ~ "arroz"
function equivalen(a, b) {
  return a === b || a === b + 's' || a === b + 'es' || b === a + 's' || b === a + 'es' ||
    (/z$/.test(b) && a === b.slice(0, -1) + 'ces') || (/z$/.test(a) && b === a.slice(0, -1) + 'ces');
}

// Si hay varios verbos de movimiento gana el primero de la frase; la consulta
// ("¿cuánto queda?") solo aplica cuando no hay ninguno.
function detectarTipo(normal) {
  let mejor = null;
  MOVIMIENTOS.forEach(function (par) {
    const m = par[1].exec(normal);
    if (m && (mejor === null || m.index < mejor.indice)) {
      mejor = { tipo: par[0], indice: m.index, palabras: m[0].split(' ') };
    }
  });
  if (mejor) { return mejor; }
  const c = CONSULTA.exec(normal);
  return c ? { tipo: 'consulta', indice: c.index, palabras: c[0].split(' ') } : null;
}

// Devuelve { cantidad, posiciones } con las posiciones de tokens usados para la cantidad.
function detectarCantidad(toks) {
  // Primero los dígitos: "le vendí a un señor 3 gaseosas" es 3, no 1.
  for (let i = 0; i < toks.length; i++) {
    if (/^\d+$/.test(toks[i]) && !UNIDADES.test(toks[i + 1] || '')) {
      return { cantidad: Number(toks[i]), posiciones: [i] };
    }
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'media' && /^docenas?$/.test(toks[i + 1] || '')) { return { cantidad: 6, posiciones: [i, i + 1] }; }
    if (/^docenas?$/.test(t)) { return { cantidad: 12, posiciones: [i] }; }
    if (t in NUMEROS) {
      let valor = NUMEROS[t];
      const usados = [i];
      // "treinta y cinco"
      if (valor >= 30 && valor < 100 && toks[i + 1] === 'y' && NUMEROS[toks[i + 2]] < 10) {
        valor += NUMEROS[toks[i + 2]];
        usados.push(i + 1, i + 2);
      }
      const siguiente = toks[usados[usados.length - 1] + 1];
      if (/^docenas?$/.test(siguiente || '')) { valor *= 12; usados.push(usados[usados.length - 1] + 1); }
      return { cantidad: valor, posiciones: usados };
    }
  }
  return { cantidad: null, posiciones: [] };
}

function tokensProducto(nombre) {
  return tokens(nombre).filter(function (t) { return !VACIAS.has(t); });
}

// Puntaje: proporción de palabras del producto presentes + bonificación si coincide la primera
// (el sustantivo: "gaseosa" en "Gaseosa 1,5 L").
function puntuar(producto, palabras) {
  const propias = tokensProducto(producto.nombre);
  if (propias.length === 0) { return 0; }
  const coinciden = propias.filter(function (p) {
    return palabras.some(function (w) { return equivalen(w, p); });
  });
  if (coinciden.length === 0) { return 0; }
  return coinciden.length / propias.length + (coinciden.indexOf(propias[0]) === 0 ? 1 : 0);
}

/**
 * @param {string} texto  instrucción del usuario
 * @param {{id:number,nombre:string}[]} catalogo  productos activos del negocio
 * @returns {{estado:string,tipo:?string,cantidad:?number,producto:?object,candidatos:object[],busqueda:string,texto:string}}
 *   estado: ok | consulta | ambiguo | sin_producto | sin_cantidad | no_entendido
 */
function interpretarUna(texto, catalogo) {
  const resultado = { estado: 'no_entendido', tipo: null, cantidad: null, producto: null, candidatos: [], busqueda: '' };
  const normal = normalizar(texto);
  if (!normal) { return resultado; }

  const toks = normal.split(' ');
  const tipo = detectarTipo(normal);
  const cant = tipo && tipo.tipo !== 'consulta' ? detectarCantidad(toks) : { cantidad: null, posiciones: [] };

  // Palabras que describen el producto: sin verbo, sin cantidad y sin palabras vacías.
  const palabras = toks.filter(function (t, i) {
    return cant.posiciones.indexOf(i) === -1 && !VACIAS.has(t) && !(tipo && tipo.palabras.indexOf(t) !== -1) && !(t in NUMEROS);
  });
  resultado.busqueda = palabras.join(' ');

  if (!tipo) { return resultado; }
  resultado.tipo = tipo.tipo;
  resultado.cantidad = cant.cantidad;

  const puntuados = catalogo
    .map(function (p) { return { producto: p, puntaje: puntuar(p, palabras) }; })
    .filter(function (x) { return x.puntaje > 0; })
    .sort(function (a, b) { return b.puntaje - a.puntaje; });

  if (puntuados.length === 0) {
    resultado.estado = 'sin_producto';
    return resultado;
  }
  const empatados = puntuados.filter(function (x) { return x.puntaje === puntuados[0].puntaje; });
  if (empatados.length > 1) {
    resultado.estado = 'ambiguo';
    resultado.candidatos = empatados.map(function (x) { return x.producto; });
    return resultado;
  }
  resultado.producto = puntuados[0].producto;

  if (tipo.tipo === 'consulta') { resultado.estado = 'consulta'; return resultado; }
  resultado.estado = cant.cantidad > 0 ? 'ok' : 'sin_cantidad';
  return resultado;
}


// Una frase de mostrador no dice más de cinco cosas.
const MAX_OPERACIONES = 5;

// Conectores por los que puede venir más de una operación.
const CONECTORES = /([ ]+y[ ]+|[ ]+e[ ]+|[ ]*;[ ]*|[ ]*,[ ]*)/;

// Parte la frase y vuelve a pegar los pedazos que no traen verbo de movimiento, con su
// separador. Así "treinta y cinco borradores" no se parte (el pedazo "cinco borradores" no
// tiene verbo) y "1,5" sigue siendo un número.
// shortcut: si el tendero omite el verbo ("vendí 2 borradores y 3 lápices") queda una sola
// operación; el modelo sí la separa. Juntar de más es preferible a separar mal, porque separar
// mal inventaría operaciones que el tendero no dijo. Si hiciera falta, habría que heredar el
// verbo del pedazo anterior sin confundirlo con los números compuestos.
function partir(texto) {
  const trozos = String(texto).split(CONECTORES);
  // Cada parte guarda el separador que la sigue, para poder volver a pegarla tal cual.
  const partes = [{ texto: trozos[0] || '', sep: '' }];
  for (let i = 1; i < trozos.length; i += 2) {
    const pieza = trozos[i + 1] || '';
    const ultima = partes[partes.length - 1];
    if (detectarTipo(normalizar(pieza))) {
      ultima.sep = trozos[i];
      partes.push({ texto: pieza, sep: '' });
    } else {
      ultima.texto += trozos[i] + pieza;
    }
  }
  // Un primer pedazo sin verbo nombra el producto del que habla el verbo que viene después
  // ("quedé sin arroz, vendí los últimos 5"): se pega al siguiente en vez de perderse.
  if (partes.length > 1 && !detectarTipo(normalizar(partes[0].texto))) {
    partes[1].texto = partes[0].texto + partes[0].sep + partes[1].texto;
    partes.shift();
  }
  return partes
    .map(function (p) { return p.texto; })
    .filter(function (p) { return normalizar(p); });
}

/**
 * Interpreta una instrucción, que puede traer varias operaciones.
 * @param {string} texto  instrucción del usuario
 * @param {{id:number,nombre:string}[]} catalogo  productos activos del negocio
 * @returns {{operaciones:object[],texto:string}}  lista vacía si no se entendió nada
 */
function interpretar(texto, catalogo) {
  const limpio = String(texto || '').trim();
  const operaciones = partir(limpio)
    .map(function (p) { return interpretarUna(p, catalogo); })
    .filter(function (o) { return o.estado !== 'no_entendido'; })
    .slice(0, MAX_OPERACIONES);
  return { operaciones: operaciones, texto: limpio };
}

module.exports = { interpretar, interpretarUna, normalizar, MAX_OPERACIONES };
