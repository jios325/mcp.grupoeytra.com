# Métricas

- **Aprobada**: las cuatro de abajo a la vez (Herramienta, Hechos = 1, Cumple y Sin inventar).
- **Cumple** (juez, Claude Sonnet 5.5): la respuesta satisface el criterio del caso (`eval/casos.json`).
- **Sin inventar** (juez): cada dato concreto (precio, plazo, norma, teléfono, URL, cobertura) sale de lo que devolvieron las herramientas.
- **Herramienta**: llamó al menos una de las herramientas esperadas del caso.
- **Hechos**: fracción de los patrones `debe_contener` que aparecen en la respuesta.
