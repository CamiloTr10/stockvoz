# Contrato entre StockVoz y n8n

Cuando `STOCKVOZ_IA=1`, `POST /api/interpretar` le pasa la frase a un webhook de n8n, que consulta
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
  "texto": "vendí 3 gaseosas de 400",
  "catalogo": [
    { "id": 1, "nombre": "Gaseosa 1,5 L" },
    { "id": 2, "nombre": "Gaseosa 400 ml" }
  ]
}
```

- `texto`: la frase del usuario, de hasta 300 caracteres. **Es texto no confiable**: puede intentar
  darle instrucciones al modelo. Trátala como dato, nunca como instrucciones.
- `catalogo`: solo los productos activos **del negocio que pregunta**, con su `id` y `nombre`.
  No se envían precios, stock ni datos de personas.

## Respuesta (n8n → StockVoz)

`200` con un objeto JSON (en n8n: nodo *Respond to Webhook* con *First Incoming Item*, no una lista):

```json
{
  "estado": "ok",
  "tipo": "venta",
  "cantidad": 3,
  "productoId": 2,
  "candidatosIds": [],
  "busqueda": "",
  "uso": { "entrada": 1480, "salida": 62 }
}
```

| Campo | Tipo | Significado |
|---|---|---|
| `estado` | texto | `ok`, `consulta`, `ambiguo`, `sin_producto`, `sin_cantidad` o `no_entendido` |
| `tipo` | texto o `null` | `venta`, `entrada`, `merma` o `consulta`; `null` si no se entendió |
| `cantidad` | entero 1 a 100000 o `null` | unidades dichas; `null` si no se dijo |
| `productoId` | entero o `null` | `id` de un producto **del catálogo recibido** |
| `candidatosIds` | lista de enteros | hasta 5 `id` del catálogo cuando hay varios productos posibles |
| `busqueda` | texto | lo que el usuario nombró y no se encontró (hasta 120 caracteres) |
| `uso` | objeto, opcional | tokens `entrada` y `salida` gastados, para medir el costo en `npm run evaluar` |

### Qué campos van con cada estado

| `estado` | Cuándo | `tipo` | `productoId` | `cantidad` | `candidatosIds` |
|---|---|---|---|---|---|
| `ok` | se entendió todo | venta, entrada o merma | el producto | la cantidad | vacío |
| `consulta` | pregunta cuánto queda | `consulta` | el producto | `null` | vacío |
| `ambiguo` | encaja con 2 o más productos | venta, entrada o merma | `null` | si se dijo | 2 o más `id` |
| `sin_producto` | el producto no está en el catálogo | venta, entrada o merma | `null` | si se dijo | vacío |
| `sin_cantidad` | falta decir cuántas unidades | venta, entrada o merma | el producto | `null` | vacío |
| `no_entendido` | no es una operación ni una consulta | `null` | `null` | `null` | vacío |

Una frase con varias operaciones («vendí 3 gaseosas y se dañaron 2 panes») todavía no se soporta.

## Esquema JSON para salidas estructuradas

Úsalo para que el modelo solo pueda responder con este formato:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["estado", "tipo", "cantidad", "productoId", "candidatosIds", "busqueda"],
  "properties": {
    "estado": { "type": "string", "enum": ["ok", "consulta", "ambiguo", "sin_producto", "sin_cantidad", "no_entendido"] },
    "tipo": { "type": ["string", "null"], "enum": ["venta", "entrada", "merma", "consulta", null] },
    "cantidad": { "type": ["integer", "null"], "minimum": 1, "maximum": 100000 },
    "productoId": { "type": ["integer", "null"] },
    "candidatosIds": { "type": "array", "items": { "type": "integer" }, "maxItems": 5 },
    "busqueda": { "type": "string", "maxLength": 120 }
  }
}
```

## Qué hace el backend con la respuesta

Cualquiera de estos casos hace que se use el intérprete por reglas, y la interfaz sigue funcionando:

| Motivo (`motivoRespaldo`) | Cuándo |
|---|---|
| `timeout` | n8n no respondió en `N8N_TIMEOUT_MS` (6000 ms por defecto) |
| `red` | no se pudo conectar con n8n |
| `http` | n8n respondió con un código distinto de 200 (por ejemplo 401 por un secreto incorrecto) |
| `invalida` | la respuesta no es JSON, usa valores fuera de lo permitido, nombra un producto que no está en el catálogo enviado o los campos no cuadran con el `estado` |
| `limite` | el negocio ya usó sus `STOCKVOZ_IA_LIMITE_DIARIO` interpretaciones con IA del día |

La respuesta de `/api/interpretar` incluye `fuente` (`ia` o `reglas`) y, si hubo respaldo, `motivoRespaldo`.

## Qué debe hacer el flujo por dentro

El flujo de n8n es un traductor: recibe lo de arriba, le pregunta al modelo y devuelve lo de abajo.
Las instrucciones y el esquema que debe enviarle al modelo **no se escriben a mano en n8n**: están en
[`src/ia-instrucciones.js`](../src/ia-instrucciones.js), para que el flujo y el modo directo usen
exactamente lo mismo y no se desincronicen.

Para ver el cuerpo exacto que hay que enviarle al proveedor:

```bash
node -e "console.log(JSON.stringify(require('./src/ia-instrucciones').cuerpoPeticion({ texto: 'vendí 3 gaseosas de 400', catalogo: [{id:1,nombre:'Gaseosa 1,5 L'},{id:2,nombre:'Gaseosa 400 ml'}] }), null, 2))"
```

Pasos del flujo:

1. **Webhook** que recibe el `POST` con `texto` y `catalogo`.
2. **Comprobar el secreto**: si `x-stockvoz-secreto` no coincide, responder `401` y cortar.
3. **Llamar al modelo** con el cuerpo de arriba, poniendo el catálogo recibido y la frase recibida.
   La clave del proveedor va en las **credenciales de n8n**, nunca dentro del flujo exportado.
4. **Responder** el contenido del modelo tal cual (ya viene con los seis campos), añadiendo `uso`
   con los tokens si se quiere medir el costo.

Con Groq el esquema va con `strict: true`, así que el modelo no puede responder otra cosa.
De todas formas el backend valida: si algo no cuadra, usa el intérprete por reglas.
