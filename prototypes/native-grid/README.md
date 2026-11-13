# native-grid: does a native photo grid scroll smoother than the app's WebKitGTK one?

A measurement, not a feature. Nothing in `app/`, `sidecar/` or `setup/` builds or reads this folder.

    bash prototypes/native-grid/run.sh

It builds two small programs, makes 512 synthetic thumbnails on the first run, opens one window
after the other, scrolls each by itself for about a minute, prints the two results side by side
and writes them to `results/<time>/native-grid-comparison.txt`. That one file is what to send.
Leave both windows visible and untouched while they scroll.

Needs, on Manjaro: `sudo pacman -S --needed base-devel pkgconf gtk4 gtk3 webkit2gtk-4.1 nodejs npm`
and Rust. `run.sh` checks and says what is missing. Wayland and X11 both work; nothing is forced.

## The two sides

| | native (`native/`) | baseline (`webkit/` + `web/`) |
|---|---|---|
| toolkit | GTK 4 `GridView`, gtk4-rs | WebKitGTK `webkit2gtk-4.1` on GTK 3: the API and the crate versions the app uses through Tauri/wry, with wry's settings |
| grid code | written here | the app's own `VirtualSections.tsx` + `PhotoGrid.tsx`, imported from `app/src`, mounted as the Photos view mounts them |
| thumbnails | fetched over HTTP by worker threads, decoded and scaled to tile size off the main thread, kept in an LRU (`--lru`, 2000) | `<img src>` per tile, as the app does with its thumbnail server; WebKit fetches and decodes |

`webkit2gtk-4.1` and not `webkitgtk-6.0`: the question is about the app as it ships, and 4.1 is
what it links. It is the same WebKit engine version either way; only the GTK major differs.

Shared by both, from one piece of code (`common/`): the tiles (20000, in month-like sections),
the thumbnail server (the same JPEGs, each tile under its own address so nothing is shared, a
5-40 ms wait per thumbnail that is the same for a given tile on both sides), six fetches at a
time (WebKit's limit per host, given to the native side too), the scroll script, the /proc
readings and the arithmetic. The page runs first; the native side is then given the page's
measured grid width and view size, so both show the same columns of the same tiles.

The script: 3 s still, 30 s down at 1500 px/s, a flick down (15000 px/s decaying), 2 s still,
15 s back up, a flick up, 2 s still. Position is a function of time, so both are at the same
place at the same moment whatever their frame rates.

## The WebKit grids (`--web-grids`, default `app,pool,canvas`)

The WebKit side runs once for each, then the native side once, and the report puts them in
columns side by side. The two that are not the app's are written here, in `web/grids/`, to
find out whether WebKit can scroll this many tiles at all and which way of building a grid
gets there, before anything in the app is changed:

| grid | what it is | what it tests |
|---|---|---|
| `app` | the app's `VirtualSections` + `PhotoGrid` | the app as it is |
| `pool` | the same tiles as plain DOM: a fixed set of elements, each placed by a transform, handed from the tiles that scroll away to those that scroll in; one screen built either side (the app builds two) | recycling, as Android's RecyclerView and iOS's collection views do: no element made or taken down while scrolling, no React |
| `canvas` | the view is one `<canvas>`, drawn on each scroll step; thumbnails fetched and decoded into `ImageBitmap`s in a worker, and fetches for tiles more than two screens away called off | drawing tiles the way a native grid does: no element per tile at all, no decode on the main thread |

`pool` and `canvas` ask for no thumbnail while the list moves faster than four screens a
second, and ask for what is on screen once it slows (Google Photos' web grid and Glide do
this during a fling), so their flings show more blank tiles by design. `canvas` draws no
rounded corners, hover or badges.

All three ask for thumbnails as the app now does, cut to the tile's size (`?w=`), and the
server cuts them (once per size, on the first ask) as the sidecar does.

## What is measured

- **Frame times**: gaps between GTK frame clock ticks natively, between `requestAnimationFrame`
  callbacks in the page. p50/p95/p99, and how many exceeded 33 ms and 50 ms.
- **Main thread busy**: CPU time of the UI thread from `/proc/<pid>/task/<pid>/stat`: the GTK main
  loop natively, the web process's main thread in WebKit (the one the app's profiles showed
  pinned). Also the seconds it was at 90% or more, as those profiles count it, and CPU of all
  threads of all processes.
- **Blank tiles**: ten times a second, the tiles on screen and how many have no picture.
- **Peak memory and threads**: all of a side's processes together.

## Options (given to `run.sh`, passed to both sides)

`--n 20000` `--tile 150` `--width 1600 --height 1000` `--lat-min 5 --lat-max 40` `--parallel 6`
`--photos DIR` (thumbnails from your own JPEGs instead of synthetic ones) `--unique 512`
`--speed 1500` `--fling 15000` `--scale 1.0` (script length) `--lru 2000` `--no-sections`
`--cache-dir DIR` (default `~/.cache/pfp-native-grid`) `--web-grids app,pool,canvas`.
`NG_ONLY=native` or `NG_ONLY=webkit` runs one side.

## What it does not tell you

- The page is scrolled by setting `scrollTop` every frame, the native list by setting its
  adjustment. A wheel or touchpad in WebKit scrolls on the compositor thread first, which this
  does not exercise. `requestAnimationFrame` gaps show what the main thread managed, not what
  reached the screen; read them with the main-thread and blank-tile lines.
- It is the app's grid, not the app: no sidecar, no decryption, no selection or badge state,
  no other views. If the baseline here is smooth while the app is not, the cause is outside
  these two components, which is worth knowing too.
- The native grid is a prototype: no month title lines (GTK's GridView has section breaks but
  no headers), no badges, hover, selection or fade-in. A real native UI would add work.
- The native side keeps tile-sized textures (about 80 KB each), WebKit decodes each 512 px
  JPEG at full size. That is a real difference between the two designs, and it is counted.
- The 512 pictures repeat across the 20000 tiles. Every tile is still fetched and decoded on
  its own, but they compress and look alike more than a real library does; `--photos` helps.
