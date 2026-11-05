# Plan hasta la sustentación

**Hoy:** 5 de noviembre de 2026 · **Sustentación:** entre el 12 y el 18 de diciembre · **Quedan unas 5 semanas y media.**

## Dónde estamos

Funciona de punta a punta: el tendero dicta o escribe, n8n le pregunta a Groq, el backend valida,
el tendero confirma y recién ahí se guarda. Una frase puede traer varias operaciones.

| | Estado |
|---|---|
| Inventario, movimientos, anulaciones, reportes, CSV | Hecho |
| Multi-negocio, roles, invitaciones por código | Hecho |
| App instalable (PWA) | Hecho, sin verificar en un celular real |
| Interpretación por reglas (respaldo, sin conexión) | Hecho · 85 % del banco |
| Interpretación con IA vía n8n + Groq | Hecho · 97 % del banco |
| Varias operaciones en una frase | Hecho |
| Dictado por voz | Whisper en el servidor, con la Web Speech API de respaldo |
| Recolector de frases de tenderos (`#/recolectar`) | Hecho, falta usarlo |
| 137 pruebas automáticas | Pasan |

## Lo que más puede costarnos la nota

Por orden de riesgo, no de dificultad.

### 1. El banco de frases lo escribimos nosotros

Es lo primero que un jurado va a preguntar: «¿cómo saben que entiende a un tendero de verdad?».
Hoy la respuesta honesta es que no lo sabemos: las 62 frases las inventamos nosotros. El 97 % mide
que el modelo entiende español coloquial, no que resuelva el problema.

**Con 30 o 40 frases grabadas a tenderos reales, el 97 % deja de ser un número nuestro y pasa a ser
evidencia.** Es el trabajo que más sube la nota por hora invertida, y no es de programación.

### 2. El día de la sustentación el demo depende de muchas cosas

Docker encendido, n8n arriba, internet en el salón y cupo de Groq sin gastar. Si algo falla delante
del jurado, el respaldo por reglas salva la demostración —la app sigue funcionando al 85 %— pero hay
que saberlo de antemano y ensayarlo, no descubrirlo ahí.

### 3. El CI está en rojo en GitHub

No por el código: la cuenta está bloqueada por un problema de facturación y ningún trabajo arranca
desde el 4 de noviembre. Si el jurado abre el repositorio, ve una equis roja. Se arregla en
github.com/settings/billing.

## Plan por semanas

### Semana del 6 al 12 de noviembre

- Volver a medir el banco completo con las instrucciones finales (ya está programado para el 6).
- Desatascar la facturación de GitHub y fusionar las tres ramas abiertas a `main`.
- ~~Armar la herramienta para recoger frases de tenderos~~ **Hecha** el 5 de noviembre: Whisper
  transcribe en el servidor y `#/recolectar` arma los casos. Falta entregársela a David y
  explicarle el ciclo.

### Semana del 13 al 19 de noviembre

- **David:** salir a grabar tenderos. Meta mínima: 30 frases reales.
- Convertir esas frases en casos del banco y volver a medir. Aquí es donde el número se vuelve real,
  y es muy posible que baje: eso no es un fracaso, es el dato que nos faltaba.
- Afinar las instrucciones con lo que falle, midiendo, como se hizo las tres veces anteriores.

### Semana del 20 al 26 de noviembre

- Cerrar los cabos técnicos sueltos:
  - protección contra redirecciones en el nodo HTTP de n8n (el modo directo ya la tiene);
  - medir qué pasa con un catálogo grande contra el límite de 8.000 tokens por minuto;
  - el límite del intérprete por reglas con el verbo omitido, si sobra tiempo.
- Pruebas de usabilidad con las cuentas demo y ajustar los textos de error con lo que se vea.

### Semana del 27 de noviembre al 3 de diciembre

- **Congelar funciones.** De aquí en adelante solo se arreglan errores.
- Escribir el documento y las diapositivas. La mayor parte ya está en `docs/` y en el README:
  el contrato con n8n, el diseño de varias operaciones y las tres rondas de medición son
  exactamente el tipo de evidencia que pide un proyecto integrador.

### Semana del 4 al 10 de diciembre

- Ensayar la sustentación completa, con el computador y la red que se van a usar.
- Preparar el plan B del demo (ver abajo) y probarlo apagando internet a propósito.
- Dejar el repositorio presentable: CI en verde, `main` al día, README sin nada desactualizado.

## La herramienta para recoger frases

Sin esto, «grabar tenderos» se queda en buena intención. Lo que hace falta es que David pueda grabar
una frase y que quede lista para el banco, sin tocar código.

**Las dos piezas ya están hechas** (5 de noviembre). Lo que sigue es usarla.

Lo que se construyó:

1. **Transcribir con Whisper.** Groq da `whisper-large-v3-turbo` gratis con la misma cuenta que ya
   tenemos (20 peticiones por minuto, 2.000 al día). Reemplaza la Web Speech API, que solo anda en
   Chrome y le manda el audio a Google. Es además lo que recomendaron los profesores.
2. **Guardar la frase transcrita junto a lo que el tendero quiso decir**, en el formato de
   `evaluacion/casos.json`, para que entre al banco sin trabajo manual.

Whisper sirve dos propósitos a la vez: mejora el dictado de la app y es la máquina de hacer banco.
Por eso vale la pena, aunque el despliegue y el celular estén aplazados.

## El plan B del demo

Tres niveles, de mejor a peor, y los tres funcionan:

| Si falla | Se usa | Precisión |
|---|---|---|
| Nada | n8n + Groq | 97 % |
| n8n o Docker | `STOCKVOZ_IA=directo` (sin n8n de por medio) | 97 % |
| Internet o el cupo de Groq | Intérprete por reglas, sin conexión | 85 % |

Cambiar de nivel es editar una línea del `.env` y reiniciar. **Hay que ensayar los tres**, y
explicarle al jurado que el respaldo es una decisión de diseño, no un parche: la app de un tendero
no puede dejar de funcionar porque se cayó un proveedor.

## Lo que decidimos no hacer

- **Publicar en internet con HTTPS.** Aplazado por decisión del dueño del proyecto. Mientras tanto
  el demo es local, y la voz funciona en Chrome porque `localhost` cuenta como sitio seguro.
- **Probar la app instalada en un celular.** Aplazado. Depende de lo anterior.
- **Comparar con DeepSeek.** Groq cumple y DeepSeek exige prepagar. No se justifica salvo que Groq
  se quede corto.
