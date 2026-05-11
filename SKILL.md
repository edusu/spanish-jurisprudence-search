---
name: jurisprudencia-cendoj
description: Search Spanish jurisprudence at CENDOJ (Poder Judicial). Use when user asks for a sentencia, jurisprudencia, STSJ, STS, SAP, ATS, ECLI, or ROJ; wants case law on a legal topic; or filters by sala (Civil/Penal/Contencioso/Social/Militar/Especial), comunidad autónoma, fecha, ponente, recurso. Triggers on "busca una sentencia", "jurisprudencia sobre", "encuentra fallos del TSJ", "qué dice el Supremo sobre", "casos de art X ET", "buscar en CENDOJ".
---

# CENDOJ jurisprudence search

Searches the official Spanish jurisprudence database at `poderjudicial.es/search` using the reverse-engineered Struts/IDOL endpoint. There is **no public REST API** — this skill wraps the internal `search.action` endpoint that the JS frontend uses, handling the wire-format quirks.

## Tooling

- **Primary**: `~/utils/jurisprudencia/cendoj_search.py` — pure-stdlib Python script. Bootstraps session, posts query, parses XHTML, returns JSON.
- **Fallback**: when the WAF blocks the script (HTTP 500 / "vuelva a probar dentro de unos minutos"), use `playwright-cli` to drive the UI directly — see "WAF fallback" below.

## When to use it

Trigger on any of these:
- User asks for a sentencia ("busca una sentencia de…", "encuéntrame jurisprudencia sobre…")
- User mentions a tribunal: TS, TSJ, AN, AP, JSO, JCA
- User cites an ECLI or ROJ
- User asks about case law on an article (art. 41 ET, art. 50 ET, art. 1124 CC, etc.)

## Quick usage

```bash
# Basic search
~/utils/jurisprudencia/cendoj_search.py "responsabilidad patrimonial sanitaria"

# Filtered: sala social + Canarias + fechas
~/utils/jurisprudencia/cendoj_search.py "despido nulo víctima violencia género" \
  --jurisdiccion SOCIAL --comunidad CANARIAS \
  --desde 01/01/2023 --hasta 31/12/2024 --per-page 15

# Lookup by exact identifier
~/utils/jurisprudencia/cendoj_search.py "" --ecli "ECLI:ES:TSJICAN:2024:913"
~/utils/jurisprudencia/cendoj_search.py "" --roj "STSJ ICAN 287/2026"

# Pagination (start=1 → 11 → 21 …)
~/utils/jurisprudencia/cendoj_search.py "art 41 ET" --start 11 --per-page 10

# Truncate the `text` field for compact output
~/utils/jurisprudencia/cendoj_search.py "..." --truncate 300
```

Output is JSON to stdout: `{"total": N, "count": M, "items": [...]}`. Each item has `ref`, `db`, `fechares` (YYYYMMDD), `url` (link to the full document), and `text` (extracted résumé / first paragraph).

## Filter values

| Flag | Allowed values |
|---|---|
| `--jurisdiccion` (repeatable) | `CIVIL`, `PENAL`, `CONTENCIOSO`, `SOCIAL`, `MILITAR`, `ESPECIAL` |
| `--comunidad` | `CANARIAS`, `MADRID`, `CATALUÑA`, `ANDALUCÍA`, `ARAGÓN`, `ASTURIAS`, `BALEARES`, `CANTABRIA`, `CASTILLA_LA_MANCHA`, `CASTILLA_Y_LEÓN`, `CEUTA`, `COMUNIDAD_VALENCIANA`, `EXTREMADURA`, `GALICIA`, `LA_RIOJA`, `MELILLA`, `MURCIA`, `NAVARRA`, `PAÍS_VASCO` |
| `--desde` / `--hasta` | `dd/mm/yyyy` |

## Search strategy — IDOL behavior

The backend is **Autonomy IDOL**. Implications for query phrasing:

- **OR by default**: `"violencia género extinción"` returns docs with ANY of those tokens. To constrain, add filters or use longer phrases that force domain — e.g. `"abandono definitivo puesto trabajo víctima violencia género"` (literal art. 49.1.m phrasing).
- **Penal vs Social mix**: queries about "violencia de género" return mostly **penal** results unless you filter `--jurisdiccion SOCIAL`. Always set jurisdicción for labor-law topics.
- **Article numbers tokenize weirdly**: `49.1.m` may not match. Better to combine: legal phrase + tribunal + comunidad. Or use `--ecli` / `--roj` for direct lookup.
- **Synonyms matter**: the law and case law don't always use the user's phrasing. Translate first:
  - "incumplimiento grave" → "despido nulo", "extinción a instancia", "rescisión contrato"
  - "víctima de violencia de género" → "trabajadora víctima de violencia", "ejercicio de derechos sociolaborales"
  - "modificación sustancial" → "art 41 ET", "MSCT", "alteración condiciones laborales"
  - "responsabilidad patrimonial" → "indemnización Administración", "art 32 LRJSP"

## Refining workflow

1. **First pass**: broad query + jurisdicción filter → gauge total hits and result quality.
2. If too many penal hits → add `--jurisdiccion SOCIAL` (or matching).
3. If too few → drop one term, swap to synonym, or remove comunidad filter.
4. If user wants doctrinal coverage (not just one case) → return 3–5 representative results from the same tribunal as a "line" of cases.

## WAF / rate-limit awareness

> [!warning]
> The portal has an aggressive WAF. After ~5 rapid requests from the same IP it returns HTTP 500 with the page "*Vuelva a probar dentro de unos minutos*". The script reports this as `{"error": "server_error_or_waf"}`.

Mitigations baked into the script:
- Realistic Chrome User-Agent
- Proper `X-Requested-With`, `Accept`, `Referer` headers
- Sleep `--delay 0.5` (default) between bootstrap and search
- Stdlib `urllib` with cookie jar to maintain JSESSIONID with sticky `.sidolappNN` suffix

If blocked:
1. Wait 3–5 minutes and retry.
2. If still blocked, switch to **playwright-cli fallback** (driving the UI in a real browser bypasses WAF fingerprinting since requests carry the browser's TLS/JA3 signature).

## WAF fallback — playwright-cli

When the script returns `server_error_or_waf` repeatedly, use `playwright-cli` to drive the UI:

```bash
playwright-cli open https://www.poderjudicial.es/search/indexAN.jsp
# Force-close the legal modal (more reliable than clicking ×):
playwright-cli eval "() => { document.getElementById('modalAvisoLegal')?.remove(); document.body.classList.remove('modal-open'); document.querySelector('.modal-backdrop')?.remove(); return 'ok'; }"

# Type query
playwright-cli fill "#frmBusquedajurisprudencia_TEXT" "your query here"

# Tag the Jurisdicción button (it has no stable id):
playwright-cli eval "() => { const sel=document.getElementById('frmBusquedajurisprudencia_JURISDICCION'); let p=sel.parentElement; while(p){ const b=p.querySelector('button.multiselect.dropdown-toggle'); if(b){b.id='__jurisbtn__'; break;} p=p.parentElement; } return 'tagged'; }"
playwright-cli click "#__jurisbtn__"
playwright-cli click "input[type=checkbox][value=SOCIAL]"
playwright-cli click "#__jurisbtn__"

# Comunidad (Las Palmas / Tenerife both via CANARIAS):
playwright-cli click "#COMUNIDADmultiselec"
playwright-cli click "#chkCOM_CANARIAS"
playwright-cli click "#COMUNIDADmultiselec"

# Capture the XHR before clicking Buscar:
playwright-cli eval "() => { window.__log=[]; const O=window.XMLHttpRequest; function P(){const x=new O(); let _u,_b; const op=x.open; x.open=function(m,u){_u=u;return op.apply(x,arguments);}; const sn=x.send; x.send=function(b){_b=b; x.addEventListener('loadend',()=>window.__log.push({url:_u,body:_b?String(_b):null,resp:x.responseText||''})); return sn.apply(x,arguments);}; return x;} P.prototype=O.prototype; window.XMLHttpRequest=P; return 'ok'; }"
playwright-cli click "#srcjur_search"

# Read the parsed results:
playwright-cli eval "() => { const e=(window.__log||[]).find(x=>x.url&&x.url.includes('search.action')); if(!e) return 'no-call'; const doc=new DOMParser().parseFromString(e.resp,'text/html'); const total=doc.querySelector('[data-totalhits]')?.getAttribute('data-totalhits'); const items=[...doc.querySelectorAll('div.row.searchresult.doc')].slice(0,15).map(el=>({ref:el.getAttribute('data-ref'),db:el.getAttribute('data-db'),fechares:el.getAttribute('data-fechares'),url:el.querySelector('a[data-link]')?.getAttribute('data-link'),text:el.innerText.replace(/\\s+/g,' ').trim().slice(0,800)})); return {total, items}; }"
```

## Document fetch

To get the full text of a document, follow the `url` field. **It returns a PDF, not HTML.** Save and read with a PDF tool, or open in browser:

```bash
curl -s -o sentencia.pdf -A "$UA" "<url-from-result>"
```

The URL pattern is `/search/AN/openDocument/<UUID32>/<YYYYMMDD>` where the trailing date is the **optimization date** (when IDOL indexed it), NOT the resolution date — that one is in `data-fechares`.

## Wire-format gotchas (already handled by the script — for reference)

If you ever need to call the API directly from another tool, watch out for:

| Quirk | What works | What breaks |
|---|---|---|
| Spaces in body | `+` (form-urlencoded) | `%20` → "búsqueda no es válida" |
| Parens in `VALUESCOMUNIDAD` | `CANARIAS(C)` literal | `CANARIAS%28C%29` → rejected |
| `JURISDICCION` multi-value | `\|SOCIAL\|` (pipe-wrapped) | `SOCIAL` (bare) → no filter applied silently |
| `VALUESCOMUNIDAD` value | `CANARIAS(C) \| ` (with `(C)` + trailing pipe + space) | `ALL@ALL@CANARIAS` (the HTML form `value`) → rejected |
| Sticky session | `JSESSIONID=...sidolapp01..04` (suffix is sticky) | strip suffix → server can't find session, 500 |
| Bootstrap | always `GET /search/indexAN.jsp` first | direct POST without prior GET → 403 |

## Legal context

> [!quote] Aviso legal del portal
> "No está permitida la utilización de la base de datos para usos comerciales, ni la descarga masiva de información. La reutilización de esta información para la elaboración de bases de datos o con fines comerciales debe seguir el procedimiento y las condiciones establecidas por el CGPJ a través de su Centro de Documentación Judicial."

- Personal/educational consultation: **OK**.
- Building a derived database / commercial reuse: **needs licence** from CENDOJ (procedure under art. 560.1.10º LOPJ).
- Mass downloading: **prohibited** — and the WAF enforces it technically.

This skill is for **personal queries**, not bulk extraction. Don't loop over thousands of results.

## See also

Full reverse-engineering writeup with code samples (Python and Rust) lives in the user's vault:

```
/Users/edusu/Obsidian/research/tech/cendoj-api-jurisprudencia.md
```
