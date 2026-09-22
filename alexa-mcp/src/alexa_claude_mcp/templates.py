"""The one HTML page this server serves: the consent screen."""

from __future__ import annotations

from html import escape

_PAGE = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Conectar ao Claude</title>
<style>
  :root {{ color-scheme: light dark; --bg:#f5f5f4; --card:#fff; --fg:#1c1917; --muted:#57534e;
           --accent:#cc785c; --border:#e7e5e4; --error:#b91c1c; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#1c1917; --card:#292524; --fg:#fafaf9; --muted:#a8a29e;
             --border:#44403c; --error:#fca5a5; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
          background:var(--bg); color:var(--fg); padding:24px;
          font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }}
  .card {{ background:var(--card); border:1px solid var(--border); border-radius:14px;
           padding:32px; width:100%; max-width:420px; }}
  h1 {{ font-size:1.25rem; margin:0 0 8px; }}
  p {{ color:var(--muted); font-size:.92rem; line-height:1.5; margin:0 0 20px; }}
  strong {{ color:var(--fg); }}
  label {{ display:block; font-size:.85rem; font-weight:600; margin-bottom:6px; }}
  input {{ width:100%; padding:11px 12px; font-size:1rem; border-radius:8px;
           border:1px solid var(--border); background:var(--bg); color:var(--fg); }}
  input:focus {{ outline:2px solid var(--accent); outline-offset:1px; }}
  .row {{ display:flex; gap:10px; margin-top:20px; }}
  button {{ flex:1; padding:11px 14px; font-size:.95rem; font-weight:600; border-radius:8px;
            border:1px solid var(--border); cursor:pointer; background:var(--card); color:var(--fg); }}
  button.primary {{ background:var(--accent); border-color:var(--accent); color:#fff; }}
  .error {{ color:var(--error); font-size:.88rem; margin:0 0 16px; }}
</style>
</head>
<body>
  <main class="card">
    <h1>Conectar ao Claude</h1>
    {body}
  </main>
</body>
</html>
"""

_FORM = """<p><strong>{client_name}</strong> quer acessar o seu Claude por voz.
    Digite a senha do add-on para autorizar.</p>
    {error}
    <form method="post" action="/login">
      <input type="hidden" name="request_id" value="{request_id}">
      <label for="password">Senha do add-on</label>
      <input id="password" name="password" type="password" autocomplete="current-password"
             autofocus required>
      <div class="row">
        <button type="submit" name="action" value="deny">Cancelar</button>
        <button type="submit" name="action" value="allow" class="primary">Autorizar</button>
      </div>
    </form>"""

_EXPIRED = """<p>{message}</p>
    <p>Volte ao aplicativo Alexa e inicie a conexão do add-on novamente.</p>"""


def render_login(*, request_id: str, client_name: str, error: str) -> str:
    """Render the consent form, or an explanation when there is nothing to consent to."""
    if not request_id:
        return _PAGE.format(body=_EXPIRED.format(message=escape(error or "Sessão de autorização expirada.")))
    error_html = f'<p class="error">{escape(error)}</p>' if error else ""
    return _PAGE.format(
        body=_FORM.format(
            client_name=escape(client_name or "Um cliente MCP"),
            request_id=escape(request_id),
            error=error_html,
        )
    )
