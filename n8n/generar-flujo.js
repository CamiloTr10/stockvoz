'use strict';
// Genera n8n/flujo-stockvoz.json a partir de src/ia-instrucciones.js.
//
// El flujo NO lleva las instrucciones escritas a mano: se las pide a cuerpoPeticion() con dos
// marcadores y el nodo Code los reemplaza por el catálogo y la frase de cada petición. Así el
// modo directo y el flujo de n8n le mandan exactamente lo mismo al modelo, y para ponerlos de
// acuerdo otra vez basta con volver a correr `npm run flujo`.
//
// Los secretos no entran al archivo: el flujo los lee del entorno del contenedor
// ($env.N8N_SECRETO y $env.IA_CLAVE), que compose.yml saca del .env.

const fs = require('node:fs');
const path = require('node:path');
const ia = require('../src/ia-instrucciones');

const MARCA_CATALOGO = '0 = __CATALOGO__';
// El salto de línea se inyecta así, y no escrito a mano, para no pelear con los escapes.
const SALTO = JSON.stringify(String.fromCharCode(10));

// El cuerpo real, con el formato real, y dos huecos que el nodo Code rellena.
const plantilla = ia.cuerpoPeticion({
  texto: '',
  catalogo: [{ id: 0, nombre: '__CATALOGO__' }],
  esfuerzo: 'low'   // medido: misma precisión que sin esfuerzo y ~3 veces menos tokens de salida
});

const armar = [
  "// Toma la frase y el catálogo del webhook y arma el cuerpo para el proveedor.",
  "const e = $('Webhook').first().json.body || {};",
  "const texto = String(e.texto || '').slice(0, 300);",
  "const catalogo = Array.isArray(e.catalogo) ? e.catalogo : [];",
  "const cuerpo = JSON.parse(PLANTILLA);",
  "cuerpo.messages[0].content = cuerpo.messages[0].content.replace(",
  "  MARCA, catalogo.map(p => p.id + ' = ' + p.nombre).join(" + SALTO + "));",
  "// La frase se asigna, no se interpola: es texto del tendero, nunca instrucciones.",
  "cuerpo.messages[1].content = texto;",
  "return [{ json: { cuerpo } }];"
].join('\n');

const traducir = [
  "// El nodo HTTP viene con fullResponse y neverError, así que aquí llega cualquier código, no",
  "// solo el 200. Se mira a propósito: el 429 del proveedor es cuota agotada, y StockVoz lo",
  "// distingue de un error de verdad para no mandar a buscar el problema al lugar equivocado.",
  "const r = $input.first().json;",
  "if (r.statusCode !== 200) {",
  "  const codigo = r.statusCode === 429 ? 429 : 502;",
  "  return [{ json: { codigo: codigo, error: 'el modelo respondió ' + r.statusCode } }];",
  "}",
  "// La respuesta del proveedor ya trae los seis campos del contrato. Se añade el gasto",
  "// en tokens para poder medir el costo con `npm run evaluar`.",
  "const datos = JSON.parse(r.body.choices[0].message.content);",
  "datos.uso = {",
  "  entrada: (r.body.usage && r.body.usage.prompt_tokens) || 0,",
  "  salida: (r.body.usage && r.body.usage.completion_tokens) || 0",
  "};",
  "return [{ json: datos }];"
].join('\n');

function nodo(nombre, tipo, version, posicion, parametros, extra) {
  return Object.assign({
    parameters: parametros,
    type: 'n8n-nodes-base.' + tipo,
    typeVersion: version,
    position: posicion,
    id: nombre.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: nombre
  }, extra || {});
}

const flujo = {
  // Id fijo para que volver a importar actualice el mismo flujo en vez de duplicarlo.
  id: 'stockvozinterpreta',
  name: 'StockVoz · interpretar',
  nodes: [
    nodo('Webhook', 'webhook', 2, [0, 0], {
      httpMethod: 'POST', path: 'stockvoz-interpretar', responseMode: 'responseNode', options: {}
    }, { webhookId: 'stockvoz-interpretar' }),

    nodo('¿Secreto correcto?', 'if', 2.2, [220, 0], {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [{
          id: 'secreto',
          leftValue: "={{ $json.headers['x-stockvoz-secreto'] }}",
          rightValue: '={{ $env.N8N_SECRETO }}',
          operator: { type: 'string', operation: 'equals' }
        }]
      },
      options: {}
    }),

    nodo('Rechazar 401', 'respondToWebhook', 1.1, [440, 160], {
      respondWith: 'json',
      responseBody: '{"error":"secreto incorrecto"}',
      options: { responseCode: 401 }
    }),

    nodo('Armar la petición', 'code', 2, [440, -160], {
      jsCode: 'const PLANTILLA = ' + JSON.stringify(JSON.stringify(plantilla)) + ';\n' +
        'const MARCA = ' + JSON.stringify(MARCA_CATALOGO) + ';\n\n' + armar
    }),

    nodo('Preguntarle al modelo', 'httpRequest', 4.2, [660, -160], {
      method: 'POST',
      url: ia.URL_POR_DEFECTO,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'authorization', value: '=Bearer {{ $env.IA_CLAVE }}' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      // Igual que el modo directo (redirect: 'error' en src/ia.js): la clave no debe viajar a
      // otro sitio. El nodo HTTP de n8n sigue redirecciones por DEFECTO desde typeVersion 4, y
      // solo deja de hacerlo si la opción está presente, así que va escrita a propósito.
      // fullResponse + neverError: el nodo no falla por el código de respuesta, lo entrega. Así
      // "Traducir la respuesta" puede distinguir el 429 (cuota agotada) de un error cualquiera;
      // si el nodo fallara, n8n devolvería un 500 pelado y se perdería la diferencia.
      options: {
        timeout: 20000,
        redirect: { redirect: { followRedirects: false } },
        response: { response: { fullResponse: true, neverError: true } }
      }
    }),

    nodo('Traducir la respuesta', 'code', 2, [880, -160], { jsCode: traducir }),

    // El código sale del dato, no del nodo: 200 cuando el modelo contestó, y el que haya puesto
    // "Traducir la respuesta" cuando no (429 por cuota, 502 por cualquier otra cosa).
    nodo('Responder', 'respondToWebhook', 1.1, [1100, -160], {
      respondWith: 'firstIncomingItem', options: { responseCode: '={{ $json.codigo || 200 }}' }
    })
  ],
  connections: {
    'Webhook': { main: [[{ node: '¿Secreto correcto?', type: 'main', index: 0 }]] },
    '¿Secreto correcto?': {
      main: [
        [{ node: 'Armar la petición', type: 'main', index: 0 }],   // secreto correcto
        [{ node: 'Rechazar 401', type: 'main', index: 0 }]         // secreto incorrecto
      ]
    },
    'Armar la petición': { main: [[{ node: 'Preguntarle al modelo', type: 'main', index: 0 }]] },
    'Preguntarle al modelo': { main: [[{ node: 'Traducir la respuesta', type: 'main', index: 0 }]] },
    'Traducir la respuesta': { main: [[{ node: 'Responder', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1' }
};

const destino = path.join(__dirname, 'flujo-stockvoz.json');
fs.writeFileSync(destino, JSON.stringify(flujo, null, 2) + '\n');
console.log('Escrito ' + destino);
