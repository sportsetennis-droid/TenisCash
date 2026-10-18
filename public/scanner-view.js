/* Scanner camera, controls, and recent-read details. */
(function(root){
  'use strict';
  const markup = `<style>
@media (orientation:portrait){
  #etiq-controls{flex-shrink:0}
  #etiq-contador{height:32px;line-height:16px;overflow-y:auto}
  #etiq-lista{height:160px;max-height:160px!important;overflow-y:auto;overscroll-behavior:contain}
}
@media (orientation:landscape){
  #etiq-overlay,#cameraBox:not([hidden]){position:fixed!important;inset:0!important;width:100%!important;height:100%!important;display:block!important;background:#000!important;z-index:99998;box-sizing:border-box}
  #etiq-camera-area{position:absolute!important;inset:0!important;width:100%;height:100%}
  #etiq-video{width:100%!important;height:100%!important;object-fit:contain!important}
  #etiq-hint{top:6px!important;left:10px!important;right:10px!important;font-size:11px!important}
  #etiq-confirm{position:absolute!important;inset:0!important;width:auto!important;box-sizing:border-box;max-height:none;overflow:auto;padding:24px!important;background:rgba(0,0,0,.78)!important;border-radius:0;justify-content:center!important}
  #etiq-confirm-status{font-size:14px!important;margin-bottom:5px!important}
  #etiq-confirm-det{display:block!important;font-size:12px!important;line-height:1.25;margin-bottom:16px!important;min-height:0!important}
  #etiq-confirm[data-manual-photo=true]{max-height:72%!important}
  #etiq-confirm[data-manual-photo=true] #etiq-confirm-det{display:block!important;font-size:11px!important;line-height:1.25;margin-bottom:6px!important;min-height:0!important}
  #etiq-photo-preview{width:72px!important;height:48px!important;margin-bottom:4px!important}
  #etiq-confirm-btn{min-height:48px!important;font-size:16px!important;border-radius:8px!important;flex-shrink:0}
  #etiq-controls{position:absolute!important;bottom:0;left:0;right:0;height:auto!important;max-height:44vh;box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-end;gap:3px;padding:5px max(8px,env(safe-area-inset-right)) 5px max(8px,env(safe-area-inset-left))!important;background:rgba(0,0,0,.78)!important;overflow:hidden}
  #etiq-contador{font-size:10px!important;margin:0!important;max-width:100%;line-height:1.2}
  #etiq-lista{display:block!important;height:auto!important;max-height:calc(44vh - 95px)!important;min-height:48px;overflow-y:auto!important;overscroll-behavior:contain;font-size:10px!important;line-height:1.2!important;margin:0!important}
  #etiq-controls>div:last-child{flex-direction:row;gap:6px!important;margin:0!important}
  #etiq-controls button{min-height:38px!important;font-size:11px!important;flex:none!important;padding:4px 10px!important}
}
</style>
<div id="etiq-camera-area" style="position:relative;flex:1;min-height:0">
  <video id="etiq-video" playsinline muted style="width:100%;height:100%;object-fit:cover"></video>
  <div id="etiq-flash" style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(37,211,102,.35);color:#fff;font-size:20px;font-weight:900;text-shadow:0 2px 8px rgba(0,0,0,.6);text-align:center;padding:20px;pointer-events:none"></div>
  <div id="etiq-hint" style="position:absolute;top:12px;left:12px;right:12px;color:#fff;font-size:14px;font-weight:800;text-shadow:0 1px 4px #000;text-align:center;pointer-events:none">Leitura automática ativa — centralize a etiqueta e mantenha parada.</div>
  <div id="etiq-confirm" style="position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,.78);padding:24px;text-align:center">
    <div id="etiq-confirm-status" style="color:#fff;font-size:26px;font-weight:900;margin-bottom:8px">⏳ Salvando…</div>
    <div id="etiq-confirm-det" style="color:#bbb;font-size:14px;font-weight:600;margin-bottom:24px;min-height:20px"></div>
    <button id="etiq-confirm-btn" data-click="next" disabled style="width:100%;max-width:340px;min-height:58px;font-size:19px;font-weight:900;background:#555;color:#fff;border:none;border-radius:14px">AGUARDE…</button>
  </div>
</div>
<div id="etiq-controls" style="background:#111;padding:10px 12px calc(10px + env(safe-area-inset-bottom))">
  <div id="etiq-contador" style="color:#fff;font-size:13px;font-weight:800;margin-bottom:6px">fila 0 · salvas 0 · vinculadas 0</div>
  <div id="etiq-lista" style="max-height:160px;overflow-y:auto;font-size:12px;color:#ddd;line-height:1.3"></div>
  <div style="display:flex;gap:8px;margin-top:8px">
    <button id="etiq-capturar" data-click="capture" style="flex:2;min-height:54px;font-size:16px;font-weight:900;background:#0a84ff;color:#fff;border:none;border-radius:12px">📸 CAPTURAR MANUALMENTE</button>
    <button data-click="close" style="flex:1;min-height:54px;font-size:14px;font-weight:800;background:#d70015;color:#fff;border:none;border-radius:12px">✕ FECHAR</button>
  </div>
</div>`;
  root.ScannerView = { markup: () => markup };
})(window);
