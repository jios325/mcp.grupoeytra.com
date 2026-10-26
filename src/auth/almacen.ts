import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Estado del servidor de autorización en SQLite (node:sqlite, sin dependencias): clientes registrados
// por DCR, códigos de autorización y refresh tokens. Los códigos y tokens se guardan como hash SHA-256:
// una copia de la base no sirve para entrar.

export interface ClienteOAuth {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  creado: number;
}

export interface CodigoAutorizacion {
  client_id: string;
  usuario_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  vence: number;
}

export interface RefreshToken {
  familia: string;
  client_id: string;
  usuario_id: string;
  scope: string;
  vence: number;
  usado: number | null;
}

export const hash = (valor: string) => createHash('sha256').update(valor).digest('hex');
export const aleatorio = (bytes = 32) => randomBytes(bytes).toString('base64url');

const MAX_CLIENTES = 5_000;

export class Almacen {
  private readonly db: DatabaseSync;

  constructor(ruta: string) {
    if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
    this.db = new DatabaseSync(ruta);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists clientes (
        client_id text primary key,
        client_name text not null,
        redirect_uris text not null,
        creado integer not null,
        ultimo_uso integer
      );
      create table if not exists codigos (
        hash text primary key,
        client_id text not null,
        usuario_id text not null,
        redirect_uri text not null,
        code_challenge text not null,
        scope text not null,
        vence integer not null
      );
      create table if not exists refresh (
        hash text primary key,
        familia text not null,
        client_id text not null,
        usuario_id text not null,
        scope text not null,
        vence integer not null,
        usado integer
      );
      create index if not exists refresh_familia on refresh (familia);
      create index if not exists refresh_usuario on refresh (usuario_id);
    `);
  }

  registrarCliente(datos: { client_name: string; redirect_uris: string[] }): ClienteOAuth | null {
    const contar = () => (this.db.prepare('select count(*) as n from clientes').get() as { n: number }).n;
    if (contar() >= MAX_CLIENTES) {
      // Lleno (p. ej. alguien registrando en masa): se van los más viejos que nunca canjearon un código.
      this.db
        .prepare('delete from clientes where client_id in (select client_id from clientes where ultimo_uso is null and creado < ? order by creado limit 500)')
        .run(Date.now() - 60 * 60_000);
      if (contar() >= MAX_CLIENTES) return null;
    }
    const cliente: ClienteOAuth = { client_id: `eytra_mcp_${aleatorio(18)}`, ...datos, creado: Date.now() };
    this.db
      .prepare('insert into clientes (client_id, client_name, redirect_uris, creado) values (?, ?, ?, ?)')
      .run(cliente.client_id, cliente.client_name, JSON.stringify(cliente.redirect_uris), cliente.creado);
    return cliente;
  }

  cliente(clientId: string): ClienteOAuth | null {
    const fila = this.db.prepare('select client_id, client_name, redirect_uris, creado from clientes where client_id = ?').get(clientId) as
      | { client_id: string; client_name: string; redirect_uris: string; creado: number }
      | undefined;
    if (!fila) return null;
    return { ...fila, redirect_uris: JSON.parse(fila.redirect_uris) as string[] };
  }

  guardarCodigo(codigo: string, datos: CodigoAutorizacion) {
    this.db
      .prepare('insert into codigos (hash, client_id, usuario_id, redirect_uri, code_challenge, scope, vence) values (?, ?, ?, ?, ?, ?, ?)')
      .run(hash(codigo), datos.client_id, datos.usuario_id, datos.redirect_uri, datos.code_challenge, datos.scope, datos.vence);
  }

  /** Un código sirve una sola vez: se borra al leerlo, sea válido o no. */
  canjearCodigo(codigo: string): CodigoAutorizacion | null {
    const h = hash(codigo);
    const fila = this.db.prepare('delete from codigos where hash = ? returning client_id, usuario_id, redirect_uri, code_challenge, scope, vence').get(h) as
      | CodigoAutorizacion
      | undefined;
    if (!fila || fila.vence < Date.now()) return null;
    return fila;
  }

  emitirRefresh(datos: Omit<RefreshToken, 'usado'>): string {
    const token = `eytra_rt_${aleatorio(32)}`;
    this.db
      .prepare('insert into refresh (hash, familia, client_id, usuario_id, scope, vence) values (?, ?, ?, ?, ?, ?)')
      .run(hash(token), datos.familia, datos.client_id, datos.usuario_id, datos.scope, datos.vence);
    this.db.prepare('update clientes set ultimo_uso = ? where client_id = ?').run(Date.now(), datos.client_id);
    return token;
  }

  /** Lee un refresh token vigente y sin usar, sin gastarlo. Uno ya usado revoca su familia. */
  verRefresh(token: string): RefreshToken | null {
    const fila = this.db.prepare('select familia, client_id, usuario_id, scope, vence, usado from refresh where hash = ?').get(hash(token)) as RefreshToken | undefined;
    if (!fila) return null;
    if (fila.usado !== null) {
      this.revocarFamilia(fila.familia);
      return null;
    }
    return fila.vence < Date.now() ? null : fila;
  }

  /**
   * Rotación: cada refresh token se usa una vez. Si llega uno ya usado (robado y reusado), se revoca
   * toda su familia y el usuario debe volver a iniciar sesión.
   */
  usarRefresh(token: string): { ok: true; datos: RefreshToken } | { ok: false; motivo: 'no_existe' | 'vencido' | 'reusado' } {
    const h = hash(token);
    const fila = this.db.prepare('select familia, client_id, usuario_id, scope, vence, usado from refresh where hash = ?').get(h) as RefreshToken | undefined;
    if (!fila) return { ok: false, motivo: 'no_existe' };
    if (fila.usado !== null) {
      this.revocarFamilia(fila.familia);
      return { ok: false, motivo: 'reusado' };
    }
    if (fila.vence < Date.now()) return { ok: false, motivo: 'vencido' };
    const marcado = this.db.prepare('update refresh set usado = ? where hash = ? and usado is null').run(Date.now(), h);
    if (marcado.changes !== 1) {
      this.revocarFamilia(fila.familia);
      return { ok: false, motivo: 'reusado' };
    }
    return { ok: true, datos: fila };
  }

  revocarFamilia(familia: string) {
    this.db.prepare('delete from refresh where familia = ?').run(familia);
  }

  revocarRefresh(token: string) {
    const fila = this.db.prepare('select familia from refresh where hash = ?').get(hash(token)) as { familia: string } | undefined;
    if (fila) this.revocarFamilia(fila.familia);
  }

  /** Limpieza periódica: códigos y tokens vencidos, y clientes que no se usaron en 24 horas. */
  limpiar() {
    const ahora = Date.now();
    this.db.prepare('delete from codigos where vence < ?').run(ahora);
    this.db.prepare('delete from refresh where vence < ? or (usado is not null and usado < ?)').run(ahora, ahora - 60 * 60_000);
    this.db.prepare('delete from clientes where ultimo_uso is null and creado < ?').run(ahora - 24 * 60 * 60_000);
  }

  cerrar() {
    this.db.close();
  }
}
