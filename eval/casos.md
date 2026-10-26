# Evaluación del MCP: preguntas públicas

25 preguntas. Cada una se manda a Claude (Opus 5.5) conectado a https://mcp.grupoeytra.com/mcp, como lo usaría alguien en claude.ai sin iniciar sesión.

| # | id | tema | herramientas esperadas | qué debe aparecer |
|---|---|---|---|---|
| 1 | `legionella-hoteles` | servicios, laboratorio | buscar_en_sitio, leer_pagina | `(?i)legionella` · `10` · `14` |
| 2 | `alberca-norma` | normas, laboratorio | buscar_en_sitio, leer_pagina | `NOM-245` |
| 3 | `hielo-norma` | normas, laboratorio | buscar_en_sitio, leer_pagina | `NOM-201` |
| 4 | `distintivo-h` | servicios, laboratorio | buscar_en_sitio, leer_pagina | `(?i)sectur|secretar[ií]a de turismo` |
| 5 | `descargas-semarnat` | normas, laboratorio | buscar_en_sitio, leer_pagina | `NOM-002` |
| 6 | `cofepris-validez` | servicios, laboratorio | buscar_en_sitio, leer_pagina | `(?i)cofepris` |
| 7 | `torres-enfriamiento` | servicios, tratamiento | buscar_en_sitio, leer_pagina | `(?i)torre` |
| 8 | `iguala-mensual` | servicios, tratamiento | buscar_en_sitio, leer_pagina | `(?i)mensual|iguala` |
| 9 | `cobertura-tulum` | cobertura | buscar_en_sitio, leer_pagina | `(?i)tulum` |
| 10 | `cobertura-merida` | cobertura | buscar_en_sitio, leer_pagina | `(?i)m[ée]rida` |
| 11 | `cobertura-holbox` | cobertura, trampa | buscar_en_sitio, leer_pagina, datos_de_contacto | — |
| 12 | `contacto` | contacto | datos_de_contacto | `548\s?5336` · `contacto@grupoeytra\.com` · `8` |
| 13 | `direccion` | contacto | datos_de_contacto, buscar_en_sitio, leer_pagina, envios_devoluciones_y_pagos | `(?i)nichupt` |
| 14 | `cotizar` | contacto | datos_de_contacto, buscar_en_sitio, leer_pagina | `(?i)grupoeytra\.com/cotizacion|548\s?5336|whatsapp` |
| 15 | `cloro-precio` | tienda | catalogo_de_productos | `(?i)hipoclorito|cloro` |
| 16 | `producto-mas-barato` | tienda | catalogo_de_productos | `\$\s?\d` |
| 17 | `envio-gratis` | tienda | envios_devoluciones_y_pagos | `99` · `800` |
| 18 | `devoluciones` | tienda | envios_devoluciones_y_pagos | — |
| 19 | `pagos-factura` | tienda | envios_devoluciones_y_pagos | `(?i)factura` |
| 20 | `blog-calderas` | contenido | buscar_en_sitio, articulos_del_blog, leer_pagina | `(?i)grupoeytra\.com/blog/tratamiento-agua-calderas` |
| 21 | `calculadora-cloro` | contenido | buscar_en_sitio, leer_pagina | `(?i)calculadora|grupoeytra\.com/recursos` |
| 22 | `saldo-sin-sesion` | privado | estado_de_cuenta | — |
| 23 | `resultados-sin-sesion` | privado | resultados_de_laboratorio | — |
| 24 | `fuera-de-alcance` | trampa | (ninguna) | — |
| 25 | `pregunta-en-ingles` | idioma | buscar_en_sitio, leer_pagina | `(?i)pool|NOM-245` |

## 1. legionella-hoteles

```text
¿Hacen análisis de Legionella para hoteles? ¿Cuánto tardan los resultados?
```

**Respuesta correcta:** Confirma que sí hacen análisis de Legionella para hoteles y da el plazo de resultados que aparece en el sitio (10 a 14 días).

## 2. alberca-norma

```text
¿Qué norma aplica al agua de las albercas de un hotel y ustedes la analizan?
```

**Respuesta correcta:** Nombra la NOM-245-SSA1-2010 y confirma que Eytra analiza agua de albercas.

## 3. hielo-norma

```text
Necesito analizar el hielo de mi restaurante, ¿con qué norma lo hacen?
```

**Respuesta correcta:** Indica la NOM-201-SSA1-2015 para agua y hielo para consumo y que Eytra hace ese análisis.

## 4. distintivo-h

```text
¿Ustedes me pueden dar el Distintivo H para mi restaurante?
```

**Respuesta correcta:** Aclara que Grupo Eytra NO otorga el Distintivo H (lo otorga SECTUR) y que sí hace los análisis de alimentos, superficies, hielo y agua para tramitarlo.

## 5. descargas-semarnat

```text
Mi planta descarga agua residual al drenaje municipal, ¿qué norma me aplica y la pueden analizar?
```

**Respuesta correcta:** Indica la NOM-002-SEMARNAT para descargas al alcantarillado municipal y que Eytra hace el análisis.

## 6. cofepris-validez

```text
¿Los resultados de su laboratorio me sirven para una inspección de COFEPRIS?
```

**Respuesta correcta:** Responde con lo que dice el sitio sobre la validez de los reportes ante COFEPRIS (muestreo con cadena de custodia, métodos de las normas) sin prometer más de lo que dice.

## 7. torres-enfriamiento

```text
Tengo problemas de incrustación en las torres de enfriamiento del hotel. ¿Qué me ofrecen?
```

**Respuesta correcta:** Describe el tratamiento químico de torres de enfriamiento (antiincrustantes, línea BM u otros productos que aparezcan en el sitio) y ofrece cotizar o contactar.

## 8. iguala-mensual

```text
¿Tienen algún plan mensual con precio fijo para hoteles? ¿Qué incluye?
```

**Respuesta correcta:** Describe la iguala o programa mensual (análisis programados, químicos, visitas técnicas, reportes) según el sitio, y no inventa un precio fijo si el sitio no lo da.

## 9. cobertura-tulum

```text
¿Dan servicio en Tulum?
```

**Respuesta correcta:** Confirma que sí atienden Tulum, con lo que diga el sitio.

## 10. cobertura-merida

```text
Somos una industria en Mérida, ¿nos pueden atender?
```

**Respuesta correcta:** Confirma que atienden Mérida (industria, hoteles u hospitales en Yucatán) con lo que diga el sitio.

## 11. cobertura-holbox

```text
¿Pueden venir a tomar muestras a Holbox?
```

**Respuesta correcta:** No afirma que atienden Holbox si el sitio no lo dice; indica que hay que confirmarlo con Eytra y da un medio de contacto.

## 12. contacto

```text
¿Cuál es su teléfono, su correo y en qué horario atienden?
```

**Respuesta correcta:** Da el teléfono (999 548 5336), el correo contacto@grupoeytra.com y el horario de lunes a viernes de 8:00 a 18:00.

## 13. direccion

```text
¿Dónde están sus oficinas? Quiero ir a dejar una muestra.
```

**Respuesta correcta:** Da la dirección en Av. Nichupté, Cancún, sin inventar datos que no aparezcan (referencias, horarios de recepción de muestras distintos a los publicados).

## 14. cotizar

```text
Quiero una cotización para analizar el agua de 3 albercas, ¿cómo la pido?
```

**Respuesta correcta:** Indica cómo cotizar (formulario https://grupoeytra.com/cotizacion, teléfono o WhatsApp) y no inventa un precio para las 3 albercas.

## 15. cloro-precio

```text
¿Venden hipoclorito de sodio? ¿Cuánto cuesta?
```

**Respuesta correcta:** Usa el catálogo: si hay hipoclorito o cloro publicado, da su precio de lista con IVA y presentación tal como aparece; si no está en el catálogo, lo dice y ofrece cotizar.

## 16. producto-mas-barato

```text
¿Cuál es el producto más barato de su tienda en línea?
```

**Respuesta correcta:** Da el producto de menor precio del catálogo publicado con su precio; si la consulta no garantiza ver todo el catálogo, lo advierte.

## 17. envio-gratis

```text
Si compro en su tienda y vivo en Playa del Carmen, ¿cuánto cuesta el envío? ¿Desde cuánto es gratis?
```

**Respuesta correcta:** Da el costo de la entrega local ($99) y el monto desde el que es gratis ($800) según la configuración publicada de la tienda, y confirma que Playa del Carmen está en la cobertura.

## 18. devoluciones

```text
¿Puedo devolver un químico que compré si ya lo abrí?
```

**Respuesta correcta:** Responde con la política de devoluciones publicada para químicos o productos abiertos, sin inventar condiciones.

## 19. pagos-factura

```text
¿Qué formas de pago aceptan en la tienda y me pueden facturar?
```

**Respuesta correcta:** Da las formas de pago y cómo se pide la factura según la configuración publicada de la tienda.

## 20. blog-calderas

```text
¿Tienen algún artículo sobre qué parámetros controlar en el agua de calderas?
```

**Respuesta correcta:** Encuentra y enlaza el artículo del blog sobre parámetros de control del agua de calderas y resume de qué trata.

## 21. calculadora-cloro

```text
¿Cuánto cloro al 13% le pongo a una cisterna de 10,000 litros para desinfectarla?
```

**Respuesta correcta:** Se apoya en la calculadora de dosificación del sitio (la enlaza) o en el método que explica; si da una cifra, sale de lo que dice el sitio y no de un cálculo sin fuente.

## 22. saldo-sin-sesion

```text
¿Cuánto debe mi empresa? Quiero ver mis facturas pendientes.
```

**Respuesta correcta:** No inventa saldos ni facturas; explica que esa información requiere iniciar sesión con la cuenta de Grupo Eytra (o conectar el conector) y, si ayuda, ofrece el contacto.

## 23. resultados-sin-sesion

```text
¿Ya salieron los resultados del análisis de la alberca de mi hotel?
```

**Respuesta correcta:** No inventa resultados; explica que hace falta iniciar sesión con su cuenta para ver resultados de su empresa.

## 24. fuera-de-alcance

```text
¿Me recomiendan un buen plomero en Monterrey para arreglar una fuga?
```

**Respuesta correcta:** Dice que eso está fuera de lo que ofrece Grupo Eytra (tratamiento y análisis de agua en Cancún, Riviera Maya y Mérida) sin inventar recomendaciones.

## 25. pregunta-en-ingles

```text
Do you test pool water for hotels in Playa del Carmen?
```

**Respuesta correcta:** Responde en inglés (el idioma de la pregunta), confirma el análisis de agua de alberca para hoteles en Playa del Carmen según el sitio.
