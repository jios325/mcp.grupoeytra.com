// Límite de intentos en memoria por clave (IP, correo o «global») con ventana fija. Basta para una sola
// instancia; Supabase Auth y la API del asistente tienen sus propios límites detrás.

export class Limitador {
  private readonly cuentas = new Map<string, { n: number; desde: number }>();

  constructor(
    private readonly maximo: number,
    private readonly ventanaMs: number,
  ) {
    setInterval(() => this.limpiar(), ventanaMs).unref();
  }

  private vigente(clave: string) {
    const actual = this.cuentas.get(clave);
    if (!actual || Date.now() - actual.desde > this.ventanaMs) return null;
    return actual;
  }

  /** Cuenta un intento y dice si todavía cabe. */
  tomar(clave: string): boolean {
    this.sumar(clave);
    return this.vigente(clave)!.n <= this.maximo;
  }

  /** Para contar solo fallos: consultar antes con excedido() y sumar() después de fallar. */
  excedido(clave: string): boolean {
    return (this.vigente(clave)?.n ?? 0) >= this.maximo;
  }

  sumar(clave: string) {
    const actual = this.vigente(clave);
    if (actual) actual.n += 1;
    else this.cuentas.set(clave, { n: 1, desde: Date.now() });
    if (this.cuentas.size > 50_000) this.limpiar();
  }

  private limpiar() {
    const ahora = Date.now();
    for (const [clave, valor] of this.cuentas) if (ahora - valor.desde > this.ventanaMs) this.cuentas.delete(clave);
  }
}
