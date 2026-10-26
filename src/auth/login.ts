import { createClient, type Session } from '@supabase/supabase-js';

import type { Config } from '../config.js';

// Inicio de sesión contra el Auth de Supabase del CMS: las mismas cuentas, contraseñas y apps de
// autenticación que cms.grupoeytra.com. El MCP no guarda contraseñas ni sesiones de Supabase: en cuanto
// sabe quién es la persona, cierra la sesión de Supabase (revoca su refresh token) y emite sus propios tokens.

export type PasoLogin =
  | { tipo: 'listo'; usuarioId: string }
  | { tipo: 'segundo_factor'; sesion: Pick<Session, 'access_token' | 'refresh_token'>; factorId: string }
  | { tipo: 'error'; mensaje: string };

const CREDENCIALES_INVALIDAS = 'Correo o contraseña incorrectos.';

export class LoginSupabase {
  constructor(private readonly config: Pick<Config, 'supabaseUrl' | 'supabaseLlavePublicable'>) {}

  private cliente() {
    return createClient(this.config.supabaseUrl, this.config.supabaseLlavePublicable, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  async conContrasena(correo: string, contrasena: string): Promise<PasoLogin> {
    const supabase = this.cliente();
    const { data, error } = await supabase.auth.signInWithPassword({ email: correo, password: contrasena });
    if (error || !data.session || !data.user) {
      if (error?.status === 429) return { tipo: 'error', mensaje: 'Demasiados intentos. Espere unos minutos.' };
      return { tipo: 'error', mensaje: CREDENCIALES_INVALIDAS };
    }

    // Quien tiene una app de autenticación verificada debe usarla aquí también (aal2), como en el CMS.
    const { data: nivel, error: errorNivel } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (errorNivel || !nivel) {
      // Sin saber si tiene segundo factor no se deja pasar (falla cerrado).
      await supabase.auth.signOut({ scope: 'local' });
      return { tipo: 'error', mensaje: 'No se pudo verificar su cuenta. Intente de nuevo en unos minutos.' };
    }
    if (nivel.nextLevel === 'aal2' && nivel.currentLevel !== 'aal2') {
      const { data: factores } = await supabase.auth.mfa.listFactors();
      const totp = factores?.totp.find((f) => f.status === 'verified');
      if (!totp) {
        await supabase.auth.signOut({ scope: 'local' });
        return { tipo: 'error', mensaje: 'Su cuenta pide un segundo factor que este acceso no admite. Use su app de autenticación.' };
      }
      return { tipo: 'segundo_factor', sesion: { access_token: data.session.access_token, refresh_token: data.session.refresh_token }, factorId: totp.id };
    }

    await supabase.auth.signOut({ scope: 'local' });
    return { tipo: 'listo', usuarioId: data.user.id };
  }

  async conCodigo(sesion: Pick<Session, 'access_token' | 'refresh_token'>, factorId: string, codigo: string): Promise<PasoLogin> {
    const supabase = this.cliente();
    const { data: puesta, error: errorSesion } = await supabase.auth.setSession(sesion);
    if (errorSesion || !puesta.user) return { tipo: 'error', mensaje: 'La sesión venció. Vuelva a escribir su correo y contraseña.' };
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: codigo });
    if (error) {
      if (error.status === 429) return { tipo: 'error', mensaje: 'Demasiados intentos con el código. Espere unos minutos.' };
      return { tipo: 'error', mensaje: 'El código no es válido. Revise su app de autenticación e intente de nuevo.' };
    }
    const usuarioId = puesta.user.id;
    await supabase.auth.signOut({ scope: 'local' });
    return { tipo: 'listo', usuarioId };
  }

  /** Cierra una sesión a medias (el usuario no terminó el segundo factor). */
  async descartar(sesion: Pick<Session, 'access_token' | 'refresh_token'>) {
    const supabase = this.cliente();
    const { error } = await supabase.auth.setSession(sesion);
    if (!error) await supabase.auth.signOut({ scope: 'local' });
  }
}
