# Método Simplex — Servidor MCP + CLI

Servidor [Model Context Protocol](https://modelcontextprotocol.io) desplegable
en Cloudflare Workers que resuelve problemas de Programación Lineal con el
**Método Simplex** (Big-M cuando se requieren variables artificiales) y devuelve:

- una solución JSON paso a paso (cada tableau con su columna pivote, fila
  pivote, elemento pivote resaltado; `Cj`, `Zj`, `Cj − Zj`, razones,
  operaciones de fila; modelo general, modelo estándar y solución óptima), y
- un archivo `.xlsx` con el mismo contenido formateado al estilo pedagógico
  de las tablas usadas en clase, entregado como URL de descarga firmada con HMAC.

El mismo solver está disponible también como CLI Python autónomo
([`main.py`](main.py)) para uso local sin MCP.

## Herramientas MCP expuestas

| Tool                    | Entrada                                                                 | Salida                                                                                  |
|-------------------------|-------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| `parse_lp_text`         | `{ text: string }` — lenguaje natural ("maximizar Z = 3x + 2y s.a. …") | JSON `Problem` estructurado, listo para `solve_simplex_problem`                         |
| `solve_simplex_problem` | LP estructurado (`objective`, `variables`, `objective_coefficients`, `constraints`, `delivery: "url" \| "inline"` opcional) | `SolveResult` JSON + `.xlsx` descargable (URL firmada por defecto; base64 si se pide)   |

Las dos son componibles: un LLM puede llamar primero a `parse_lp_text` para
obtener el JSON, inspeccionarlo, y luego invocar `solve_simplex_problem` —
o saltarse el parser cuando ya tiene el problema estructurado.

## Conectar un cliente MCP

El servidor habla [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)
en `POST /mcp` y SSE legacy en `GET /sse`. Cualquier cliente MCP compatible
sirve (Claude Code, Claude Desktop, MCP Inspector, integraciones propias).

1. Copia [`.mcp.json.example`](.mcp.json.example) a `.mcp.json`.
2. Reemplaza `YOUR-WORKER-NAME` por el subdominio del worker desplegado y
   `YOUR_MCP_AUTH_TOKEN_HERE` por el bearer token configurado como secret
   `MCP_AUTH_TOKEN` (ver [Despliegue](#despliegue-propio-en-cloudflare)).
3. Si usas Claude Code, el archivo `.mcp.json` en la raíz del proyecto se
   detecta automáticamente. Para otros clientes, registra la URL `…/mcp` y
   añade la cabecera `Authorization: Bearer <token>`.

Para probar interactivamente sin escribir código de cliente:

```bash
npx @modelcontextprotocol/inspector
# pega la URL del worker + el bearer token; lista herramientas y las invocas
```

## Despliegue propio en Cloudflare

Setup único por cuenta:

```bash
cd mcp-server
npm install
npx wrangler r2 bucket create simplex-xlsx
npx wrangler secret put SIGNING_SECRET     # cualquier string aleatorio de 32+ chars
npx wrangler secret put MCP_AUTH_TOKEN     # bearer token que exigirá el server
```

Despliegue:

```bash
npx wrangler deploy
```

Wrangler imprime la URL desplegada (p. ej. `https://simplex-mcp.<cuenta>.workers.dev`).
Más detalles, layout del proyecto y desarrollo local en
[`mcp-server/README.md`](mcp-server/README.md).

## CLI Python local (sin MCP)

Si no necesitas el servidor MCP y solo quieres generar el Excel a partir de un
JSON, usa la CLI Python:

```bash
pip install -r requirements.txt    # requiere Python ≥ 3.10
python main.py problem1.json output1.xlsx
```

Si se omiten los argumentos, lee `problem.json` y escribe `output.xlsx`.

## Esquema de entrada

Tanto la CLI como `solve_simplex_problem` aceptan el mismo esquema:

```json
{
  "name": "Problema X - Descripción",
  "objective": "max",
  "variables": ["X1", "X2"],
  "objective_coefficients": [3000, 2000],
  "constraints": [
    {"name": "Materia prima A",     "coefficients": [1, 2],  "sign": "<=", "rhs": 6},
    {"name": "Materia prima B",     "coefficients": [2, 1],  "sign": "<=", "rhs": 8},
    {"name": "Demanda exteriores",  "coefficients": [-1, 1], "sign": "<=", "rhs": 1},
    {"name": "Demanda interiores",  "coefficients": [0, 1],  "sign": "<=", "rhs": 2}
  ]
}
```

- `objective`: `"max"` o `"min"`.
- `sign`: uno de `"<="`, `"="`, `">="`.
- Si un `rhs` viene negativo, el solver invierte la fila automáticamente.

## Casos especiales detectados

- **No acotado** — la columna entrante no tiene entradas positivas; estado
  `unbounded`.
- **Infactible** — al terminar queda alguna variable artificial en la base con
  RHS positivo; estado `infeasible`.

Ambos quedan documentados en el JSON y en el bloque final del `.xlsx`.

## Ejemplos incluidos

- [`problem1.json`](problem1.json) — Reddy Miks Company (maximización, 4 restricciones `<=`).
  Resultado esperado: `X1 = 10/3`, `X2 = 4/3`, `Z = 12666 2/3`.
- [`problem2.json`](problem2.json) — Compañía de Combustibles (minimización, mezcla de `<=` y `>=`).
  Resultado esperado: `X1 = 0`, `X2 = 2`, `S1 = 8`, `Z = 8`.
- [`problem3.json`](problem3.json) — Tercer caso de prueba con artificiales.

Las salidas de referencia están en [`output1.xlsx`](output1.xlsx),
[`output2.xlsx`](output2.xlsx) y [`output3.xlsx`](output3.xlsx).

## Licencia

[MIT](LICENSE).
