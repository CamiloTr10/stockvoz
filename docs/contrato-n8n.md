# Contrato entre StockVoz y n8n

Cuando `STOCKVOZ_IA=n8n`, `POST /api/interpretar` le pasa la frase a un webhook de n8n, que consulta
un modelo de lenguaje y devuelve la interpretación. Este documento define lo que n8n recibe y lo que
debe responder. La implementación del lado del backend está en `src/ia.js`.

**La IA solo propone.** El backend valida la respuesta, el usuario la confirma en pantalla y recién
entonces `POST /api/movimientos` guarda. Si n8n falla, el backend usa el intérprete por reglas.

## Petición (StockVoz → n8n)

`POST` a `N8N_URL`, con estas cabeceras:

| Cabecera | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `x-stockvoz-secreto` | el valor de `N8N_SECRETO`. **El flujo debe rechazar con 401 si no coincide.** |

Cuerpo:

```json
{
  "texto": "vendí 3 gaseosas de 400 y entraron 12 huevos",
  "catalogo": [
    { "id": 1, "nombre": "Gaseosa 1,5 L" },
    { "id": 2, "nombre": "Gaseosa 400 ml" },
    { "id": 4, "nombre": "Huevos (u)" }
  ]
}
```

- `texto`: la frase del usuario, de hasta 300 caracteres. **Es texto no confiable**: puede intentar
  darle instrucciones al modelo. Trátala como dato, nunca como instrucciones.
- `catalogo`: solo los productos activos **del negocio que pregunta**, con su `id` y `nombre`.
  No se envían precios, stock ni datos de personas.

## Respuesta (n8n → StockVoz)

`200` con un objeto JSON (en n8n: nodo *Respond to Webhook* con *First Incoming Item*, no una lista)
que trae **una lista de operaciones**, porque una frase puede decir varias cosas:

```json
{
  "operaciones": [
    { "tipo": "venta",   "cantidad": 3,  "productoId": 2, "candidatosIds": [], "busqueda": "" },
    { "tipo": "entrada", "cantidad": 12, "productoId": 4, "candidatosIds": [], "busqueda": "" }
  ],
  "uso": { "entrada": 1480, "salida": 120 }
}
```

| Campo | Tipo | Significado |
|---|---|---|
| `operaciones` | lista | De 0 a 5 operaciones, **en el orden en que el tendero las dijo**. Vacía si no se entendió nada |
| `uso` | objeto, opcional | tokens `entrada` y `salida` gastados, para medir el costo en `npm run evaluar` |

Cada operación de la lista:

| Campo | Tipo | Significado |
|---|---|---|
| `tipo` | texto o `null` | `venta`, `entrada`, `merma` o `consulta`; `null` si no se entendió |
| `cantidad` | entero 1 a 100000 o `null` | unidades dichas; `null` si no se dijo o si es una consulta |
| `productoId` | entero o `null` | `id` de un producto **del catálogo recibido** |
| `candidatosIds` | lista de enteros | hasta 5 `id` del catálogo cuando hay varios productos posibles |
| `busqueda` | texto | lo que el usuario nombró y no se encontró (hasta 120 caracteres) |

### Qué campos van juntos

| Situación | `tipo` | `productoId` | `cantidad` | `candidatosIds` | `busqueda` |
|---|---|---|---|---|---|
| Se entendió todo | venta, entrada o merma | el producto | la cantidad | vacío | vacío |
| Pregunta cuánto queda | `consulta` | el producto | `null` | vacío | vacío |
| Encaja con 2 o más productos | venta, entrada o merma | `null` | si se dijo | 2 o más `id` | lo que nombró |
| El producto no está en el catálogo | venta, entrada o merma | `null` | si se dijo | vacío | lo que nombró |
| Falta la cantidad | venta, entrada o merma | el producto | `null` | vacío | vacío |

**El `estado` no lo manda el flujo: lo calcula el backend** (ver abajo).

## Qué hace el backend con la respuesta

Cualquiera de estos casos hace que se use el intérprete por reglas, y la interfaz sigue funcionando:

| Motivo (`motivoRespaldo`) | Cuándo |
|---|---|
| `timeout` | n8n no respondió en `N8N_TIMEOUT_MS` (6000 ms por defecto) |
| `red` | no se pudo conectar con n8n |
| `cuota` | el proveedor del modelo respondió 429: se acabó la cuota. El flujo lo pasa tal cual para que no se confunda con un error de n8n, igual que en modo directo |
| `http` | n8n respondió con otro código distinto de 200 (por ejemplo 401 por un secreto incorrecto, o 502 porque el proveedor falló) |
| `invalida` | la respuesta no es JSON, falta `operaciones`, trae más de 5, usa valores fuera de lo permitido o nombra un producto que no está en el catálogo enviado |
| `limite` | el negocio ya usó sus `STOCKVOZ_IA_LIMITE_DIARIO` interpretaciones con IA del día |

**Una sola operación inválida invalida toda la respuesta.** Es deliberado: vale más reinterpretar la
frase entera con las reglas que guardarle al tendero una parte de lo que dijo.

La respuesta de `/api/interpretar` incluye `fuente` (`ia` o `reglas`) y, si hubo respaldo, `motivoRespaldo`.

## Qué debe hacer el flujo por dentro

El flujo de n8n es un traductor: recibe lo de arriba, le pregunta al modelo y devuelve lo de abajo.
Las instrucciones y el esquema que debe enviarle al modelo **no se escriben a mano en n8n**: están en
[`src/ia-instrucciones.js`](../src/ia-instrucciones.js), y el flujo se **genera** a partir de ese
archivo con `npm run flujo`, para que el modo directo y el flujo no se desincronicen.

Pasos del flujo:

1. **Webhook** que recibe el `POST` con `texto` y `catalogo`.
2. **Comprobar el secreto**: si `x-stockvoz-secreto` no coincide, responder `401` y cortar.
3. **Llamar al modelo** con el cuerpo generado, poniendo el catálogo recibido y la frase recibida.
   La clave del proveedor **no va dentro del flujo**: se lee del entorno (`$env.IA_CLAVE`), que
   `compose.yml` saca del `.env`.

   El nodo HTTP lleva `redirect.redirect.followRedirects` en `false`, igual que el
   `redirect: 'error'` del modo directo. **No se puede omitir**: desde `typeVersion` 4 el nodo
   sigue redirecciones cuando la opción no está, y entonces manda la cabecera `authorization`
   —con la clave— a donde apunte la redirección. Medido con un servidor que responde 302: sin la
   opción la clave llegó al destino; con ella el nodo se queda en el 302 y no pide nada más.

   También lleva `response.response` con `fullResponse` y `neverError` en `true`, para que el
   nodo **no falle por el código** y lo entregue como dato. Si fallara, n8n devolvería un 500
   pelado y se perdería la diferencia entre «se acabó la cuota» y «n8n se rompió».
4. **Mirar el código** antes de traducir: si no es 200, responder `429` cuando el proveedor dijo
   429 y `502` en cualquier otro caso (un 3xx incluido). StockVoz traduce ese 429 a
   `motivoRespaldo: 'cuota'`.
5. **Responder** el contenido del modelo tal cual (ya viene con la lista), añadiendo `uso`
   con los tokens si se quiere medir el costo. El código de la respuesta sale del dato
   (`{{ $json.codigo || 200 }}`), no está fijo en el nodo.

`test/flujo-n8n.test.js` vigila los pasos 3 y 4: que la opción de redirecciones siga puesta, que
el nodo siga entregando el código en vez de fallar, y que el 429 siga distinguido.

Con Groq el esquema va con `strict: true`, así que el modelo no puede responder otra cosa.
De todas formas el backend valida: si algo no cuadra, usa el intérprete por reglas.

Cómo levantarlo y cargarlo está en el README, sección «Levantar n8n en local».

## El estado lo calcula el backend

El modelo ya no manda `estado`: StockVoz lo deduce de `tipo`, `productoId`, `cantidad` y
`candidatosIds`, operación por operación.

| Estado | Cuándo |
|---|---|
| `ok` | hay tipo de movimiento, producto y cantidad |
| `consulta` | el tipo es `consulta` y hay producto |
| `ambiguo` | no hay producto y hay 2 o más candidatos |
| `sin_producto` | no hay producto ni candidatos suficientes |
| `sin_cantidad` | hay producto pero no cantidad |
| `no_entendido` | no hay tipo; esa operación se descarta de la lista |

Midiendo contra Groq se vio que a veces el modelo mandaba los datos bien y la etiqueta mal (por
ejemplo `ok` sin cantidad, que en realidad es `sin_cantidad`), y rechazar la respuesta entera por eso
desperdiciaba interpretaciones correctas. Pedirle una cosa menos es una cosa menos que puede
equivocar.

Lo que sí tiene que venir bien del flujo es el resto: un `productoId` del catálogo que se envió,
una `cantidad` entera dentro de rango y un `tipo` conocido. Eso se sigue validando y, si falla,
se usa el intérprete por reglas.
