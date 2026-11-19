// Prepara o arquivo antes de enviar (currículo em /vagas, documento no Meu RH).
// Dono 19/11/2026: "Currículo grande demais? Isso não pode acontecer" (print de iPhone em PNG passa de 8 MB).
// Foto: reduz no próprio celular para JPEG de até 2400 px (fica legível e leve). PDF: vai como está (até 20 MB).
(function () {
  var MAX = 20 * 1024 * 1024;
  var TARGET = 3 * 1024 * 1024;
  function loadImage(file) {
    if (window.createImageBitmap) return createImageBitmap(file).catch(function () { return viaImg(file); });
    return viaImg(file);
  }
  function viaImg(file) {
    return new Promise(function (res) {
      var u = URL.createObjectURL(file); var i = new Image();
      i.onload = function () { res(i); }; i.onerror = function () { res(null); }; i.src = u;
    });
  }
  function toBlob(canvas, q) { return new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', q); }); }
  window.rhPrepareFile = async function (file) {
    if (!file) return null;
    var isImg = /^image\//.test(file.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name || '');
    if (!isImg) {
      if (file.size > MAX) throw new Error('PDF grande demais (máx. 20 MB). Envie uma foto do currículo.');
      return file;
    }
    if (file.size <= 1.5 * 1024 * 1024 && /^image\/(jpeg|webp)$/.test(file.type)) return file; // já é leve
    var img = await loadImage(file);
    if (!img) {
      if (file.size <= MAX && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
      throw new Error('Não consegui abrir essa foto. Tente outra foto ou envie em PDF.');
    }
    var w = img.width, h = img.height, k = Math.min(1, 2400 / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    var blob = null, qs = [0.85, 0.72, 0.6, 0.5];
    for (var n = 0; n < qs.length; n++) { blob = await toBlob(c, qs[n]); if (blob && blob.size <= TARGET) break; }
    if (!blob) throw new Error('Não consegui preparar essa foto. Tente outra ou envie em PDF.');
    var name = String(file.name || 'curriculo').replace(/\.[^.]+$/, '') + '.jpg';
    try { return new File([blob], name, { type: 'image/jpeg' }); } catch (_) { blob.name = name; return blob; }
  };
})();
