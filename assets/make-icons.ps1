# Renders public\icon.svg and writes:
#   public\icon-192.png, public\icon-512.png   for the page and its app manifest
#   assets\local-collab.ico                     for the desktop shortcut
# Edge (headless, with a throwaway profile) draws the SVG at 1024 px with a
# transparent background, so gradients, shadows and glows match the browser.
# Run after changing the design: powershell -File assets\make-icons.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$appDir = Split-Path -Parent $PSScriptRoot
$svg = Join-Path $appDir "public\icon.svg"
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found" }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("local-collab-icon-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
  $svgUrl = "file:///" + ($svg -replace '\\', '/')
  $html = Join-Path $work "render.html"
  Set-Content -Encoding utf8 $html "<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:1024px;height:1024px}</style></head><body><img src=`"$svgUrl`"></body></html>"
  $shot = Join-Path $work "icon-1024.png"
  $args = @("--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=$(Join-Path $work 'profile')", "--default-background-color=00000000",
    "--force-device-scale-factor=1", "--window-size=1024,1024", "--screenshot=$shot", ("file:///" + ($html -replace '\\', '/')))
  Start-Process -FilePath $edge -ArgumentList $args -Wait -WindowStyle Hidden
  if (-not (Test-Path $shot)) { throw "Edge did not write the screenshot" }
  $master = [System.Drawing.Bitmap]::FromFile($shot)

  function Scale([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($master, 0, 0, $size, $size)
    $g.Dispose()
    return $bmp
  }

  function To-Png($bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return ,$ms.ToArray()
  }

  # The classic icon entry: a 32-bit BGRA bitmap, bottom-up, with a doubled
  # height and an empty AND mask. PNG entries below 256 px are not read by
  # every Windows component, so only the 256 px entry is PNG.
  function To-Dib($bmp) {
    $size = $bmp.Width
    $maskRow = [Math]::Ceiling($size / 32) * 4
    $ms = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $ms
    $w.Write([UInt32]40); $w.Write([Int32]$size); $w.Write([Int32]($size * 2))
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]0)
    $w.Write([UInt32]($size * $size * 4 + $maskRow * $size))
    $w.Write([Int32]0); $w.Write([Int32]0); $w.Write([UInt32]0); $w.Write([UInt32]0)
    for ($y = $size - 1; $y -ge 0; $y--) {
      for ($x = 0; $x -lt $size; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $w.Write([byte]$c.B); $w.Write([byte]$c.G); $w.Write([byte]$c.R); $w.Write([byte]$c.A)
      }
    }
    $w.Write((New-Object byte[] ($maskRow * $size)))
    $w.Flush()
    return ,$ms.ToArray()
  }

  foreach ($size in 192, 512) {
    $bmp = Scale $size
    [System.IO.File]::WriteAllBytes((Join-Path $appDir "public\icon-$size.png"), (To-Png $bmp))
    $bmp.Dispose()
  }

  $sizes = 16, 24, 32, 48, 64, 128, 256
  $images = foreach ($s in $sizes) {
    $bmp = Scale $s
    if ($s -ge 256) { ,(To-Png $bmp) } else { ,(To-Dib $bmp) }
    $bmp.Dispose()
  }
  $master.Dispose()

  $out = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter $out
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$images[$i].Length); $w.Write([UInt32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($img in $images) { $w.Write($img) }
  $w.Flush()
  [System.IO.File]::WriteAllBytes((Join-Path $appDir "assets\local-collab.ico"), $out.ToArray())
  Write-Output "Wrote public\icon-192.png, public\icon-512.png and assets\local-collab.ico"
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
