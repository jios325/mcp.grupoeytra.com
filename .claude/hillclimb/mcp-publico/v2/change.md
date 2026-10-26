Las indicaciones pasan de las instrucciones del servidor a la descripción de cada herramienta, y se mide con 2 repeticiones

En la v1 los cambios que viajaban en las descripciones y parámetros (catálogo, búsqueda) funcionaron, y los que estaban en
las instrucciones del servidor no se notaron: el conector MCP de la API parece no pasarlas al modelo (hipótesis, sin confirmar
en la documentación). Ahora van en las herramientas mismas:

- Herramientas privadas: si fallan o la conexión se cierra, es falta de sesión; decirlo, ofrecer el teléfono y no reintentar.
- Catálogo y envíos/pagos: responder solo con lo que devuelven, sin agregar plazos, condiciones o consecuencias.
- buscar_en_sitio y leer_pagina: citar solo lo que dice el sitio, usar la calculadora en lugar de calcular, y responder en el
  idioma de la pregunta.

Las instrucciones del servidor se quedan igual (sirven a los clientes que sí las usan).
