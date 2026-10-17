# Builds assets\dlna-cast.ico: the goggles mark from src\gui\public\icon.svg, drawn with System.Drawing at each
# Windows icon size and packed as PNG frames. Run: powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force $assets | Out-Null

function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# The same geometry as icon.svg, in its 40x40 coordinate space.
function New-GogglesPath {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath ([System.Drawing.Drawing2D.FillMode]::Alternate)
  $p.AddArc(3, 11, 10, 10, 180, 90)          # top-left corner
  $p.AddArc(27, 11, 10, 10, 270, 90)         # top-right corner
  $p.AddArc(27, 19, 10, 10, 0, 90)           # bottom-right corner
  $p.AddLine(32, 29, 23.5, 29)
  $p.AddLine(23.5, 29, 20, 24.9)             # up into the nose bridge
  $p.AddLine(20, 24.9, 16.5, 29)
  $p.AddLine(16.5, 29, 8, 29)
  $p.AddArc(3, 19, 10, 10, 90, 90)           # bottom-left corner
  $p.CloseFigure()
  $p.AddPath((New-RoundedRect 6.5 14 11.5 9 3.5), $false)   # left lens (cut out by the alternate fill)
  $p.AddPath((New-RoundedRect 22 14 11.5 9 3.5), $false)    # right lens
  return $p
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$frames = foreach ($size in $sizes) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.ScaleTransform($size / 40, $size / 40)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#23272C'))), (New-RoundedRect 0 0 40 40 9))
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#F2A541'))), (New-GogglesPath))
  $g.Dispose()
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($size -eq 256) { $bitmap.Save((Join-Path $assets 'dlna-cast-256.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bitmap.Dispose()
  [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
}

# ICO container: header, one 16-byte directory entry per frame, then the PNG data.
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$f.Bytes.Length); $w.Write([uint32]$offset)
  $offset += $f.Bytes.Length
}
foreach ($f in $frames) { $w.Write($f.Bytes) }
$w.Flush()
$icoPath = Join-Path $assets 'dlna-cast.ico'
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
"Wrote $icoPath ($($out.Length) bytes, sizes $($sizes -join ', '))"
