Instrucciones del servidor, búsqueda en el sitio y catálogo con orden por precio (tres problemas de la corrida base)

1. **Herramientas privadas sin sesión**: el conector de la API recibe el 401 como «Connection closed» y Claude lo presentaba
   como una falla temporal del sistema. Las instrucciones ahora dicen que una falla en una herramienta privada casi siempre
   significa que falta iniciar sesión, que lo diga así y que no reintente en el mismo turno.
2. **Catálogo sin orden**: para el producto más barato Claude hizo 14 llamadas (la herramienta devolvía 20 productos sin
   orden ni total). Ahora acepta `orden` (`precio_asc`, `precio_desc`), `limite` hasta 50, y devuelve `total` y `hay_mas`.
3. **Recursos del sitio**: en la pregunta de la cisterna Claude calculó la dosis por su cuenta sin buscar en el sitio. Las
   instrucciones piden empezar por `buscar_en_sitio` en preguntas técnicas o de cálculo y usar la calculadora del sitio; la
   descripción de `buscar_en_sitio` nombra los recursos, y la búsqueda compara raíces de 6 letras («desinfectarla» →
   «desinfectar»).

Además: no completar con suposiciones lo que los datos no dicen (5 casos de la base agregaban plazos o condiciones), y
responder en el idioma de la pregunta (antes las instrucciones pedían siempre español).
