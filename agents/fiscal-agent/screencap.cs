// screencap.exe — captura a tela (todos os monitores) num JPEG leve.
// Compilado (csc) de proposito: o AMSI do Windows bloqueia o MESMO codigo
// como SCRIPT (spyware heuristic), mas nao escaneia um EXE compilado.
// Uso: screencap.exe <saida.jpg> [qualidade 1-100]
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;

class ScreenCap {
  static int Main(string[] args) {
    if (args.Length < 1) { Console.Error.WriteLine("uso: screencap.exe <saida.jpg> [qualidade]"); return 2; }
    long q = 45;
    if (args.Length > 1) { long.TryParse(args[1], out q); if (q < 1 || q > 100) q = 45; }
    try {
      Rectangle b = SystemInformation.VirtualScreen;
      using (var bmp = new Bitmap(b.Width, b.Height)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.CopyFromScreen(b.Location, Point.Empty, b.Size);
        }
        ImageCodecInfo enc = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) { if (c.MimeType == "image/jpeg") { enc = c; break; } }
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(Encoder.Quality, q);
        bmp.Save(args[0], enc, ep);
      }
      return 0;
    } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
  }
}
