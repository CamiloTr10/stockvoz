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
  // Fecha del calendario en Colombia ("2026-11-04"), igual que fechaLocal() en el servidor.
  var fechaCalendario = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });

  var TIPOS = { venta: 'Venta', entrada: 'Entrada', merma: 'Merma' };
  var ESTADOS = { ok: 'OK', bajo: 'Bajo', agotado: 'Agotado' };
  var ORIGENES = { voz: 'Voz', texto: 'Texto', manual: 'Manual', inicial: 'Stock inicial' };
  var ROLES = { dueno: 'Dueño', encargado: 'Encargado' };

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

  // Pregunta antes de una acción que no se puede deshacer. Devuelve una promesa con true o false.
  // Se resuelve desde los propios botones y desde 'cancel' (tecla Escape): hay navegadores que no
  // disparan 'close' al cerrar el diálogo, así que depender de ese evento deja la acción colgada.
  function confirmar(titulo, texto, textoSi) {
    var dialogo = document.getElementById('dlg-confirmar');
    var si = document.getElementById('confirmar-si');
    var no = document.getElementById('confirmar-no');
    var origenFoco = document.activeElement;
    document.getElementById('confirmar-titulo').textContent = titulo;
    document.getElementById('confirmar-texto').textContent = texto;
    si.textContent = textoSi || 'Confirmar';
    dialogo.showModal();
    return new Promise(function (resolver) {
      function terminar(ok) {
        si.removeEventListener('click', alSi);
        no.removeEventListener('click', alNo);
        dialogo.removeEventListener('cancel', alNo);
        if (dialogo.open) { dialogo.close(); }
        if (origenFoco && origenFoco.focus) { origenFoco.focus(); }
        resolver(ok);
      }
      function alSi() { terminar(true); }
      function alNo() { terminar(false); }
      si.addEventListener('click', alSi);
      no.addEventListener('click', alNo);
      dialogo.addEventListener('cancel', alNo);
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
    document.getElementById('btn-equipo').hidden = !(s && s.rol === 'dueno');
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
  document.getElementById('btn-equipo').addEventListener('click', function () { location.hash = '#/equipo'; });

  var RUTAS = {
    '#/ingresar': vistaIngreso,
    '#/registro': vistaRegistro,
    '#/negocio': vistaNegocio,
    '#/unirme': vistaUnirme,
    '#/equipo': vistaEquipo,
    '#/panel': vistaPanel,
    '#/registrar': vistaRegistrar,
    '#/recolectar': vistaRecolectar,
    '#/inventario': vistaInventario,
    '#/movimientos': vistaMovimientos,
    '#/reportes': vistaReportes
  };
  var PUBLICAS = ['#/ingresar', '#/registro'];
  var SIN_NEGOCIO = ['#/negocio', '#/unirme'];

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
    // Sin negocio activo solo se puede elegir uno o unirse a otro con un código.
    if (estado.sesion && !estado.sesion.negocio && SIN_NEGOCIO.indexOf(ruta) === -1) { location.hash = '#/negocio'; return; }
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

  // Dos modos: crear tu propio negocio, o entrar al de alguien más con un código de invitación.
  // El enlace que comparte el dueño trae el código: #/registro?codigo=ABCD-EFGH
  function vistaRegistro() {
    var codigo = parametro('codigo');
    var invitado = codigo !== null;
    render(
      '<section class="acceso">' +
        '<div class="acceso-marca"><img src="logo.svg" alt="" width="56" height="56"><h1>Crear cuenta</h1>' +
        '<p>' + (invitado
          ? 'Vas a entrar al negocio que te invitó. El dueño decide qué puedes hacer.'
          : 'Tu negocio tendrá su propio espacio: sus datos no se mezclan con los de otros negocios.') + '</p></div>' +
        '<form id="form-registro" class="tarjeta form" novalidate>' +
          (invitado
            ? '<label for="codigo">Código de invitación</label><input id="codigo" class="entrada-codigo" maxlength="20" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="ABCD-EFGH" value="' + esc(codigo) + '" required>'
            : '<label for="negocio">Nombre del negocio</label><input id="negocio" maxlength="80" autocomplete="organization" required>') +
          '<label for="nombre">Tu nombre</label><input id="nombre" maxlength="80" autocomplete="name" required>' +
          '<label for="correo">Correo</label><input id="correo" type="email" maxlength="120" autocomplete="email" required>' +
          '<label for="clave">Contraseña <small>(mínimo 8 caracteres)</small></label><input id="clave" type="password" minlength="8" autocomplete="new-password" required>' +
          '<div id="error-registro"></div>' +
          '<button class="btn btn--grande" type="submit">Crear cuenta</button>' +
          '<p class="nota">' + (invitado
            ? '¿Vas a abrir tu propio negocio? <a href="#/registro">Créalo aquí</a>'
            : '¿Te invitaron a un negocio? <a href="#/registro?codigo=">Entra con el código</a>') + '</p>' +
          '<p class="nota">¿Ya tienes cuenta? <a href="#/ingresar">Ingresar</a></p>' +
        '</form>' +
      '</section>', 'Crear cuenta');

    var form = document.getElementById('form-registro');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var zona = document.getElementById('error-registro');
      if (form.clave.value.length < 8) { errorEn(zona, 'La contraseña debe tener al menos 8 caracteres.'); return; }
      var datos = { nombre: form.nombre.value, correo: form.correo.value, clave: form.clave.value };
      if (invitado) { datos.codigo = form.codigo.value; } else { datos.negocio = form.negocio.value; }
      api('POST', '/api/registro', datos).then(function (s) {
        estado.sesion = s;
        if (invitado) {
          avisar('Listo, ya haces parte de ' + s.negocios[0].nombre + '.');
          location.hash = '#/panel';
        } else {
          avisar('Cuenta creada. Empieza agregando tus productos.');
          location.hash = '#/inventario?nuevo=1';
        }
      }).catch(function (e) { errorEn(zona, e.message); });
    });
    if (invitado && !codigo) { document.getElementById('codigo').focus(); }
  }

  function vistaNegocio() {
    var s = estado.sesion;
    render(
      '<section class="acceso">' +
        '<div class="acceso-marca"><h1>' + (s.negocios.length ? '¿En qué negocio vas a trabajar?' : 'Todavía no estás en ningún negocio') + '</h1>' +
        '<p>Hola, ' + esc(s.usuario.nombre) + '. ' + (s.negocios.length
          ? 'Tienes acceso a ' + s.negocios.length + (s.negocios.length === 1 ? ' negocio.' : ' negocios.')
          : 'Pídele al dueño del negocio un código de invitación.') + '</p></div>' +
        '<ul class="lista-negocios" role="list">' +
        s.negocios.map(function (n) {
          return '<li><button type="button" class="tarjeta negocio-btn" data-id="' + n.id + '"><b>' + esc(n.nombre) + '</b><span>' +
            (n.rol === 'dueno' ? 'Dueño' : 'Encargado') + '</span></button></li>';
        }).join('') +
        '</ul>' +
        '<p class="nota"><a href="#/unirme">Tengo un código de invitación para otro negocio</a></p>' +
      '</section>', 'Elegir negocio');

    vista.querySelectorAll('.negocio-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        api('POST', '/api/sesion/negocio', { negocioId: Number(b.getAttribute('data-id')) })
          .then(function (sesion) { estado.sesion = sesion; location.hash = '#/panel'; })
          .catch(function (e) { avisar(e.message, true); });
      });
    });
  }

  function copiar(texto, queEs) {
    if (!navigator.clipboard) { avisar('Tu navegador no permite copiar solo. Selecciona el ' + queEs + ' y cópialo a mano.', true); return; }
    navigator.clipboard.writeText(texto).then(
      function () { avisar(queEs.charAt(0).toUpperCase() + queEs.slice(1) + ' copiado.'); },
      function () { avisar('No se pudo copiar. Selecciónalo y cópialo a mano.', true); }
    );
  }

  // Pantalla para escribir un código de invitación teniendo ya una cuenta.
  function vistaUnirme() {
    render(
      '<section class="acceso">' +
        '<div class="acceso-marca"><h1>Unirme a un negocio</h1><p>Escribe el código que te pasó el dueño del negocio.</p></div>' +
        '<form id="form-unirme" class="tarjeta form" novalidate>' +
          '<label for="codigo">Código de invitación</label>' +
          '<input id="codigo" class="entrada-codigo" maxlength="20" required placeholder="ABCD-EFGH" autocomplete="off" spellcheck="false" autocapitalize="characters">' +
          '<div id="error-unirme"></div>' +
          '<button class="btn btn--grande" type="submit">Unirme</button>' +
          '<p class="nota"><a href="#/negocio">Volver</a></p>' +
        '</form>' +
      '</section>', 'Unirme a un negocio');

    var form = document.getElementById('form-unirme');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var zona = document.getElementById('error-unirme');
      var boton = form.querySelector('button[type=submit]');
      boton.disabled = true;
      api('POST', '/api/invitaciones/aceptar', { codigo: form.codigo.value }).then(function (sesion) {
        estado.sesion = sesion;
        avisar('Listo, ya haces parte del negocio.');
        location.hash = sesion.negocio ? '#/panel' : '#/negocio';
      }).catch(function (e) { errorEn(zona, e.message); boton.disabled = false; });
    });
    document.getElementById('codigo').focus();
  }

  // Equipo del negocio: quién entra, con qué permisos, e invitaciones pendientes. Solo el dueño.
  function vistaEquipo() {
    render(
      '<div class="encabezado"><div><h1>Equipo</h1><p class="sub">Quién puede entrar a este negocio y con qué permisos.</p></div></div>' +
      '<div class="tarjeta">' +
        '<h2>Invitar a alguien</h2>' +
        '<p class="sub">Genera un código y pásaselo por WhatsApp o dictándoselo. Sirve una sola vez y vence a los 7 días.</p>' +
        '<div class="acciones">' +
          '<label for="rol-invitar" class="visually-hidden">Permisos de la persona invitada</label>' +
          '<select id="rol-invitar">' +
            '<option value="encargado">Encargado: registra ventas, entradas y mermas</option>' +
            '<option value="dueno">Dueño: además administra productos y el equipo</option>' +
          '</select>' +
          '<button type="button" class="btn" id="btn-generar">Generar código</button>' +
        '</div>' +
        '<div id="zona-codigo"></div>' +
      '</div>' +
      '<div id="zona-equipo" class="tarjeta"><p class="cargando">Cargando…</p></div>', 'Equipo');

    var zona = document.getElementById('zona-equipo');
    var zonaCodigo = document.getElementById('zona-codigo');

    function cargar() {
      api('GET', '/api/equipo').then(function (d) {
        zona.innerHTML =
          '<h2>Quién tiene acceso</h2>' +
          '<div class="tabla-envoltura"><table class="tabla"><thead><tr><th scope="col">Persona</th><th scope="col">Correo</th>' +
          '<th scope="col">Permisos</th><th scope="col"><span class="visually-hidden">Acciones</span></th></tr></thead><tbody>' +
          d.miembros.map(function (m) {
            var yo = estado.sesion && m.id === estado.sesion.usuario.id;
            return '<tr><td data-etiqueta="Persona"><b>' + esc(m.nombre) + '</b>' + (yo ? ' <small>(tú)</small>' : '') + '</td>' +
              '<td data-etiqueta="Correo">' + esc(m.correo) + '</td>' +
              '<td data-etiqueta="Permisos">' + esc(ROLES[m.rol] || m.rol) + '</td>' +
              '<td class="acciones-fila">' + (yo ? '' : '<button type="button" class="enlace enlace--peligro" data-quitar="' + m.id +
                '" data-nombre="' + esc(m.nombre) + '">Quitar<span class="visually-hidden"> a ' + esc(m.nombre) + '</span></button>') + '</td></tr>';
          }).join('') + '</tbody></table></div>' +
          '<h2>Invitaciones pendientes</h2>' +
          (d.invitaciones.length
            ? '<div class="tabla-envoltura"><table class="tabla"><thead><tr><th scope="col">Permisos</th><th scope="col">Creada</th>' +
              '<th scope="col">Vence</th><th scope="col"><span class="visually-hidden">Acciones</span></th></tr></thead><tbody>' +
              d.invitaciones.map(function (i) {
                return '<tr><td data-etiqueta="Permisos">' + esc(ROLES[i.rol] || i.rol) + '</td>' +
                  '<td data-etiqueta="Creada">' + esc(fechaHora.format(new Date(i.creadaEn))) + '</td>' +
                  '<td data-etiqueta="Vence">' + esc(fechaHora.format(new Date(i.expiraEn))) + '</td>' +
                  '<td class="acciones-fila"><button type="button" class="enlace enlace--peligro" data-cancelar="' + i.id + '">Cancelar</button></td></tr>';
              }).join('') + '</tbody></table></div>'
            : '<p class="vacio">No hay invitaciones pendientes.</p>');

        zona.querySelectorAll('[data-quitar]').forEach(function (b) {
          b.addEventListener('click', function () {
            var nombre = b.getAttribute('data-nombre');
            confirmar('¿Quitar a ' + nombre + '?',
              nombre + ' dejará de ver este negocio de inmediato. Los movimientos que registró se conservan en el historial.',
              'Sí, quitar').then(function (ok) {
                if (!ok) { return; }
                api('DELETE', '/api/equipo/miembros/' + b.getAttribute('data-quitar'))
                  .then(function () { avisar(nombre + ' ya no tiene acceso a este negocio.'); cargar(); })
                  .catch(function (e) { avisar(e.message, true); });
              });
          });
        });
        zona.querySelectorAll('[data-cancelar]').forEach(function (b) {
          b.addEventListener('click', function () {
            api('DELETE', '/api/equipo/invitaciones/' + b.getAttribute('data-cancelar'))
              .then(function () { avisar('Invitación cancelada: ese código ya no sirve.'); cargar(); })
              .catch(function (e) { avisar(e.message, true); });
          });
        });
      }).catch(function (e) { errorEn(zona, e.message); });
    }

    document.getElementById('btn-generar').addEventListener('click', function (ev) {
      var boton = ev.currentTarget;
      boton.disabled = true;
      api('POST', '/api/equipo/invitaciones', { rol: document.getElementById('rol-invitar').value }).then(function (inv) {
        var enlace = location.origin + location.pathname + '#/registro?codigo=' + encodeURIComponent(inv.codigo);
        zonaCodigo.innerHTML = '<div class="codigo-caja">' +
          '<p class="etiqueta-codigo">Código para <b>' + esc(ROLES[inv.rol] || inv.rol) + '</b> · vence el ' + esc(fechaHora.format(new Date(inv.expiraEn))) + '</p>' +
          '<p class="codigo">' + esc(inv.codigo) + '</p>' +
          '<div class="acciones"><button type="button" class="btn btn--blanco" id="copiar-codigo">Copiar código</button>' +
          '<button type="button" class="btn btn--blanco" id="copiar-enlace">Copiar enlace</button></div>' +
          '<p class="nota">Anótalo ahora: por seguridad el código no se vuelve a mostrar. Quien lo use entrará como ' +
          esc((ROLES[inv.rol] || inv.rol).toLowerCase()) + '.</p></div>';
        document.getElementById('copiar-codigo').addEventListener('click', function () { copiar(inv.codigo, 'código'); });
        document.getElementById('copiar-enlace').addEventListener('click', function () { copiar(enlace, 'enlace'); });
        boton.disabled = false;
        cargar();
      }).catch(function (e) { boton.disabled = false; avisar(e.message, true); });
    });

    cargar();
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

  // El dueño puede anular cualquier movimiento; el encargado, solo los suyos de hoy.
  // El servidor vuelve a comprobarlo: esto solo decide si se dibuja el botón.
  function puedeAnular(m) {
    if (m.anuladoEn || !estado.sesion) { return false; }
    if (estado.sesion.rol === 'dueno') { return true; }
    return m.usuarioId === estado.sesion.usuario.id &&
      fechaCalendario.format(new Date(m.creadoEn)) === fechaCalendario.format(new Date());
  }

  function tablaMovimientos(lista, compacta) {
    if (!lista.length) { return '<p class="vacio">Aún no hay movimientos.</p>'; }
    return '<div class="tabla-envoltura"><table class="tabla"><thead><tr><th scope="col">Fecha</th><th scope="col">Producto</th><th scope="col">Tipo</th>' +
      '<th scope="col" class="num">Cantidad</th><th scope="col" class="num">Stock</th>' +
      (compacta ? '' : '<th scope="col">Origen</th><th scope="col">Usuario</th><th scope="col">Frase original</th><th scope="col"><span class="visually-hidden">Acciones</span></th>') +
      '</tr></thead><tbody>' +
      lista.map(function (m) {
        return '<tr' + (m.anuladoEn ? ' class="mov--anulado"' : '') + '><td data-etiqueta="Fecha">' + esc(fechaHora.format(new Date(m.creadoEn))) + '</td>' +
          '<td data-etiqueta="Producto">' + esc(m.producto) + '</td>' +
          '<td data-etiqueta="Tipo">' + badgeTipo(m.tipo) + (m.anuladoEn ? ' <span class="pill pill--anulado">Anulado</span>' : '') + '</td>' +
          '<td data-etiqueta="Cantidad" class="num">' + (m.tipo === 'entrada' ? '+' : '−') + m.cantidad + '</td>' +
          '<td data-etiqueta="Stock" class="num">' + m.stockResultante + '</td>' +
          (compacta ? '' : '<td data-etiqueta="Origen">' + esc(ORIGENES[m.origen] || m.origen) + '</td>' +
            '<td data-etiqueta="Usuario">' + esc(m.usuario) + '</td>' +
            '<td data-etiqueta="Frase" class="frase">' + (m.textoOriginal ? '«' + esc(m.textoOriginal) + '»' : '—') + '</td>' +
            '<td class="acciones-fila">' + (m.anuladoEn
              ? '<small class="nota-anulado">Anulado' + (m.anuladoPor ? ' por ' + esc(m.anuladoPor) : '') + '</small>'
              : (puedeAnular(m)
                ? '<button type="button" class="enlace enlace--peligro" data-anular="' + m.id + '">Anular<span class="visually-hidden"> ' +
                  esc((TIPOS[m.tipo] || m.tipo) + ' de ' + m.cantidad + ' ' + m.producto) + '</span></button>'
                : '')) + '</td>') +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ---------- Registrar movimiento (voz o texto) ---------- */
  var EJEMPLOS = ['Vendí 3 gaseosas de 400', 'Entraron 24 huevos', 'Se dañaron 2 panes', '¿Cuánto queda de arroz?'];

  function vistaRegistrar() {
    var motor = motorDeVoz();
    render(
      '<h1>Registrar movimiento</h1>' +
      '<p class="sub">Di o escribe lo que pasó, revisa lo que entendió el sistema y confirma.</p>' +
      '<section class="tarjeta captura" aria-label="Captura de la instrucción">' +
        (motor
          ? '<button type="button" class="mic" id="mic" aria-pressed="false" aria-describedby="mic-ayuda">' +
              '<i class="material-icons" aria-hidden="true">mic</i><span id="mic-texto">Toca y habla</span></button>' +
            '<p class="nota" id="mic-ayuda">Por ejemplo: «Vendí 3 gaseosas de 400». Toca otra vez para terminar.</p>'
          : '<p class="nota" id="mic-ayuda">Este navegador no permite dictar. Escribe la instrucción.</p>') +
        '<form id="form-texto" class="fila-instruccion" novalidate>' +
          '<label for="instruccion" class="' + (motor ? 'visually-hidden' : '') + '">Instrucción</label>' +
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

    prepararDictado(motor, entrada, function (texto) { interpretar(texto, 'voz'); });
  }

  // Cuál de los dos dictados se puede usar. Se prefiere el del servidor (Whisper): funciona en
  // cualquier navegador y el audio no pasa por el servicio de voz del navegador. El de la Web
  // Speech API queda como respaldo, igual que las reglas son el respaldo de la IA: si el
  // proveedor está caído, el tendero sigue pudiendo dictar en Chrome.
  function motorDeVoz() {
    if (estado.config.voz && window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return 'servidor';
    }
    return (window.SpeechRecognition || window.webkitSpeechRecognition) ? 'navegador' : null;
  }

  function prepararDictado(motor, entrada, alTerminar) {
    if (motor === 'servidor') { return prepararVozServidor(entrada, alTerminar); }
    if (motor === 'navegador') { return prepararVoz(window.SpeechRecognition || window.webkitSpeechRecognition, entrada, alTerminar); }
  }

  // Formatos que graban los navegadores, en el orden en que los preferimos. El servidor solo
  // acepta estos, así que si no hay ninguno no se ofrece el micrófono.
  var FORMATOS_AUDIO = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  // Un dictado de mostrador dura segundos. El corte evita mandar un archivo enorme si alguien
  // deja el micrófono abierto sin darse cuenta.
  var MAX_SEGUNDOS = 60;

  // Dictado grabando el audio y transcribiéndolo en el servidor con Whisper.
  function prepararVozServidor(entrada, alTerminar) {
    var mic = document.getElementById('mic');
    var etiqueta = document.getElementById('mic-texto');
    if (!mic) { return; }
    var grabadora = null;
    var corte = null;

    var formato = FORMATOS_AUDIO.filter(function (f) { return MediaRecorder.isTypeSupported(f); })[0];
    if (!formato) {
      // El navegador graba, pero en nada que el servidor acepte: mejor el dictado del navegador.
      var Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (Reconocimiento) { return prepararVoz(Reconocimiento, entrada, alTerminar); }
      mic.disabled = true;
      return;
    }

    function fijar(activo, texto, ocupado) {
      mic.classList.toggle('escuchando', activo);
      mic.setAttribute('aria-pressed', String(activo));
      mic.disabled = Boolean(ocupado);
      etiqueta.textContent = texto;
    }

    function detener() {
      if (corte) { clearTimeout(corte); corte = null; }
      if (grabadora && grabadora.state !== 'inactive') { grabadora.stop(); }
    }

    mic.addEventListener('click', function () {
      if (grabadora && grabadora.state === 'recording') { detener(); return; }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (pista) {
        var trozos = [];
        grabadora = new MediaRecorder(pista, { mimeType: formato });
        grabadora.ondataavailable = function (ev) { if (ev.data && ev.data.size) { trozos.push(ev.data); } };
        grabadora.onstop = function () {
          // Soltar el micrófono apaga el indicador del navegador: el tendero tiene que ver
          // que ya no se le está grabando.
          pista.getTracks().forEach(function (t) { t.stop(); });
          fijar(false, 'Transcribiendo…', true);
          transcribir(new Blob(trozos, { type: formato }), formato)
            .then(function (texto) {
              fijar(false, 'Toca y habla');
              if (!texto) { avisar('No te escuché. Inténtalo de nuevo o escribe la instrucción.', true); return; }
              entrada.value = texto;
              alTerminar(texto);
            })
            .catch(function (e) {
              fijar(false, 'Toca y habla');
              avisar(e.message, true);
            });
        };
        grabadora.start();
        fijar(true, 'Escuchando… toca para terminar');
        corte = setTimeout(detener, MAX_SEGUNDOS * 1000);
      }).catch(function () {
        avisar('Permite el uso del micrófono en el navegador para dictar.', true);
      });
    });
  }

  // El audio viaja en base64 dentro del JSON, no como binario, para que esta llamada conserve
  // la misma protección contra CSRF que el resto de la API.
  function transcribir(blob, formato) {
    return new Promise(function (resolver, rechazar) {
      var lector = new FileReader();
      lector.onerror = function () { rechazar(new Error('No se pudo leer la grabación.')); };
      lector.onload = function () {
        var base64 = String(lector.result).split(',')[1] || '';
        api('POST', '/api/transcribir', { audio: base64, tipo: formato })
          .then(function (r) { resolver((r.texto || '').trim()); })
          .catch(rechazar);
      };
      lector.readAsDataURL(blob);
    });
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

  var MENSAJES = {
    ok: ['El sistema entendió:', 'Revisa y confirma. Puedes corregir cualquier dato antes de guardar.'],
    sin_cantidad: ['Falta la cantidad', 'Entendí el producto, pero no cuántas unidades. Escríbela abajo.'],
    ambiguo: ['¿Cuál de estos productos?', 'Hay varios productos que coinciden. Elige el correcto.'],
    sin_producto: ['No encontré ese producto', 'No hay ningún producto activo que coincida.'],
    no_entendido: ['No entendí la instrucción', 'Prueba con una frase como «Vendí 3 gaseosas» o «Entraron 10 panes», o completa los datos a mano.']
  };

  // Una consulta no se guarda: se responde ahí mismo.
  function tarjetaConsulta(o) {
    if (o.estado === 'consulta') {
      return '<div class="tarjeta propuesta"><h2>Consulta</h2><p class="grande">Quedan <b>' + o.producto.stock +
        '</b> unidades de <b>' + esc(o.producto.nombre) + '</b> ' + badgeEstado(o.producto.estado) +
        '</p><p class="nota">Mínimo configurado: ' + o.producto.stockMinimo + '.</p></div>';
    }
    return '<div class="tarjeta propuesta propuesta--ambiguo"><h2>Consulta</h2>' +
      (o.candidatos.length
        ? '<p>Coinciden varios productos:</p><ul class="lista" role="list">' + o.candidatos.map(function (c) {
            return '<li><span>' + esc(c.nombre) + '</span><span>' + c.stock + ' uds ' + badgeEstado(c.estado) + '</span></li>';
          }).join('') + '</ul>'
        : '<p>No encontré «' + esc(o.busqueda) + '» en el inventario.</p>') + '</div>';
  }

  // Una operación editable. `i` numera los campos para que cada fila tenga sus propios id.
  function filaOperacion(o, i, total, productos, esDueno) {
    var m = MENSAJES[o.estado] || MENSAJES.no_entendido;
    var seleccionado = o.producto ? o.producto.id : '';
    var explicacion = o.estado === 'sin_producto' && o.busqueda
      ? 'No hay ningún producto activo que coincida con «' + o.busqueda + '».'
      : m[1];
    return '<fieldset class="operacion propuesta--' + esc(o.estado) + '" data-fila="' + i + '">' +
      (total > 1 ? '<legend>Operación ' + (i + 1) + ' de ' + total + '</legend>' : '') +
      '<p class="operacion-titulo">' + esc(m[0]) + '</p>' +
      '<p class="nota">' + esc(explicacion) + '</p>' +
      (o.estado === 'ambiguo'
        ? '<div class="ejemplos">' + o.candidatos.map(function (c) {
            return '<button type="button" class="chip" data-candidato="' + c.id + '" data-fila="' + i + '">' +
              esc(c.nombre) + ' · ' + c.stock + ' uds</button>';
          }).join('') + '</div>'
        : '') +
      (o.estado === 'sin_producto' && esDueno && o.busqueda
        ? '<p><a class="btn btn--blanco" href="#/inventario?nuevo=' + encodeURIComponent(o.busqueda) + '">Crear «' + esc(o.busqueda) + '» en el inventario</a></p>'
        : '') +
      '<div class="campos">' +
        '<div><label for="c-producto-' + i + '">Producto</label><select id="c-producto-' + i + '" required>' +
          '<option value="">Elige un producto</option>' +
          productos.map(function (p) {
            return '<option value="' + p.id + '"' + (p.id === seleccionado ? ' selected' : '') + '>' +
              esc(p.nombre) + ' (' + p.stock + ' uds)</option>';
          }).join('') + '</select></div>' +
        '<div><label for="c-cantidad-' + i + '">Cantidad</label><input id="c-cantidad-' + i +
          '" type="number" inputmode="numeric" min="1" max="100000" step="1" value="' + (o.cantidad || '') + '" required></div>' +
        '<fieldset><legend>Tipo</legend>' + Object.keys(TIPOS).map(function (t) {
          return '<label class="radio"><input type="radio" name="c-tipo-' + i + '" value="' + t + '"' +
            ((o.tipo || 'venta') === t ? ' checked' : '') + '> ' + TIPOS[t] + '</label>';
        }).join('') + '</fieldset>' +
      '</div>' +
      (total > 1 ? '<button type="button" class="btn btn--blanco btn--quitar" data-quitar="' + i + '">Quitar esta</button>' : '') +
      '</fieldset>';
  }

  function mostrarPropuesta(zona, r, productos, origen) {
    var esDueno = estado.sesion.rol === 'dueno';
    var operaciones = r.operaciones || [];
    var consultas = operaciones.filter(function (o) { return o.tipo === 'consulta'; });
    var movimientos = operaciones.filter(function (o) { return o.tipo !== 'consulta'; });
    var html = consultas.map(tarjetaConsulta).join('');

    // Solo consultas: no hay nada que confirmar.
    if (!movimientos.length && consultas.length) { zona.innerHTML = html; return; }
    // Ni consultas ni movimientos: una fila en blanco para completarla a mano.
    if (!movimientos.length) {
      movimientos = [{ estado: 'no_entendido', tipo: null, cantidad: null, producto: null, candidatos: [], busqueda: '' }];
    }

    var total = movimientos.length;
    zona.innerHTML = html +
      '<form class="tarjeta propuesta" id="form-confirmar" novalidate>' +
        (total > 1 ? '<h2>Entendí ' + total + ' operaciones</h2><p>Revísalas y confirma. Puedes corregir o quitar cualquiera antes de guardar.</p>' : '') +
        (r.texto ? '<p class="frase">«' + esc(r.texto) + '»</p>' : '') +
        movimientos.map(function (o, i) { return filaOperacion(o, i, total, productos, esDueno); }).join('') +
        '<div id="error-confirmar"></div>' +
        '<div class="acciones"><button class="btn btn--grande" type="submit">' +
          (total > 1 ? 'Confirmar y guardar las ' + total : 'Confirmar y guardar') + '</button>' +
        '<button class="btn btn--blanco" type="button" id="cancelar">Cancelar</button></div>' +
      '</form>';

    var form = document.getElementById('form-confirmar');

    form.querySelectorAll('[data-candidato]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = b.getAttribute('data-fila');
        form.querySelector('#c-producto-' + i).value = b.getAttribute('data-candidato');
        form.querySelector('#c-cantidad-' + i).focus();
      });
    });

    form.querySelectorAll('[data-quitar]').forEach(function (b) {
      b.addEventListener('click', function () {
        var bloque = form.querySelector('[data-fila="' + b.getAttribute('data-quitar') + '"]');
        if (bloque) { bloque.remove(); }
        if (!form.querySelector('[data-fila]')) { zona.innerHTML = ''; document.getElementById('instruccion').focus(); }
      });
    });

    document.getElementById('cancelar').addEventListener('click', function () {
      zona.innerHTML = '';
      document.getElementById('instruccion').focus();
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var zonaError = document.getElementById('error-confirmar');
      var filas = [];
      var problema = null;
      form.querySelectorAll('[data-fila]').forEach(function (bloque) {
        if (problema) { return; }
        var i = bloque.getAttribute('data-fila');
        var productoId = Number(form.querySelector('#c-producto-' + i).value);
        var cantidad = Number(form.querySelector('#c-cantidad-' + i).value);
        var tipo = (form.querySelector('input[name="c-tipo-' + i + '"]:checked') || {}).value;
        if (!productoId) { problema = { campo: '#c-producto-' + i, texto: 'Elige el producto.' }; return; }
        if (!Number.isInteger(cantidad) || cantidad < 1) {
          problema = { campo: '#c-cantidad-' + i, texto: 'La cantidad debe ser un número entero mayor que cero.' };
          return;
        }
        filas.push({ productoId: productoId, cantidad: cantidad, tipo: tipo });
      });
      if (problema) { errorEn(zonaError, problema.texto); form.querySelector(problema.campo).focus(); return; }
      if (!filas.length) { return; }

      var boton = form.querySelector('button[type=submit]');
      boton.disabled = true; // evita guardar dos veces con doble clic
      guardarOperaciones(filas, origen, r.texto).then(function (resultados) {
        mostrarGuardado(zona, resultados);
      });
    });

    var primera = form.querySelector('[data-fila]');
    if (total === 1 && movimientos[0].estado === 'ok') { form.querySelector('button[type=submit]').focus(); }
    else { (primera || zona).scrollIntoView({ block: 'nearest' }); }
  }

  // Se guardan de a una y en orden, no en paralelo: dos operaciones sobre el mismo producto
  // tienen que verse una a la otra para que el stock cuadre. Cada una vive o muere sola, así
  // que un fallo no se lleva por delante las que sí sirven.
  function guardarOperaciones(filas, origen, texto) {
    var resultados = [];
    return filas.reduce(function (cadena, f) {
      return cadena.then(function () {
        return api('POST', '/api/movimientos', {
          productoId: f.productoId, cantidad: f.cantidad, tipo: f.tipo, origen: origen, textoOriginal: texto
        })
          .then(function (mov) { resultados.push({ ok: true, mov: mov }); })
          .catch(function (e) { resultados.push({ ok: false, error: e.message }); });
      });
    }, Promise.resolve()).then(function () { return resultados; });
  }

  function mostrarGuardado(zona, resultados) {
    var guardadas = resultados.filter(function (x) { return x.ok; });
    var fallidas = resultados.length - guardadas.length;
    var titulo = resultados.length === 1
      ? (guardadas.length ? esc(TIPOS[guardadas[0].mov.tipo]) + ' registrada' : 'No se pudo guardar')
      : 'Guardé ' + guardadas.length + ' de ' + resultados.length;

    var filas = resultados.map(function (x) {
      if (!x.ok) {
        return '<li class="fallida"><i class="material-icons" aria-hidden="true">error</i> <span>' + esc(x.error) + '</span></li>';
      }
      var p = x.mov.producto;
      return '<li><i class="material-icons" aria-hidden="true">check_circle</i> <span>' +
        esc(TIPOS[x.mov.tipo]) + ' · ' + esc(p.nombre) + ' · ' + x.mov.cantidad + ' uds. Stock: ' +
        x.mov.stockAnterior + ' → <b>' + p.stock + '</b> ' + badgeEstado(p.estado) + '</span></li>';
    }).join('');

    var bajos = guardadas.map(function (x) { return x.mov.producto; })
      .filter(function (p) { return p.estado !== 'ok'; })
      .map(function (p) { return '<p class="alerta">Atención: ' + esc(p.nombre) + ' quedó por debajo de su mínimo (' + p.stockMinimo + ').</p>'; })
      .join('');

    zona.innerHTML = '<div class="tarjeta propuesta propuesta--' + (fallidas ? 'sin_producto' : 'guardado') + '">' +
      '<h2>' + (fallidas ? '' : '<i class="material-icons" aria-hidden="true">check_circle</i> ') + titulo + '</h2>' +
      '<ul class="lista resultados" role="list">' + filas + '</ul>' + bajos +
      (fallidas ? '<p class="nota">Lo que falló no se guardó. Vuelve a dictarlo corrigiendo el dato.</p>' : '') +
      '<div class="acciones"><button type="button" class="btn" id="otro">Registrar otro</button>' +
      '<a class="btn btn--blanco" href="#/panel">Ir al inicio</a></div></div>';

    var entrada = document.getElementById('instruccion');
    entrada.value = '';
    document.getElementById('otro').addEventListener('click', function () { zona.innerHTML = ''; entrada.focus(); });
    document.getElementById('otro').focus();
  }

  /* ---------- Recolectar frases de tenderos (herramienta interna) ---------- */
  // No tiene enlace en el menú a propósito: se llega por #/recolectar. No es una función para el
  // tendero, es la máquina de hacer banco de pruebas. Graba al tendero, transcribe con Whisper,
  // deja corregir lo que entendió y acumula casos en el formato de evaluacion/casos.json.
  // Nada de esto toca el inventario.
  var GUARDADAS = 'stockvoz-frases-recogidas';

  function frasesGuardadas() {
    try { return JSON.parse(localStorage.getItem(GUARDADAS)) || []; } catch (e) { return []; }
  }
  function guardarFrases(lista) {
    try { localStorage.setItem(GUARDADAS, JSON.stringify(lista)); } catch (e) { /* modo privado */ }
  }

  // El mismo cálculo que hace el backend, para que el caso guardado diga lo que el banco espera.
  function estadoDeCaso(tipo, producto, cantidad) {
    if (!tipo) { return 'no_entendido'; }
    if (!producto) { return 'sin_producto'; }
    return cantidad ? 'ok' : 'sin_cantidad';
  }

  function vistaRecolectar() {
    var motor = motorDeVoz();
    render(
      '<h1>Recoger frases de tenderos</h1>' +
      '<p class="sub">Graba al tendero hablando natural, corrige lo que haga falta y guarda el caso. ' +
      'No se registra ningún movimiento: esto solo arma el banco de pruebas.</p>' +
      '<section class="tarjeta captura" aria-label="Captura de la frase">' +
        (motor
          ? '<button type="button" class="mic" id="mic" aria-pressed="false" aria-describedby="mic-ayuda">' +
              '<i class="material-icons" aria-hidden="true">mic</i><span id="mic-texto">Toca y habla</span></button>' +
            '<p class="nota" id="mic-ayuda">Deja que el tendero hable como hablaría en su tienda. Toca otra vez para terminar.</p>'
          : '<p class="nota" id="mic-ayuda">Este navegador no permite grabar. Escribe la frase tal como la dijo.</p>') +
        '<form id="form-texto" class="fila-instruccion" novalidate>' +
          '<label for="instruccion">Lo que dijo <span class="nota">(corrígelo si Whisper se equivocó)</span></label>' +
          '<input id="instruccion" maxlength="300" autocomplete="off" placeholder="Escribe o graba la frase">' +
          '<button class="btn" type="submit">Ver qué entendió</button>' +
        '</form>' +
      '</section>' +
      '<section id="resultado" aria-live="polite"></section>' +
      '<section id="recogidas" class="tarjeta"></section>', 'Recoger frases');

    var form = document.getElementById('form-texto');
    var entrada = document.getElementById('instruccion');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      proponerCaso(entrada.value);
    });
    prepararDictado(motor, entrada, function (texto) { proponerCaso(texto); });
    pintarRecogidas();
  }

  function proponerCaso(texto) {
    var zona = document.getElementById('resultado');
    if (!texto.trim()) { zona.innerHTML = '<div class="tarjeta"><p class="error">Graba o escribe la frase.</p></div>'; return; }
    zona.innerHTML = '<div class="tarjeta"><p class="cargando">Interpretando «' + esc(texto) + '»…</p></div>';
    Promise.all([api('POST', '/api/interpretar', { texto: texto }), api('GET', '/api/productos')])
      .then(function (r) { mostrarCaso(zona, texto, r[0], r[1]); })
      .catch(function (e) { zona.innerHTML = '<div class="tarjeta"><p class="error">' + esc(e.message) + '</p></div>'; });
  }

  function mostrarCaso(zona, texto, r, productos) {
    var movimientos = (r.operaciones || []).filter(function (o) { return o.tipo !== 'consulta'; });
    var total = movimientos.length;
    zona.innerHTML =
      '<form class="tarjeta propuesta" id="form-caso" novalidate>' +
        '<h2>' + (total ? 'Entendió ' + total + (total === 1 ? ' operación' : ' operaciones') : 'No entendió nada') + '</h2>' +
        '<p class="nota">Corrige lo que esté mal. Lo que dejes aquí es lo que el banco va a exigir.</p>' +
        '<p class="frase">«' + esc(texto) + '»</p>' +
        '<p class="nota">Fuente: ' + esc(r.fuente) + (r.motivoRespaldo ? ' (respaldo: ' + esc(r.motivoRespaldo) + ')' : '') + '</p>' +
        movimientos.map(function (o, i) { return filaOperacion(o, i, Math.max(total, 2), productos, false); }).join('') +
        '<div class="campos"><div><label for="c-categoria">Categoría</label>' +
          '<input id="c-categoria" maxlength="40" value="tenderos reales"></div></div>' +
        '<div class="acciones">' +
          '<button class="btn btn--grande" type="submit">Guardar caso</button>' +
          '<button class="btn btn--blanco" type="button" id="caso-nada">Guardar como «no se entiende»</button>' +
          '<button class="btn btn--blanco" type="button" id="caso-descartar">Descartar</button>' +
        '</div>' +
      '</form>';

    var form = document.getElementById('form-caso');
    form.querySelectorAll('[data-candidato]').forEach(function (b) {
      b.addEventListener('click', function () {
        form.querySelector('#c-producto-' + b.getAttribute('data-fila')).value = b.getAttribute('data-candidato');
      });
    });
    form.querySelectorAll('[data-quitar]').forEach(function (b) {
      b.addEventListener('click', function () {
        var bloque = form.querySelector('[data-fila="' + b.getAttribute('data-quitar') + '"]');
        if (bloque) { bloque.remove(); }
      });
    });
    document.getElementById('caso-descartar').addEventListener('click', function () {
      zona.innerHTML = '';
      document.getElementById('instruccion').focus();
    });
    document.getElementById('caso-nada').addEventListener('click', function () {
      anotarCaso(texto, document.getElementById('c-categoria').value, [], productos);
    });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var esperadas = [];
      form.querySelectorAll('[data-fila]').forEach(function (bloque) {
        var i = bloque.getAttribute('data-fila');
        var productoId = Number(form.querySelector('#c-producto-' + i).value) || null;
        var cantidad = Number(form.querySelector('#c-cantidad-' + i).value) || null;
        var tipo = (form.querySelector('input[name="c-tipo-' + i + '"]:checked') || {}).value || null;
        esperadas.push({ estado: estadoDeCaso(tipo, productoId, cantidad), tipo: tipo, cantidad: cantidad, producto: productoId });
      });
      anotarCaso(texto, document.getElementById('c-categoria').value, esperadas, productos);
    });
  }

  function anotarCaso(texto, categoria, esperadas, productos) {
    var lista = frasesGuardadas();
    lista.push({
      categoria: (categoria || 'tenderos reales').trim(),
      texto: texto.trim(),
      esperadas: esperadas,
      // El catálogo se guarda con cada caso porque los id son de este negocio: sin esto, el
      // archivo descargado no se puede interpretar en otro lado.
      catalogo: productos.map(function (p) { return { id: p.id, nombre: p.nombre }; })
    });
    guardarFrases(lista);
    document.getElementById('resultado').innerHTML = '';
    var entrada = document.getElementById('instruccion');
    entrada.value = '';
    entrada.focus();
    pintarRecogidas();
    avisar('Caso guardado. Van ' + lista.length + '.');
  }

  function pintarRecogidas() {
    var zona = document.getElementById('recogidas');
    if (!zona) { return; }
    var lista = frasesGuardadas();
    if (!lista.length) {
      zona.innerHTML = '<h2>Frases recogidas</h2><p class="nota">Todavía no hay ninguna. ' +
        'Las que guardes quedan en este navegador hasta que las descargues.</p>';
      return;
    }
    zona.innerHTML = '<h2>Frases recogidas (' + lista.length + ')</h2>' +
      '<ul class="lista" role="list">' + lista.map(function (c, i) {
        var resumen = c.esperadas.length
          ? c.esperadas.map(function (e) { return esc(TIPOS[e.tipo] || '—') + ' ' + (e.cantidad || '?'); }).join(' · ')
          : 'no se entiende';
        return '<li><span>«' + esc(c.texto) + '»</span><span>' + resumen +
          ' <button type="button" class="btn btn--blanco btn--quitar" data-borrar="' + i + '">Quitar</button></span></li>';
      }).join('') + '</ul>' +
      '<p class="nota">Viven solo en este navegador. Descárgalas antes de cerrar o de cambiar de equipo.</p>' +
      '<div class="acciones"><button type="button" class="btn" id="descargar-frases">Descargar JSON</button>' +
      '<button type="button" class="btn btn--blanco" id="vaciar-frases">Borrar todas</button></div>';

    zona.querySelectorAll('[data-borrar]').forEach(function (b) {
      b.addEventListener('click', function () {
        var l = frasesGuardadas();
        l.splice(Number(b.getAttribute('data-borrar')), 1);
        guardarFrases(l);
        pintarRecogidas();
      });
    });
    document.getElementById('descargar-frases').addEventListener('click', descargarFrases);
    document.getElementById('vaciar-frases').addEventListener('click', function () {
      confirmar('¿Borrar las ' + frasesGuardadas().length + ' frases recogidas?',
        'Se pierden si no las has descargado. Esto no se puede deshacer.', 'Borrar todas')
        .then(function (si) { if (si) { guardarFrases([]); pintarRecogidas(); } });
    });
  }

  function descargarFrases() {
    var lista = frasesGuardadas();
    if (!lista.length) { return; }
    // Se escribe en el formato de evaluacion/casos.json para poder mezclarlo sin trabajo manual.
    var archivo = {
      nota: 'Frases grabadas a tenderos reales. Mézclalas con evaluacion/casos.json.',
      catalogo: lista[0].catalogo,
      casos: lista.map(function (c) { return { categoria: c.categoria, texto: c.texto, esperadas: c.esperadas }; })
    };
    var url = URL.createObjectURL(new Blob([JSON.stringify(archivo, null, 2)], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'frases-tenderos-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
      '<div class="encabezado"><div><h1>Movimientos</h1>' +
      '<p class="sub">Historial de ventas, entradas y mermas, con la frase original de cada registro.</p></div>' +
      '<div class="acciones"><label for="dias-csv" class="visually-hidden">Periodo a exportar</label>' +
        '<select id="dias-csv">' +
          '<option value="7">Últimos 7 días</option><option value="30" selected>Últimos 30 días</option>' +
          '<option value="90">Últimos 90 días</option><option value="365">Último año</option>' +
        '</select>' +
        '<a class="btn btn--blanco" id="exportar-csv" href="#"><i class="material-icons" aria-hidden="true">table_view</i>Exportar CSV</a>' +
      '</div></div>' +
      '<div class="filtros" role="group" aria-label="Filtrar por tipo">' +
        [['', 'Todos'], ['venta', 'Ventas'], ['entrada', 'Entradas'], ['merma', 'Mermas']].map(function (f) {
          return '<a class="chip' + (f[0] === tipo ? ' chip--activo' : '') + '" href="#/movimientos' + (f[0] ? '?tipo=' + f[0] : '') + '"' +
            (f[0] === tipo ? ' aria-current="true"' : '') + '>' + f[1] + '</a>';
        }).join('') +
      '</div><div id="lista-mov" class="tarjeta"><p class="cargando">Cargando…</p></div>', 'Movimientos');
    var zona = document.getElementById('lista-mov');

    // El CSV lo arma el servidor; el enlace solo lleva el filtro y el periodo elegidos.
    var selDias = document.getElementById('dias-csv');
    var enlaceCsv = document.getElementById('exportar-csv');
    function actualizarEnlaceCsv() {
      enlaceCsv.href = '/api/movimientos.csv?dias=' + encodeURIComponent(selDias.value) + (tipo ? '&tipo=' + encodeURIComponent(tipo) : '');
    }
    selDias.addEventListener('change', actualizarEnlaceCsv);
    actualizarEnlaceCsv();

    function cargar() {
      api('GET', '/api/movimientos?limite=200' + (tipo ? '&tipo=' + tipo : '')).then(function (lista) {
        zona.innerHTML = tablaMovimientos(lista, false);
        zona.querySelectorAll('[data-anular]').forEach(function (b) {
          b.addEventListener('click', function () {
            var id = Number(b.getAttribute('data-anular'));
            anular(lista.find(function (m) { return m.id === id; }), b);
          });
        });
      }).catch(function (e) { errorEn(zona, e.message); });
    }

    function anular(m, boton) {
      var efecto = m.tipo === 'entrada'
        ? 'Se quitarán ' + m.cantidad + ' unidades del stock'
        : 'Se devolverán ' + m.cantidad + ' unidades al stock';
      confirmar('¿Anular este movimiento?',
        (TIPOS[m.tipo] || m.tipo) + ' de ' + m.cantidad + ' · ' + m.producto + '. ' + efecto +
        '. El movimiento no se borra: queda en el historial marcado como anulado y deja de contar en los reportes.',
        'Sí, anular').then(function (ok) {
          if (!ok) { return; }
          boton.disabled = true;
          api('POST', '/api/movimientos/' + m.id + '/anular', {}).then(function (r) {
            avisar('Movimiento anulado. ' + r.producto.nombre + ' queda con ' + r.producto.stock + ' unidades.');
            cargar();
          }).catch(function (e) { boton.disabled = false; avisar(e.message, true); });
        });
    }

    cargar();
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

  // Hace que la app se pueda instalar en el celular y abra sin conexión. El navegador solo lo
  // acepta en https o en localhost; si falla, StockVoz sigue funcionando igual.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
