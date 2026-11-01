'use strict';
// Error con código HTTP y mensaje apto para mostrar al usuario.
class ErrorApi extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

module.exports = { ErrorApi };
