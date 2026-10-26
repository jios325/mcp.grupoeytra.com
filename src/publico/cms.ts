import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Config } from '../config.js';

// Vistas públicas del CMS (rol anon, llave publicable): las mismas que lee el sitio al construirse
// (cms.grupoeytra.com/docs/sitio-cms.md). Son el contrato entre repos; las tablas internas no se tocan.

export class CmsPublico {
  private readonly supabase: SupabaseClient;

  constructor(config: Pick<Config, 'supabaseUrl' | 'supabaseLlavePublicable'>) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseLlavePublicable, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private async vista<T>(nombre: string, columnas: string, ajustar?: (q: any) => any): Promise<T[]> {
    let consulta = this.supabase.from(nombre).select(columnas);
    if (ajustar) consulta = ajustar(consulta);
    const { data, error } = await consulta.abortSignal(AbortSignal.timeout(8000));
    if (error) {
      console.error('[cms] vista pública con error', { nombre, code: error.code, message: error.message });
      throw new Error('No se pudo leer la información del CMS.');
    }
    return (data ?? []) as T[];
  }

  async datosSitio() {
    const [fila] = await this.vista<Record<string, unknown>>('site_settings_public', 'phone, whatsapp, forms_email, hours, delivery_zone, updated_at');
    return fila ?? null;
  }

  async tienda() {
    const [entregas, devoluciones, ajustes] = await Promise.all([
      this.vista('shop_delivery_public', 'key, name, coverage, cost, free_from, lead_time, accepts_chemicals', (q) => q.order('sort_order')),
      this.vista('shop_return_policies_public', 'key, name, window_label, body, return_shipping', (q) => q.order('sort_order')),
      this.vista(
        'shop_settings_public',
        'cutoff_time, business_days, pickup_address, local_delivery_mode, payment_methods, invoice_mode, invoice_window, volume_purchases',
      ),
    ]);
    return { entregas, devoluciones, ajustes: ajustes[0] ?? null };
  }

  /** Catálogo publicado (la misma vista que lee /catalog de la API), hasta 20 productos. */
  async catalogo(buscar?: string) {
    const productos = await this.vista(
      'shop_catalog',
      'slug, name, category, price, sale_mode, recurring_interval, pack_quantity, pack_unit, summary',
      (q) => {
        let r = q.order('sort_order').order('name').limit(20);
        const termino = buscar?.replace(/[%,()*\\]/g, ' ').trim();
        if (termino) r = r.or(`name.ilike.%${termino}%,category.ilike.%${termino}%,summary.ilike.%${termino}%`);
        return r;
      },
    );
    return {
      nota: 'Precios de lista en MXN con IVA incluido; descuentos solo con una cotización aprobada por Eytra.',
      productos,
      tienda: 'https://grupoeytra.com/tienda',
    };
  }

  async temasBlog() {
    return this.vista('blog_topics_public', 'slug, name, description', (q) => q.order('sort_order'));
  }

  /** Artículos publicados; con `buscar` filtra por título, extracto o etiquetas. Sin el cuerpo. */
  async articulos(opciones: { buscar?: string; tema?: string; limite?: number }) {
    const limite = Math.min(Math.max(opciones.limite ?? 10, 1), 30);
    return this.vista('blog_public', 'slug, title, excerpt, topic_slug, topic_name, author_name, tags, publish_at, updated_at', (q) => {
      let r = q.order('publish_at', { ascending: false }).limit(limite);
      if (opciones.tema) r = r.eq('topic_slug', opciones.tema);
      if (opciones.buscar) {
        // Comodines y comas fuera: el término va dentro de un filtro or() de PostgREST.
        const termino = opciones.buscar.replace(/[%,()*\\]/g, ' ').trim();
        if (termino) r = r.or(`title.ilike.%${termino}%,excerpt.ilike.%${termino}%,summary.ilike.%${termino}%`);
      }
      return r;
    });
  }

  async articulo(slug: string) {
    const [fila] = await this.vista<Record<string, unknown>>(
      'blog_public',
      'slug, title, excerpt, summary, body_md, topic_name, author_name, author_role, reviewer_name, reviewer_role, tags, related_norms, related_product_slugs, publish_at, updated_at',
      (q) => q.eq('slug', slug).limit(1),
    );
    return fila ?? null;
  }
}
