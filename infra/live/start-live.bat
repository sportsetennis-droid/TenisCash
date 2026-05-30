@echo off
REM =====================================================================
REM  Sports & Tennis - Live Commerce - liga a transmissao da loja
REM =====================================================================
REM  Duplo-clique neste arquivo no notebook da loja pra colocar a camera
REM  no ar. Sobe o MediaMTX (le a camera Tapo) e o Cloudflare Tunnel
REM  (publica na internet). Pra desligar: feche as duas janelas que abrem.
REM
REM  INSTALACAO (faz uma vez por notebook):
REM   1) MediaMTX: baixe em
REM        https://github.com/bluenviron/mediamtx/releases
REM      o arquivo  mediamtx_vX.X.X_windows_amd64.zip , extraia e copie
REM      o  mediamtx.exe  pra ESTA pasta (a mesma deste .bat).
REM   2) cloudflared: baixe em
REM        https://github.com/cloudflare/cloudflared/releases
REM      o  cloudflared-windows-amd64.exe , renomeie pra  cloudflared.exe
REM      e copie pra ESTA pasta. (Ou instale:  winget install Cloudflare.cloudflared)
REM   3) Edite o  mediamtx.yml  e preencha usuario, senha e IP da camera.
REM
REM  DEPOIS DE RODAR:
REM   - A janela do Cloudflare imprime uma linha tipo:
REM        https://algумas-palavras.trycloudflare.com
REM   - A URL do video que voce cola no painel /atendimento e essa +
REM        /loja01/index.m3u8
REM     Ex:  https://algumas-palavras.trycloudflare.com/loja01/index.m3u8
REM   - OBS: no "quick tunnel" essa URL MUDA cada vez que liga. Pra ter
REM     uma URL FIXA (live.teniscash.com.br), veja o bloco TUNEL NOMEADO
REM     no fim deste arquivo.
REM =====================================================================

cd /d "%~dp0"

if not exist "mediamtx.exe" (
  echo [ERRO] mediamtx.exe nao encontrado nesta pasta. Veja a INSTALACAO no topo deste arquivo.
  pause
  exit /b 1
)
if not exist "cloudflared.exe" (
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo [ERRO] cloudflared nao encontrado. Veja a INSTALACAO no topo deste arquivo.
    pause
    exit /b 1
  )
)

echo Subindo MediaMTX (camera -^> HLS local :8888)...
start "MediaMTX - Sports e Tennis" mediamtx.exe mediamtx.yml

echo Aguardando a camera conectar...
timeout /t 4 /nobreak >nul

echo Publicando na internet via Cloudflare...
echo (a URL https://....trycloudflare.com aparece na janela do Cloudflare)
start "Cloudflare Tunnel - Sports e Tennis" cloudflared.exe tunnel --url http://localhost:8888

echo.
echo ============================================================
echo  No ar! Cole no painel /atendimento (engrenagem):
echo    https://SEU-LINK.trycloudflare.com/loja01/index.m3u8
echo  Depois clique em "Entrar ao vivo".
echo  Para desligar: feche as duas janelas (MediaMTX e Cloudflare).
echo ============================================================
echo.
pause

REM =====================================================================
REM  TUNEL NOMEADO (URL fixa - producao, opcional)
REM =====================================================================
REM  O quick tunnel acima e otimo pra testar, mas a URL muda toda vez.
REM  Pra uma URL fixa tipo  https://live-loja01.teniscash.com.br  (precisa
REM  do dominio teniscash.com.br gerenciado na Cloudflare):
REM
REM    cloudflared login
REM    cloudflared tunnel create teniscash-live
REM    cloudflared tunnel route dns teniscash-live live-loja01.teniscash.com.br
REM
REM  Crie um config.yml do cloudflared (em %USERPROFILE%\.cloudflared\):
REM    tunnel: teniscash-live
REM    credentials-file: C:\Users\<voce>\.cloudflared\<id-do-tunel>.json
REM    ingress:
REM      - hostname: live-loja01.teniscash.com.br
REM        service: http://localhost:8888
REM      - service: http_status:404
REM
REM  E rode (no lugar do quick tunnel):
REM    cloudflared tunnel run teniscash-live
REM
REM  A URL fixa do video fica:
REM    https://live-loja01.teniscash.com.br/loja01/index.m3u8
REM  Cola UMA vez no painel e nao precisa mexer mais.
REM =====================================================================
