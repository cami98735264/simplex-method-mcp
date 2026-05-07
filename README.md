# Método Simplex — Solver paso a paso

Resuelve problemas de Programación Lineal con el **Método Simplex** (Big M cuando
se requiere) y genera un archivo Excel que reproduce **paso a paso** el estilo de
las tablas usadas en clase: cada tableau con su columna pivote, fila pivote y
elemento pivote resaltados; coeficientes Big-M conservados de forma simbólica
(`3 - 4M`, `M - 1/3`, …); fracciones exactas (`2 2/3`, `-1/12`, …); y un bloque
final con la **SOLUCIÓN ÓPTIMA**.

## Instalación

```bash
pip install -r requirements.txt
```

Requiere Python ≥ 3.10.

## Uso

```bash
python main.py problem1.json output1.xlsx
python main.py problem2.json output2.xlsx
```

Si se omiten los argumentos, lee `problem.json` y escribe `output.xlsx`.

## Esquema JSON

```json
{
  "name": "Problema X - Descripción",
  "objective": "max",
  "variables": ["X1", "X2"],
  "objective_coefficients": [3000, 2000],
  "constraints": [
    {"name": "Materia prima A", "coefficients": [1, 2],  "sign": "<=", "rhs": 6},
    {"name": "Materia prima B", "coefficients": [2, 1],  "sign": "<=", "rhs": 8},
    {"name": "Demanda exteriores", "coefficients": [-1, 1], "sign": "<=", "rhs": 1},
    {"name": "Demanda interiores", "coefficients": [0, 1], "sign": "<=", "rhs": 2}
  ]
}
```

- `objective`: `"max"` o `"min"`.
- `sign`: uno de `"<="`, `"="`, `">="`.
- Si un `rhs` viene negativo, el solver invierte la fila automáticamente.

## Casos especiales detectados

- **No acotado** (entering column sin entradas positivas).
- **Infactible** (alguna variable artificial queda en la base con valor positivo
  al terminar).

Ambos quedan documentados en el bloque final del Excel.

## Ejemplos incluidos

- `problem1.json` — Reddy Miks Company (maximización, 4 restricciones `<=`).
  Resultado esperado: `X1 = 10/3`, `X2 = 4/3`, `Z = 12666 2/3`.
- `problem2.json` — Compañía de Combustibles (minimización, mezcla de `<=` y `>=`).
  Resultado esperado: `X1 = 0`, `X2 = 2`, `S1 = 8`, `Z = 8`.

## Servidor MCP (opcional)

El directorio [`mcp-server/`](mcp-server/) contiene un puerto del solver a
TypeScript desplegable como Cloudflare Worker, expuesto vía
[Model Context Protocol](https://modelcontextprotocol.io). Permite que un
cliente compatible (por ejemplo Claude Code) reciba el mismo Excel paso a paso
desde una descripción estructurada o en lenguaje natural del problema. Ver
[`mcp-server/README.md`](mcp-server/README.md) para instalación, despliegue y
configuración del cliente.

Si vas a conectar un cliente MCP local, copia
[`.mcp.json.example`](.mcp.json.example) a `.mcp.json` y reemplaza la URL del
worker y el token bearer.

## Licencia

[MIT](LICENSE).
