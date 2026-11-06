# Varias operaciones en una sola frase

**Fecha:** 5 de noviembre de 2026 · **Estado:** aprobado, en implementación

## El problema

StockVoz entiende una operación por frase. Probando con frases reales apareció que no solo
falla: **falla en silencio**.

| Frase | Qué hace hoy |
|---|---|
| «vendí 2 borradores y compré 3 lápices» | `no_entendido`, no guarda nada |
| «se dañaron 2 cuadernos y vendí 5 borradores» | guarda solo la merma, descarta la venta |
| «llegaron 10 resmas, vendí 3 lápices y se me dañó un cuaderno» | guarda solo la entrada, descarta dos |

El primer caso es honesto. Los otros dos se comen operaciones sin avisar: el tendero dice tres
cosas, la app guarda una y el inventario queda mal sin que nadie se entere. Eso es peor que no
entender, porque no deja rastro de que algo se perdió.

La jerga coloquial **ya funciona** y no hay nada que hacer ahí. Medido el 5 de noviembre contra
`openai/gpt-oss-20b`: «oe pana vendí 30 borradores», «quiubo mano, se me acabaron 4 lapices, los
vendí» y «parce préstame el dato, cuántas resmas quedan» se interpretan bien.

## Qué se decidió

**Si una operación no se puede guardar, las demás sí se guardan.** Decisión del dueño del
proyecto. En un mostrador con clientes esperando, obligar a repetir tres operaciones por culpa de
una es peor que guardar las dos buenas y avisar cuál falló.

La alternativa «o todas o ninguna» era más simple de programar, pero traslada el costo al tendero
en el peor momento. La alternativa «que decida en pantalla» añade un paso más justo cuando hay
afán.

## El diseño

### La interpretación pasa a ser una lista

`POST /api/interpretar` devuelve siempre una lista, aunque haya una sola operación:

```json
{ "operaciones": [ { "estado": "ok", "tipo": "venta", "cantidad": 2,
                     "productoId": 11, "candidatosIds": [], "busqueda": "" } ],
  "fuente": "ia", "uso": { "entrada": 780, "salida": 90 } }
```

Se descartó mantener el objeto plano y añadir la lista solo cuando hay varias operaciones. Eso
obliga a la pantalla, al banco de pruebas, a las pruebas y al flujo de n8n a manejar dos formas
para siempre, y con la sustentación en cinco semanas una sola forma es menos código y menos
sorpresas.

**El `estado` se muda adentro de cada operación.** Es lo que vuelve expresable el caso mixto:
«vendí 2 borradores y compré chocolatinas» tiene una operación `ok` y otra `sin_producto`, cada
una con su propio problema. Hoy eso no se puede decir.

Tope de **5 operaciones** por frase: más que eso no es una frase de mostrador, y cada operación
cuesta tokens del plan gratuito.

Una lista vacía significa que no se entendió nada.

### Guardar no cambia

`registrarMovimiento()` ya guarda un movimiento en su propia transacción, con bloqueo de fila y
chequeo de stock. Como las operaciones se guardan por separado y cada una vive o muere sola, la
pantalla llama al endpoint de siempre una vez por operación.

**No se toca el backend de guardado.** Es código probado que mueve inventario; cambiarlo sin
necesidad es el riesgo que no vale la pena correr. Dos operaciones sobre el mismo producto
funcionan igual, porque cada llamada bloquea la fila y vuelve a comprobar el stock.

### El respaldo por reglas también parte la frase

Si el modelo se cae y las reglas devuelven una sola operación, vuelve el problema de comerse
operaciones en silencio. Así que `src/interprete.js` parte la frase por conectores (« y », « e »,
coma, punto y coma) y corre su lógica actual sobre cada pedazo.

Un pedazo que trae su propio verbo abre una operación. Si no lo trae, **hereda el del pedazo
anterior**, porque el tendero omite el verbo cuando sigue hablando de lo mismo: «vendí 2
borradores y 3 lápices» son dos ventas.

Pero solo lo hereda si de verdad es otra operación. Un pedazo **se vuelve a pegar al anterior**,
con su separador, en cuatro casos, y cada uno viene de una frase que se medía mal:

| Caso | Ejemplo | Por qué se pega |
|---|---|---|
| Número compuesto | «vendí treinta **y cinco** huevos» | Es la única forma compuesta del español, y se reconoce porque el pedazo anterior termina en la decena |
| Decimal | «vendí 1**,5** kilos de arroz» | La coma del número es el mismo separador que divide operaciones |
| Al anterior le falta la cantidad | «entraron unos panecitos**, como diez**» | El número no abre una operación: le pone la cantidad a la que ya estaba |
| El pedazo no tiene cantidad, o no nombra producto | «vendí 3 panes **y ya cerré**» | Sin las dos cosas no hay nada que guardar |

Separar mal es peor que juntar de más: juntar de más pierde una operación que el tendero puede
volver a dictar, mientras que separar mal **inventa** una operación que él nunca dijo y que
confirmaría sin darse cuenta. De ahí que la duda siempre se resuelva pegando.

### Qué ve el tendero

La pantalla de confirmar pasa de una fila a N filas, cada una editable como hoy (producto,
cantidad, tipo), con la frase original arriba para poder comparar lo dicho con lo entendido.

Al confirmar se guardan una por una y el resultado se reporta por fila:

> Guardé 2 de 3. Venta de 2 Borrador ✓ · Entrada de 3 Lápiz HB ✓ · Venta de 50 Resma carta ✗
> solo quedan 6

**Nada se guarda sin confirmación**, igual que hoy. Eso es lo que hace tolerable que al respaldo
por reglas se le escape una operación: el tendero la ve faltar antes de guardar.

## Archivos

| Archivo | Cambio |
|---|---|
| `src/ia-instrucciones.js` | Esquema a lista; las reglas explican varias operaciones |
| `src/ia.js` | `validar()` valida la lista y calcula el estado de cada operación |
| `src/interprete.js` | Parte por conectores y devuelve lista |
| `public/app.js` | N filas, guardado uno por uno, reporte por fila |
| `docs/contrato-n8n.md` | Contrato nuevo |
| `evaluacion/casos.json` | Casos a lista, más casos múltiples |
| `n8n/flujo-stockvoz.json` | Se regenera con `npm run flujo` |

## Cómo se comprueba

- Casos múltiples en el intérprete por reglas, incluido «treinta y cinco» sin partirse
- Validación de listas: rechazar un producto ajeno al catálogo, pasarse del tope de 5
- El banco completo de 55 frases de una sola operación, **para confirmar que no se degradaron**:
  ese es el riesgo real de este cambio
- En el navegador, con la frase que destapó el problema

## Lo que este cambio no hace

No toca Whisper ni la transcripción de voz. Whisper convierte audio en texto; esto trabaja sobre
el texto ya transcrito. Son dos cosas distintas y meterlas juntas sería trabajo desperdiciado.
