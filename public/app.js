'use strict';
/* StockVoz — interfaz (JavaScript nativo, sin dependencias).
   Una sola página con rutas por hash: #/ingresar, #/panel, #/registrar, etc. */
(function () {
  var vista = document.getElementById('vista');
  var aviso = document.getElementById('aviso');
  var estado = { sesion: null, config: { demo: false }, primeraCarga: true };

  var pesos = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  var fechaHora = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  var diaCorto = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'short', day: 'numeric' });

  var TIPOS = { venta: 'Venta', entrada: 'Entrada', merma: 'Merma' };
  var ESTADOS = { ok: 'OK', bajo: 'Bajo', agotado: 'Agotado' };
  var ORIGENES = { voz: 'Voz', texto: 'Texto', manual: 'Manual', inicial: 'Stock inicial' };

  /* ---------- Utilidades ---------- */
  // Todo dato que viene del servidor o del usuario pasa por esc() antes de ir al HTML.
  function esc(valor) {
    return String(valor === null || valor === undefined ? '' : valor).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function avisar(texto, esError) {
    aviso.textContent = texto;
    aviso.className = 'aviso visible' + (esError ? ' aviso--error' : '');
    clearTimeout(avisar.t);
    avisar.t = setTimeout(function () { aviso.className = 'aviso'; }, 4500);
  }

  function api(metodo, ruta, cuerpo) {
    var opciones = { method: metodo, headers: {}, credentials: 'same-origin' };
    if (cuerpo !== undefined) {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = JSON.stringify(cuerpo);
    }
    return fetch(ruta, opciones).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (datos) {
        if (r.status === 401 && ruta !== '/api/sesion') {
          estado.sesion = null;
          location.hash = '#/ingresar';
        }
        if (!r.ok) {
          var e = new Error(datos.error || 'No se pudo completar la acción.');
          e.estado = r.status;
          throw e;
        }
        return datos;
      });
    }, function () {
      throw new Error('No hay conexión con el servidor. Revisa que StockVoz esté corriendo.');
    });
  }

  function badgeEstado(est) {
    return '<span class="pill pill--' + esc(est) + '">' + esc(ESTADOS[est] || est) + '</span>';
  }

  function badgeTipo(tipo) {
    return '<span class="pill pill--' + esc(tipo) + '">' + esc(TIPOS[tipo] || tipo) + '</span>';
  }

  function render(html, titulo) {
    vista.innerHTML = html;
    // La CSP no permite style="" en el HTML; las medidas de los gráficos se asignan desde JS.
    vista.querySelectorAll('[data-medida]').forEach(function (el) {
      var par = el.getAttribute('data-medida').split(':');
      el.style.setProperty(par[0], par[1] + '%');
    });
    document.title = titulo + ' | StockVoz';
    // Al cambiar de pantalla, el foco va al título para que el lector de pantalla lo anuncie.
    if (!estado.primeraCarga) {
      var h1 = vista.querySelector('h1');
      if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus(); }
    }
    estado.primeraCarga = false;
  }

  function errorEn(contenedor, mensaje) {
    contenedor.innerHTML = mensaje ? '<p class="error" role="alert">' + esc(mensaje) + '</p>' : '';
  }

  /* ---------- Sesión y navegación ---------- */
  function pintarBarra() {
    var s = estado.sesion;
    document.body.classList.toggle('sin-sesion', !s || !s.negocio);
    document.getElementById('negocio-actual').textContent = s && s.negocio
      ? s.negocio.nombre + ' · ' + (s.rol === 'dueno' ? 'Dueño' : 'Encargado') : '';
    document.getElementById('btn-cambiar').hidden = !(s && s.negocios.length > 1);
    document.querySelectorAll('.nav a').forEach(function (a) {
      var activa = location.hash.indexOf(a.getAttribute('data-ruta')) === 0;
      a.classList.toggle('activa', activa);
      if (activa) { a.setAttribute('aria-current', 'page'); } else { a.removeAttribute('aria-current'); }
    });
  }

  document.getElementById('btn-salir').addEventListener('click', function () {
    api('DELETE', '/api/sesion').catch(function () {}).then(function () {
      estado.sesion = null;
      location.hash = '#/ingresar';
    });
  });
  document.getElementById('btn-cambiar').addEventListener('click', function () { location.hash = '#/negocio'; });

  var RUTAS = {
    '#/ingresar': vistaIngreso,
    '#/registro': vistaRegistro,
    '#/negocio': vistaNegocio,
    '#/panel': vistaPanel,
    '#/registrar': vistaRegistrar,
    '#/inventario': vistaInventario,
    '#/movimientos': vistaMovimientos,
    '#/reportes': vistaReportes
  };
  var PUBLICAS = ['#/ingresar', '#/registro'];

  function rutaActual() {
    var base = location.hash.split('?')[0];
    return RUTAS[base] ? base : '#/panel';
  }

  function parametro(nombre) {
    var q = location.hash.split('?')[1] || '';
    return new URLSearchParams(q).get(nombre);
  }

  function enrutar() {
    var ruta = rutaActual();
    var publica = PUBLICAS.indexOf(ruta) !== -1;
    if (!estado.sesion && !publica) { location.hash = '#/ingresar'; return; }
    if (estado.sesion && publica) { location.hash = '#/panel'; return; }
    if (estado.sesion && !estado.sesion.negocio && ruta !== '#/negocio') { location.hash = '#/negocio'; return; }
    pintarBarra();
    RUTAS[ruta]();
  }

  window.addEventListener('hashchange', enrutar);

  function entrar(sesion) {
    estado.sesion = sesion;
    location.hash = sesion.negocio ? '#/panel' : '#/negocio';
    enrutar();
  }

  /* ---------- Ingreso y registro ---------- */
  function vistaIngreso() {
    render(
      '<section class="acceso">' +
        '<div class="acceso-marca"><img src="logo.svg" alt="" width="56" height="56"><h1>Ingresar a StockVoz</h1>' +
        '<p>Registra ventas, entradas y mermas hablando o escribiendo.</p></div>' +
        '<form id="form-ingreso" class="tarjeta form" novalidate>' +
          '<label for="correo">Correo</label><input id="correo" type="email" autocomplete="username" required>' +
          '<label for="clave">Contraseña</label><input id="clave" type="password" autocomplete="current-password" required>' +
          '<div id="error-ingreso"></div>' +
          '<button class="btn btn--grande" type="submit">Ingresar</button>' +
          '<p class="nota">¿Tu negocio aún no tiene cuenta? <a href="#/registro">Crear una cuenta</a></p>' +
        '</form>' +
        (estado.config.demo
          ? '<aside class="tarjeta demo" aria-labelledby="demo-titulo"><h2 id="demo-titulo">Cuentas de demostración</h2>' +
            '<p><b>demo@stockvoz.test</b>: dueña de dos negocios.<br><b>encargado@stockvoz.test</b>: encargado de la tienda.<br>Contraseña de ambas: <b>demo12345</b></p>' +
            '<button type="button" class="btn btn--blanco" id="usar-demo">Usar la cuenta demo</button></aside>'
          : '') +
      '</section>', 'Ingresar');

    var form = document.getElementById('form-ingreso');
    var usarDemo = document.getElementById('usar-demo');
    if (usarDemo) {
      usarDemo.addEventListener('click', function () {
        document.getElementById('correo').value = 'demo@stockvoz.test';
        document.getElementById('clave').value = 'demo12345';
        document.getElementById('correo').focus();
      });
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var zona = document.getElementById('error-ingreso');
      errorEn(zona, '');
      var correo = form.correo.value.trim();
      if (!correo || !form.clave.value) { errorEn(zona, 'Escribe tu correo y tu contraseña.'); return; }
      form.querySelector('button[type=submit]').disabled = true;
      api('POST', '/api/sesion', { correo: correo, clave: form.clave.value })
        .then(entrar)
        .catch(function (e) {
          errorEn(zona, e.message);
          form.querySelector('button[type=submit]').disabled = false;
          form.clave.select();
        });
    });
  }

  function vistaRegistro() {
    render(
      '<section class="acceso">' +
        '<div class="acceso-marca"><img src="logo.svg" alt="" width="56" height="56"><h1>Crear cuenta</h1>' +
        '<p>Tu negocio tendrá su propio espacio: sus datos no se mezclan con los de otros negocios.</p></div>' +
        '<form id="form-registro" class="tarjeta form" novalidate>' +
          '<label for="negocio">Nombre del negocio</label><input id="negocio" maxlength="80" autocomplete="organization" required>' +
          '<label for="nombre">Tu nombre</label><input id="nombre" maxlength="80" autocomplete="name" required>' +
          '<label for="correo">Correo</label><input id="correo" type="email" maxlength="120" autocomplete="email" required>' +
          '<label for="clave">Contraseña <small>(mínimo 8 caracteres)</small></label><input id="clave" type="password" minlength="8" autocomplete="new-password" required>' +
          '<div id="error-registro"></div>' +
          '<button class="btn btn--grande" type="submit">Crear cuenta</button>' +
          '<p class="nota">¿Ya tienes cuenta? <a href="#/ingresar">Ingresar</a></p>' +
        '</form>' +
      '</section>', 'Crear cuenta');

    var form = document.getElementById('form-registro');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var zona = document.getElementById('error-registro');
      if (form.clave.value.length < 8) { errorEn(zona, 'La contraseña debe tener al menos 8 caracteres.'); return; }
      api('POST', '/api/registro', {
        negocio: form.negocio.value, nombre: form.nombre.value, correo: form.correo.value, clave: form.clave.value
      }).then(function (s) {
        avisar('Cuenta creada. Empieza agregando tus productos.');
        estado.sesion = s;
        location.hash = '#/inventario?nuevo=1';
      }).catch(function (e) { errorEn(zona, e.message); });
    });
  }

  function vistaNegocio() {
    var s = estado.sesion;
    render(
      '<section class="acceso">' +
        '<div class="acceso-marca"><h1>¿En qué negocio vas a trabajar?</h1><p>Hola, ' + esc(s.usuario.nombre) + '. Tienes acceso a ' + s.negocios.length + ' negocios.</p></div>' +
        '<ul class="lista-negocios" role="list">' +
        s.negocios.map(function (n) {
          return '<li><button type="button" class="tarjeta negocio-btn" data-id="' + n.id + '"><b>' + esc(n.nombre) + '</b><span>' +
            (n.rol === 'dueno' ? 'Dueño' : 'Encargado') + '</span></button></li>';
        }).join('') +
        '</ul>' +
      '</section>', 'Elegir negocio');

    vista.querySelectorAll('.negocio-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        api('POST', '/api/sesion/negocio', { negocioId: Number(b.getAttribute('data-id')) })
          .then(function (sesion) { estado.sesion = sesion; location.hash = '#/panel'; })
          .catch(function (e) { avisar(e.message, true); });
      });
    });
  }

  /* ---------- Panel ---------- */
  function vistaPanel() {
    render('<h1>Inicio</h1><p class="cargando">Cargando resumen…</p>', 'Inicio');
    api('GET', '/api/panel').then(function (p) {
      var max = Math.max.apply(null, p.ventas7.map(function (d) { return d.total; }).concat([1]));
      render(
        '<div class="encabezado"><div><h1>Hola, ' + esc(estado.sesion.usuario.nombre) + '</h1>' +
        '<p class="sub">Resumen de ' + esc(estado.sesion.negocio.nombre) + '</p></div>' +
        '<a class="btn btn--grande" href="#/registrar"><i class="material-icons" aria-hidden="true">mic</i>Registrar movimiento</a></div>' +

        '<div class="kpis">' +
          '<div class="kpi kpi--sol"><span>Ventas de hoy</span><b>' + esc(pesos.format(p.ventasHoy)) + '</b></div>' +
          '<div class="kpi"><span>Productos activos</span><b>' + p.productosActivos + '</b></div>' +
          '<div class="kpi' + (p.alertas.length ? ' kpi--alerta' : '') + '"><span>Alertas de stock</span><b>' + p.alertas.length + '</b></div>' +
        '</div>' +

        '<div class="rejilla">' +
          '<section class="tarjeta" aria-labelledby="t-ventas"><h2 id="t-ventas">Ventas de los últimos 7 días</h2>' +
            '<ol class="barras" role="list">' + p.ventas7.map(function (d) {
              var alto = Math.round((d.total / max) * 100);
              return '<li><span class="barra-valor">' + esc(pesos.format(d.total)) + '</span>' +
                '<span class="barra-graf" data-medida="--alto:' + alto + '" aria-hidden="true"></span>' +
                '<span class="barra-dia">' + esc(diaCorto.format(new Date(d.fecha + 'T00:00:00Z'))) + '</span></li>';
            }).join('') + '</ol></section>' +

          '<section class="tarjeta" aria-labelledby="t-alertas"><h2 id="t-alertas">Stock bajo</h2>' +
            (p.alertas.length
              ? '<ul class="lista" role="list">' + p.alertas.map(function (a) {
                  return '<li><span>' + esc(a.nombre) + '</span><span>' + a.stock + ' uds ' + badgeEstado(a.estado) + '</span></li>';
                }).join('') + '</ul>'
              : '<p class="vacio">Todo en orden: ningún producto está por debajo de su mínimo.</p>') +
          '</section>' +
        '</div>' +

        '<section class="tarjeta" aria-labelledby="t-recientes"><h2 id="t-recientes">Movimientos recientes</h2>' +
          tablaMovimientos(p.recientes, true) +
          '<p><a href="#/movimientos">Ver todo el historial</a></p></section>',
        'Inicio');
    }).catch(function (e) { render('<h1>Inicio</h1><p class="error">' + esc(e.message) + '</p>', 'Inicio'); });
  }

  function tablaMovimientos(lista, compacta) {
    if (!lista.length) { return '<p class="vacio">Aún no hay movimientos.</p>'; }
    return '<div class="tabla-envoltura"><table class="tabla"><thead><tr><th scope="col">Fecha</th><th scope="col">Producto</th><th scope="col">Tipo</th>' +
      '<th scope="col" class="num">Cantidad</th><th scope="col" class="num">Stock</th>' +
      (compacta ? '' : '<th scope="col">Origen</th><th scope="col">Usuario</th><th scope="col">Frase original</th>') +
      '</tr></thead><tbody>' +
      lista.map(function (m) {
        return '<tr><td data-etiqueta="Fecha">' + esc(fechaHora.format(new Date(m.creadoEn))) + '</td>' +
          '<td data-etiqueta="Producto">' + esc(m.producto) + '</td>' +
          '<td data-etiqueta="Tipo">' + badgeTipo(m.tipo) + '</td>' +
          '<td data-etiqueta="Cantidad" class="num">' + (m.tipo === 'entrada' ? '+' : '−') + m.cantidad + '</td>' +
          '<td data-etiqueta="Stock" class="num">' + m.stockResultante + '</td>' +
          (compacta ? '' : '<td data-etiqueta="Origen">' + esc(ORIGENES[m.origen] || m.origen) + '</td>' +
            '<td data-etiqueta="Usuario">' + esc(m.usuario) + '</td>' +
            '<td data-etiqueta="Frase" class="frase">' + (m.textoOriginal ? '«' + esc(m.textoOriginal) + '»' : '—') + '</td>') +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ---------- Registrar movimiento (voz o texto) ---------- */
  var EJEMPLOS = ['Vendí 3 gaseosas de 400', 'Entraron 24 huevos', 'Se dañaron 2 panes', '¿Cuánto queda de arroz?'];

  function vistaRegistrar() {
    var Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
    render(
      '<h1>Registrar movimiento</h1>' +
      '<p class="sub">Di o escribe lo que pasó, revisa lo que entendió el sistema y confirma.</p>' +
      '<section class="tarjeta captura" aria-label="Captura de la instrucción">' +
        (Reconocimiento
          ? '<button type="button" class="mic" id="mic" aria-pressed="false" aria-describedby="mic-ayuda">' +
              '<i class="material-icons" aria-hidden="true">mic</i><span id="mic-texto">Toca y habla</span></button>' +
            '<p class="nota" id="mic-ayuda">Por ejemplo: «Vendí 3 gaseosas de 400». Toca otra vez para terminar.</p>'
          : '<p class="nota" id="mic-ayuda">Este navegador no permite dictar. Usa Chrome o Edge para hablar, o escribe la instrucción.</p>') +
        '<form id="form-texto" class="fila-instruccion" novalidate>' +
          '<label for="instruccion" class="' + (Reconocimiento ? 'visually-hidden' : '') + '">Instrucción</label>' +
          '<input id="instruccion" maxlength="300" autocomplete="off" placeholder="O escribe: Se vendieron 6 panes">' +
          '<button class="btn" type="submit">Interpretar</button>' +
        '</form>' +
        '<div class="ejemplos" aria-label="Ejemplos">' + EJEMPLOS.map(function (e) {
          return '<button type="button" class="chip" data-ejemplo="' + esc(e) + '">' + esc(e) + '</button>';
        }).join('') + '</div>' +
      '</section>' +
      '<section id="resultado" aria-live="polite"></section>', 'Registrar movimiento');

    var form = document.getElementById('form-texto');
    var entrada = document.getElementById('instruccion');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      interpretar(entrada.value, 'texto');
    });
    vista.querySelectorAll('[data-ejemplo]').forEach(function (b) {
      b.addEventListener('click', function () { entrada.value = b.getAttribute('data-ejemplo'); interpretar(entrada.value, 'texto'); });
    });

    if (Reconocimiento) { prepararVoz(Reconocimiento, entrada, function (texto) { interpretar(texto, 'voz'); }); }
  }

  // Dictado con la Web Speech API del navegador (Chrome/Edge). El audio lo procesa el
  // servicio de voz del navegador; el servidor de StockVoz solo recibe el texto.
  function prepararVoz(Reconocimiento, entrada, alTerminar) {
    var mic = document.getElementById('mic');
    var etiqueta = document.getElementById('mic-texto');
    var rec = new Reconocimiento();
    var escuchando = false;
    var final = '';
    rec.lang = 'es-CO';
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    function fijar(activo, texto) {
      escuchando = activo;
      mic.classList.toggle('escuchando', activo);
      mic.setAttribute('aria-pressed', String(activo));
      etiqueta.textContent = texto;
    }
    mic.addEventListener('click', function () {
      if (escuchando) { rec.stop(); return; }
      final = '';
      try { rec.start(); } catch (e) { /* ya estaba iniciado */ }
    });
    rec.onstart = function () { fijar(true, 'Escuchando… toca para terminar'); };
    rec.onresult = function (ev) {
      var parcial = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) { final += ev.results[i][0].transcript; } else { parcial += ev.results[i][0].transcript; }
      }
      entrada.value = (final + parcial).trim();
    };
    rec.onerror = function (ev) {
      var mensajes = {
        'not-allowed': 'Permite el uso del micrófono en el navegador para dictar.',
        'no-speech': 'No te escuché. Inténtalo de nuevo o escribe la instrucción.',
        'audio-capture': 'No se encontró un micrófono.',
        'network': 'El dictado necesita conexión a internet.'
      };
      avisar(mensajes[ev.error] || 'No se pudo usar el micrófono.', true);
    };
    rec.onend = function () {
      fijar(false, 'Toca y habla');
      if (final.trim()) { alTerminar(final.trim()); }
    };
  }

  function interpretar(texto, origen) {
    var zona = document.getElementById('resultado');
    if (!texto.trim()) { zona.innerHTML = '<div class="tarjeta"><p class="error">Escribe o dicta una instrucción.</p></div>'; return; }
    zona.innerHTML = '<div class="tarjeta"><p class="cargando">Interpretando «' + esc(texto) + '»…</p></div>';
    Promise.all([api('POST', '/api/interpretar', { texto: texto }), api('GET', '/api/productos')])
      .then(function (r) { mostrarPropuesta(zona, r[0], r[1], origen); })
      .catch(function (e) { zona.innerHTML = '<div class="tarjeta"><p class="error">' + esc(e.message) + '</p></div>'; });
  }

  function mostrarPropuesta(zona, r, productos, origen) {
    // Consulta que no se pudo resolver a un solo producto: se listan los que coinciden.
    if (r.tipo === 'consulta' && r.estado !== 'consulta') {
      zona.innerHTML = '<div class="tarjeta propuesta propuesta--ambiguo"><h2>Consulta</h2>' +
        (r.candidatos.length
          ? '<p>Coinciden varios productos:</p><ul class="lista" role="list">' + r.candidatos.map(function (c) {
              return '<li><span>' + esc(c.nombre) + '</span><span>' + c.stock + ' uds ' + badgeEstado(c.estado) + '</span></li>';
            }).join('') + '</ul>'
          : '<p>No encontré «' + esc(r.busqueda) + '» en el inventario.</p>') + '</div>';
      return;
    }
    if (r.estado === 'consulta') {
      zona.innerHTML = '<div class="tarjeta propuesta"><h2>Consulta</h2><p class="grande">Quedan <b>' + r.producto.stock + '</b> unidades de <b>' +
        esc(r.producto.nombre) + '</b> ' + badgeEstado(r.producto.estado) + '</p><p class="nota">Mínimo configurado: ' + r.producto.stockMinimo + '.</p></div>';
      return;
    }
    var esDueno = estado.sesion.rol === 'dueno';
    var mensajes = {
      ok: ['El sistema entendió:', 'Revisa y confirma. Puedes corregir cualquier dato antes de guardar.'],
      sin_cantidad: ['Falta la cantidad', 'Entendí el producto, pero no cuántas unidades. Escríbela abajo.'],
      ambiguo: ['¿Cuál de estos productos?', 'Hay varios productos que coinciden. Elige el correcto.'],
      sin_producto: ['No encontré ese producto', 'No hay ningún producto activo que coincida con «' + r.busqueda + '».'],
      no_entendido: ['No entendí la instrucción', 'Prueba con una frase como «Vendí 3 gaseosas» o «Entraron 10 panes», o completa los datos a mano.']
    };
    var m = mensajes[r.estado];
    var seleccionado = r.producto ? r.producto.id : '';

    zona.innerHTML =
      '<form class="tarjeta propuesta propuesta--' + esc(r.estado) + '" id="form-confirmar" novalidate>' +
        '<h2>' + esc(m[0]) + '</h2><p>' + esc(m[1]) + '</p>' +
        (r.texto ? '<p class="frase">«' + esc(r.texto) + '»</p>' : '') +
        (r.estado === 'ambiguo'
          ? '<div class="ejemplos">' + r.candidatos.map(function (c) {
              return '<button type="button" class="chip" data-candidato="' + c.id + '">' + esc(c.nombre) + ' · ' + c.stock + ' uds</button>';
            }).join('') + '</div>'
          : '') +
        (r.estado === 'sin_producto' && esDueno && r.busqueda
          ? '<p><a class="btn btn--blanco" href="#/inventario?nuevo=' + encodeURIComponent(r.busqueda) + '">Crear «' + esc(r.busqueda) + '» en el inventario</a></p>'
          : '') +
        '<div class="campos">' +
          '<div><label for="c-producto">Producto</label><select id="c-producto" required><option value="">Elige un producto</option>' +
            productos.map(function (p) {
              return '<option value="' + p.id + '"' + (p.id === seleccionado ? ' selected' : '') + '>' + esc(p.nombre) + ' (' + p.stock + ' uds)</option>';
            }).join('') + '</select></div>' +
          '<div><label for="c-cantidad">Cantidad</label><input id="c-cantidad" type="number" inputmode="numeric" min="1" max="100000" step="1" value="' + (r.cantidad || '') + '" required></div>' +
          '<fieldset><legend>Tipo</legend>' + Object.keys(TIPOS).map(function (t) {
            return '<label class="radio"><input type="radio" name="c-tipo" value="' + t + '"' + ((r.tipo || 'venta') === t ? ' checked' : '') + '> ' + TIPOS[t] + '</label>';
          }).join('') + '</fieldset>' +
        '</div>' +
        '<div id="error-confirmar"></div>' +
        '<div class="acciones"><button class="btn btn--grande" type="submit">Confirmar y guardar</button>' +
        '<button class="btn btn--blanco" type="button" id="cancelar">Cancelar</button></div>' +
      '</form>';

    var form = document.getElementById('form-confirmar');
    form.querySelectorAll('[data-candidato]').forEach(function (b) {
      b.addEventListener('click', function () {
        form.querySelector('#c-producto').value = b.getAttribute('data-candidato');
        form.querySelector('#c-cantidad').focus();
      });
    });
    document.getElementById('cancelar').addEventListener('click', function () {
      zona.innerHTML = '';
      document.getElementById('instruccion').focus();
    });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var zonaError = document.getElementById('error-confirmar');
      var productoId = Number(form.querySelector('#c-producto').value);
      var cantidad = Number(form.querySelector('#c-cantidad').value);
      var tipo = (form.querySelector('input[name=c-tipo]:checked') || {}).value;
      if (!productoId) { errorEn(zonaError, 'Elige el producto.'); form.querySelector('#c-producto').focus(); return; }
      if (!Number.isInteger(cantidad) || cantidad < 1) { errorEn(zonaError, 'La cantidad debe ser un número entero mayor que cero.'); form.querySelector('#c-cantidad').focus(); return; }
      var boton = form.querySelector('button[type=submit]');
      boton.disabled = true; // evita guardar dos veces con doble clic
      api('POST', '/api/movimientos', { productoId: productoId, cantidad: cantidad, tipo: tipo, origen: origen, textoOriginal: r.texto })
        .then(function (mov) { mostrarGuardado(zona, mov); })
        .catch(function (e) { errorEn(zonaError, e.message); boton.disabled = false; });
    });
    if (r.estado === 'ok') { form.querySelector('button[type=submit]').focus(); } else { zona.scrollIntoView({ block: 'nearest' }); }
  }

  function mostrarGuardado(zona, mov) {
    var p = mov.producto;
    zona.innerHTML = '<div class="tarjeta propuesta propuesta--guardado"><h2><i class="material-icons" aria-hidden="true">check_circle</i> ' +
      esc(TIPOS[mov.tipo]) + ' registrada</h2>' +
      '<p class="grande">' + esc(p.nombre) + ' · ' + mov.cantidad + ' uds. Stock: ' + mov.stockAnterior + ' → <b>' + p.stock + '</b> ' + badgeEstado(p.estado) + '</p>' +
      (p.estado !== 'ok' ? '<p class="alerta">Atención: ' + esc(p.nombre) + ' quedó por debajo de su mínimo (' + p.stockMinimo + ').</p>' : '') +
      '<div class="acciones"><button type="button" class="btn" id="otro">Registrar otro</button><a class="btn btn--blanco" href="#/panel">Ir al inicio</a></div></div>';
    var entrada = document.getElementById('instruccion');
    entrada.value = '';
    document.getElementById('otro').addEventListener('click', function () { zona.innerHTML = ''; entrada.focus(); });
    document.getElementById('otro').focus();
  }

  /* ---------- Inventario ---------- */
  function vistaInventario() {
    var esDueno = estado.sesion.rol === 'dueno';
    render(
      '<div class="encabezado"><div><h1>Inventario</h1><p class="sub">El stock cambia solo con movimientos; así el historial siempre cuadra.</p></div>' +
      (esDueno ? '<button type="button" class="btn btn--grande" id="nuevo"><i class="material-icons" aria-hidden="true">add</i>Nuevo producto</button>' : '') + '</div>' +
      '<div class="filtros">' +
        '<label for="buscar" class="visually-hidden">Buscar producto</label><input id="buscar" type="search" placeholder="Buscar producto…">' +
        '<label class="radio"><input type="checkbox" id="ver-inactivos"> Mostrar desactivados</label>' +
      '</div>' +
      '<div id="lista-productos"><p class="cargando">Cargando productos…</p></div>' +
      dialogoProducto(), 'Inventario');

    var productos = [];
    var buscar = document.getElementById('buscar');
    var inactivos = document.getElementById('ver-inactivos');

    function cargar() {
      api('GET', '/api/productos' + (inactivos.checked ? '?inactivos=1' : '')).then(function (lista) {
        productos = lista;
        pintar();
      }).catch(function (e) { errorEn(document.getElementById('lista-productos'), e.message); });
    }

    function pintar() {
      var q = buscar.value.trim().toLowerCase();
      var visibles = productos.filter(function (p) { return p.nombre.toLowerCase().indexOf(q) !== -1; });
      var zona = document.getElementById('lista-productos');
      if (!visibles.length) {
        zona.innerHTML = '<p class="vacio">' + (productos.length ? 'Ningún producto coincide con la búsqueda.' : 'Aún no hay productos.' + (esDueno ? ' Crea el primero con «Nuevo producto».' : '')) + '</p>';
        return;
      }
      zona.innerHTML = '<div class="tabla-envoltura"><table class="tabla"><thead><tr><th scope="col">Producto</th><th scope="col" class="num">Precio</th>' +
        '<th scope="col" class="num">Stock</th><th scope="col" class="num">Mínimo</th><th scope="col">Estado</th>' + (esDueno ? '<th scope="col"><span class="visually-hidden">Acciones</span></th>' : '') + '</tr></thead><tbody>' +
        visibles.map(function (p) {
          return '<tr class="' + (p.activo ? '' : 'inactivo') + '"><td data-etiqueta="Producto"><b>' + esc(p.nombre) + '</b>' + (p.activo ? '' : ' <small>(desactivado)</small>') + '</td>' +
            '<td data-etiqueta="Precio" class="num">' + esc(pesos.format(p.precio)) + '</td>' +
            '<td data-etiqueta="Stock" class="num">' + p.stock + '</td>' +
            '<td data-etiqueta="Mínimo" class="num">' + p.stockMinimo + '</td>' +
            '<td data-etiqueta="Estado">' + badgeEstado(p.estado) + '</td>' +
            (esDueno ? '<td class="acciones-fila"><button type="button" class="enlace" data-editar="' + p.id + '">Editar<span class="visually-hidden"> ' + esc(p.nombre) + '</span></button>' +
              '<button type="button" class="enlace" data-activo="' + p.id + '">' + (p.activo ? 'Desactivar' : 'Activar') + '<span class="visually-hidden"> ' + esc(p.nombre) + '</span></button></td>' : '') +
            '</tr>';
        }).join('') + '</tbody></table></div>';

      zona.querySelectorAll('[data-editar]').forEach(function (b) {
        b.addEventListener('click', function () { abrirDialogo(buscarProducto(b.getAttribute('data-editar')), b); });
      });
      zona.querySelectorAll('[data-activo]').forEach(function (b) {
        b.addEventListener('click', function () {
          var p = buscarProducto(b.getAttribute('data-activo'));
          api('PATCH', '/api/productos/' + p.id, { activo: !p.activo }).then(function () {
            avisar(p.nombre + (p.activo ? ' quedó desactivado. Sus movimientos se conservan.' : ' está activo de nuevo.'));
            cargar();
          }).catch(function (e) { avisar(e.message, true); });
        });
      });
    }

    function buscarProducto(id) {
      return productos.find(function (p) { return p.id === Number(id); });
    }

    var dialogo = document.getElementById('dlg-producto');
    var formP = document.getElementById('form-producto');
    var editando = null;
    var origenFoco = null;

    function abrirDialogo(p, desde) {
      editando = p || null;
      origenFoco = desde || null;
      formP.reset();
      errorEn(document.getElementById('error-producto'), '');
      document.getElementById('dlg-titulo').textContent = p ? 'Editar producto' : 'Nuevo producto';
      document.getElementById('campo-stock').hidden = Boolean(p);
      if (p) {
        formP.p_nombre.value = p.nombre;
        formP.p_precio.value = p.precio;
        formP.p_minimo.value = p.stockMinimo;
      } else if (typeof desde === 'string') {
        formP.p_nombre.value = desde;
      }
      dialogo.showModal();
      formP.p_nombre.focus();
    }

    dialogo.addEventListener('close', function () { if (origenFoco && origenFoco.focus) { origenFoco.focus(); } });
    document.getElementById('dlg-cancelar').addEventListener('click', function () { dialogo.close(); });
    formP.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var datos = {
        nombre: formP.p_nombre.value,
        precio: Number(formP.p_precio.value || 0),
        stockMinimo: Number(formP.p_minimo.value || 0)
      };
      if (!editando) { datos.stock = Number(formP.p_stock.value || 0); }
      var peticion = editando ? api('PATCH', '/api/productos/' + editando.id, datos) : api('POST', '/api/productos', datos);
      peticion.then(function (p) {
        dialogo.close();
        avisar(editando ? 'Cambios guardados.' : p.nombre + ' quedó en el inventario.');
        cargar();
      }).catch(function (e) { errorEn(document.getElementById('error-producto'), e.message); });
    });

    if (esDueno) { document.getElementById('nuevo').addEventListener('click', function (ev) { abrirDialogo(null, ev.currentTarget); }); }
    buscar.addEventListener('input', pintar);
    inactivos.addEventListener('change', cargar);
    cargar();

    // Llegada desde "Crear «chocolatinas»" en Registrar o tras crear la cuenta.
    var nuevo = parametro('nuevo');
    if (nuevo && esDueno) { abrirDialogo(null, nuevo === '1' ? document.getElementById('nuevo') : nuevo); }
  }

  function dialogoProducto() {
    return '<dialog id="dlg-producto" aria-labelledby="dlg-titulo"><form id="form-producto" class="form" novalidate>' +
      '<h2 id="dlg-titulo">Nuevo producto</h2>' +
      '<label for="p_nombre">Nombre</label><input id="p_nombre" name="p_nombre" maxlength="80" required placeholder="Ej.: Gaseosa 1,5 L">' +
      '<label for="p_precio">Precio de venta (COP)</label><input id="p_precio" name="p_precio" type="number" inputmode="numeric" min="0" step="1" placeholder="0">' +
      '<div id="campo-stock"><label for="p_stock">Stock inicial</label><input id="p_stock" name="p_stock" type="number" inputmode="numeric" min="0" step="1" placeholder="0"></div>' +
      '<label for="p_minimo">Stock mínimo <small>(debajo de este número se genera alerta)</small></label><input id="p_minimo" name="p_minimo" type="number" inputmode="numeric" min="0" step="1" placeholder="0">' +
      '<div id="error-producto"></div>' +
      '<div class="acciones"><button class="btn" type="submit">Guardar</button><button class="btn btn--blanco" type="button" id="dlg-cancelar">Cancelar</button></div>' +
      '</form></dialog>';
  }

  /* ---------- Movimientos ---------- */
  function vistaMovimientos() {
    var tipo = parametro('tipo') || '';
    render(
      '<h1>Movimientos</h1><p class="sub">Historial de ventas, entradas y mermas, con la frase original de cada registro.</p>' +
      '<div class="filtros" role="group" aria-label="Filtrar por tipo">' +
        [['', 'Todos'], ['venta', 'Ventas'], ['entrada', 'Entradas'], ['merma', 'Mermas']].map(function (f) {
          return '<a class="chip' + (f[0] === tipo ? ' chip--activo' : '') + '" href="#/movimientos' + (f[0] ? '?tipo=' + f[0] : '') + '"' +
            (f[0] === tipo ? ' aria-current="true"' : '') + '>' + f[1] + '</a>';
        }).join('') +
      '</div><div id="lista-mov" class="tarjeta"><p class="cargando">Cargando…</p></div>', 'Movimientos');
    api('GET', '/api/movimientos?limite=200' + (tipo ? '&tipo=' + tipo : '')).then(function (lista) {
      document.getElementById('lista-mov').innerHTML = tablaMovimientos(lista, false);
    }).catch(function (e) { errorEn(document.getElementById('lista-mov'), e.message); });
  }

  /* ---------- Reportes ---------- */
  function vistaReportes() {
    var dias = parametro('dias') === '30' ? 30 : 7;
    render('<h1>Reportes</h1><p class="cargando">Calculando…</p>', 'Reportes');
    api('GET', '/api/reportes?dias=' + dias).then(function (r) {
      var masDanado = r.topMermas[0];
      render(
        '<div class="encabezado"><div><h1>Reportes</h1><p class="sub">Del ' + esc(r.desde) + ' al ' + esc(r.hasta) + '</p></div>' +
        '<button type="button" class="btn btn--blanco no-imprimir" id="imprimir"><i class="material-icons" aria-hidden="true">picture_as_pdf</i>Exportar PDF</button></div>' +
        '<div class="filtros no-imprimir" role="group" aria-label="Periodo">' +
          '<a class="chip' + (dias === 7 ? ' chip--activo" aria-current="true' : '') + '" href="#/reportes?dias=7">Últimos 7 días</a>' +
          '<a class="chip' + (dias === 30 ? ' chip--activo" aria-current="true' : '') + '" href="#/reportes?dias=30">Últimos 30 días</a>' +
        '</div>' +
        '<div class="kpis">' +
          '<div class="kpi kpi--sol"><span>Total vendido</span><b>' + esc(pesos.format(r.vendido.valor || 0)) + '</b></div>' +
          '<div class="kpi"><span>Unidades vendidas</span><b>' + (r.vendido.unidades || 0) + '</b></div>' +
          '<div class="kpi' + (r.mermas.unidades ? ' kpi--alerta' : '') + '"><span>Mermas</span><b>' + (r.mermas.unidades || 0) + ' uds</b><small>' + esc(pesos.format(r.mermas.valor || 0)) + ' estimado</small></div>' +
          '<div class="kpi"><span>Producto que más se dañó</span><b class="kpi-texto">' + (masDanado ? esc(masDanado.nombre) : '—') + '</b></div>' +
        '</div>' +
        '<div class="rejilla">' + ranking('Más vendidos', r.topVendidos, 'venta') + ranking('Más mermas', r.topMermas, 'merma') + '</div>' +
        '<p class="nota">Los valores se calculan con el precio vigente al momento de cada movimiento. Las mermas se valoran al precio de venta.</p>',
        'Reportes');
      document.getElementById('imprimir').addEventListener('click', function () { window.print(); });
    }).catch(function (e) { render('<h1>Reportes</h1><p class="error">' + esc(e.message) + '</p>', 'Reportes'); });
  }

  function ranking(titulo, lista, tipo) {
    var max = Math.max.apply(null, lista.map(function (x) { return x.unidades; }).concat([1]));
    return '<section class="tarjeta"><h2>' + esc(titulo) + '</h2>' +
      (lista.length
        ? '<ol class="ranking" role="list">' + lista.map(function (x) {
            return '<li><span class="ranking-nombre">' + esc(x.nombre) + '</span><span class="ranking-barra ranking-barra--' + tipo + '" data-medida="--ancho:' +
              Math.round((x.unidades / max) * 100) + '" aria-hidden="true"></span><span class="ranking-valor">' + x.unidades + ' uds · ' + esc(pesos.format(x.valor)) + '</span></li>';
          }).join('') + '</ol>'
        : '<p class="vacio">Sin datos en este periodo.</p>') +
      '</section>';
  }

  /* ---------- Arranque ---------- */
  Promise.all([
    api('GET', '/api/config').catch(function () { return { demo: false }; }),
    api('GET', '/api/sesion').catch(function () { return null; })
  ]).then(function (r) {
    estado.config = r[0];
    estado.sesion = r[1];
    enrutar();
  });
})();
