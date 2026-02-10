# xterm.js Customizations and Hooks (Local v6.0.0)

Scope: This document is derived from the locally installed `@xterm/xterm` typings in this repo (`node_modules/@xterm/xterm/typings/xterm.d.ts`) and the installed addons. It reflects the API surface for **xterm.js v6.0.0** as used by `console-terminal`.

Where it is used in this repo:
- `console-terminal/ui/src/TerminalView.tsx` creates the terminal and loads addons.

## Useful Links

- xterm.js docs: https://xtermjs.org/docs/
- xterm.js GitHub: https://github.com/xtermjs/xterm.js
- FitAddon: https://github.com/xtermjs/xterm.js/tree/master/addons/xterm-addon-fit
- SerializeAddon: https://github.com/xtermjs/xterm.js/tree/master/addons/xterm-addon-serialize
- WebLinksAddon: https://github.com/xtermjs/xterm.js/tree/master/addons/xterm-addon-web-links

## Core Customization Surface

### Initialization Options (ITerminalOptions)
These can be passed to the `Terminal` constructor and most can be updated at runtime via `terminal.options`.

- `allowProposedApi`: Enable experimental/proposed APIs.
- `allowTransparency`: Allow non-opaque background. Must be set before `open()`.
- `altClickMovesCursor`: Alt+click moves the cursor.
- `convertEol`: Convert `\n` into `\r\n` when writing.
- `cursorBlink`: Blink the cursor.
- `cursorStyle`: `block | underline | bar`.
- `cursorWidth`: CSS pixels when cursorStyle is `bar`.
- `cursorInactiveStyle`: `outline | block | bar | underline | none`.
- `customGlyphs`: Draw custom glyphs for box/block characters.
- `disableStdin`: Disable input.
- `documentOverride`: Provide a custom `Document` reference.
- `drawBoldTextInBrightColors`: Render bold as bright colors.
- `fastScrollSensitivity`: Scroll multiplier when Alt is held.
- `fontSize`: Font size in pixels.
- `fontFamily`: Font family stack.
- `fontWeight`: Font weight for normal text.
- `fontWeightBold`: Font weight for bold text.
- `ignoreBracketedPasteMode`: Always paste without bracketed sequences.
- `letterSpacing`: Character spacing in pixels.
- `lineHeight`: Line height multiplier.
- `linkHandler`: Custom OSC-8 link handler.
- `logLevel`: `trace | debug | info | warn | error | off`.
- `logger`: Custom logger object.
- `macOptionIsMeta`: Treat Option as Meta on macOS.
- `macOptionClickForcesSelection`: Force selection even when mouse tracking is on.
- `minimumContrastRatio`: Enforce minimum text contrast.
- `reflowCursorLine`: Reflow the cursor line on resize.
- `rescaleOverlappingGlyphs`: Rescale ambiguous-width glyphs.
- `rightClickSelectsWord`: Select word on right click.
- `screenReaderMode`: Enable screen reader support.
- `scrollback`: Size of scrollback buffer.
- `scrollOnEraseInDisplay`: Push ED2 to scrollback (PuTTY behavior).
- `scrollOnUserInput`: Auto-scroll on input.
- `scrollSensitivity`: Scroll speed multiplier.
- `smoothScrollDuration`: Smooth scroll duration in ms.
- `tabStopWidth`: Tab size in spaces.
- `theme`: Color theme object.
- `windowsPty`: Windows PTY compatibility hints.
- `wordSeparator`: Characters treated as word separators for selection.
- `windowOptions`: Enable/disable window manipulation report features.
- `overviewRuler`: Controls overview ruler display.

### Init-Only Options (ITerminalInitOnlyOptions)
These are set at construction time and not meant to be updated later.

- `cols`: Initial columns.
- `rows`: Initial rows.

### Theme (ITheme)
All theme keys are optional and can be set via `terminal.options.theme`.

- `foreground`
- `background`
- `cursor`
- `cursorAccent`
- `selectionBackground`
- `selectionForeground`
- `selectionInactiveBackground`
- `scrollbarSliderBackground`
- `scrollbarSliderHoverBackground`
- `scrollbarSliderActiveBackground`
- `overviewRulerBorder`
- `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`
- `brightBlack`, `brightRed`, `brightGreen`, `brightYellow`, `brightBlue`, `brightMagenta`, `brightCyan`, `brightWhite`
- `extendedAnsi` (array for 16-255)

### Overview Ruler (IOverviewRulerOptions)
The overview ruler visualizes decorations near the scroll bar.

- `width`: Enables the overview ruler when set.
- `showTopBorder`
- `showBottomBorder`

### Window Manipulation (IWindowOptions)
These correspond to CSI `t` sequences and are all **disabled by default** for security.

- `restoreWin`
- `minimizeWin`
- `setWinPosition`
- `setWinSizePixels`
- `raiseWin`
- `lowerWin`
- `refreshWin`
- `setWinSizeChars`
- `maximizeWin`
- `fullscreenWin`
- `getWinState`
- `getWinPosition`
- `getWinSizePixels`
- `getScreenSizePixels`
- `getCellSizePixels`
- `getWinSizeChars`
- `getScreenSizeChars`
- `getIconTitle`
- `getWinTitle`
- `pushTitle`
- `popTitle`
- `setWinLines`

## Hooks and Events

### Terminal Events
All return an `IDisposable` so you can unsubscribe.

- `onBell`
- `onBinary`
- `onCursorMove`
- `onData`
- `onKey`
- `onLineFeed`
- `onRender`
- `onWriteParsed`
- `onResize`
- `onScroll`
- `onSelectionChange`
- `onTitleChange`

### Input Intercepts

- `attachCustomKeyEventHandler((event) => boolean)`: intercept key events.
- `attachCustomWheelEventHandler((event) => boolean)`: intercept wheel events.

### Parser Hooks (Escape Sequences)
Use `terminal.parser` to intercept or implement CSI/ESC/DCS/OSC sequences.

- `registerCsiHandler(id, (params) => boolean | Promise<boolean>)`
- `registerDcsHandler(id, (data, params) => boolean | Promise<boolean>)`
- `registerEscHandler(id, () => boolean | Promise<boolean>)`
- `registerOscHandler(ident, (data) => boolean | Promise<boolean>)`

### Link Handling Hooks

- `terminal.options.linkHandler`: Handle OSC-8 links.
- `terminal.registerLinkProvider(...)`: Provide custom link detection.
- `ILink`: supports `activate`, optional `hover` and `leave`, and `decorations`.
- `ILinkDecorations`: `pointerCursor`, `underline`.

## Decorations and Markers

- `registerMarker(cursorYOffset?)`: Create a tracked buffer marker.
- `registerDecoration(options)`: Overlay decorations (colors, DOM element, overview ruler markers).
- `IDecoration.onRender`: Hook when a decoration is rendered.
- `IDecoration.options`: Update overview ruler options.

Decoration options (IDecorationOptions):
- `marker`
- `anchor`: `left | right`
- `x`
- `width`
- `height`
- `backgroundColor`
- `foregroundColor`
- `layer`: `bottom | top`
- `overviewRulerOptions`: `color`, `position`

## Selection APIs

- `hasSelection()`
- `getSelection()`
- `getSelectionPosition()`
- `clearSelection()`
- `select(column, row, length)`
- `selectAll()`
- `selectLines(start, end)`

## Buffer Inspection (Read Access)
Use these to build features like search, snapshots, or analytics.

- `terminal.buffer`: access `normal`, `alternate`, `active`.
- `buffer.onBufferChange`: event when active buffer changes.
- `buffer.getLine(y)`: returns `IBufferLine`.
- `buffer.getNullCell()`: reuse cell object for performance.
- `IBufferLine.getCell(x, cell?)`
- `IBufferLine.translateToString(trimRight?, start?, end?)`
- `IBufferCell` getters: `getChars`, `getCode`, `getWidth`, color modes, and style flags.

## Unicode and Rendering Hooks (Experimental)

- `terminal.unicode.register(provider)` to add custom Unicode versions.
- `terminal.unicode.versions` to list available versions.
- `terminal.unicode.activeVersion` to select a version.
- `registerCharacterJoiner(handler)` and `deregisterCharacterJoiner(id)` for advanced grapheme/ligature joins (WebGL renderer only).
- `clearTextureAtlas()` to force a WebGL re-render when textures are corrupted.

## Addons Installed in This Repo
All addons are loaded via `terminal.loadAddon(addon)`.

### FitAddon (`@xterm/addon-fit`)
- `fit()`: Resize terminal to the container.
- `proposeDimensions()`: Preview target rows/cols.

### SerializeAddon (`@xterm/addon-serialize`)
- `serialize(options?)`: Serialize buffer into a string for restore.
- `serializeAsHTML(options?)`: Serialize to HTML for rich clipboard paste.
- `ISerializeOptions`: `range`, `scrollback`, `excludeModes`, `excludeAltBuffer`.
- `IHTMLSerializeOptions`: `scrollback`, `onlySelection`, `includeGlobalBackground`, `range`.

### WebLinksAddon (`@xterm/addon-web-links`)
- Constructor options: `handler`, `hover`, `leave`, `urlRegex`.

## Terminal API Surface You Can Use for Custom Behavior

- `terminal.options = { ... }` or `terminal.options.someOption = value`.
- `terminal.write(...)`, `terminal.writeln(...)`, `terminal.paste(...)`.
- `terminal.resize(cols, rows)`.
- `terminal.refresh(start, end)`.
- `terminal.reset()`.
- `terminal.scrollLines(...)`, `terminal.scrollPages(...)`, `terminal.scrollToTop()`, `terminal.scrollToBottom()`, `terminal.scrollToLine(...)`.
- `terminal.clear()`.
- `terminal.focus()` and `terminal.blur()`.
- `Terminal.strings`: global localizable strings (`promptLabel`, `tooMuchOutput`).

## Current Usage in console-terminal

- `Terminal` is created in `console-terminal/ui/src/TerminalView.tsx`.
- Options currently set: `allowProposedApi`, `cursorBlink`, `fontFamily`, responsive `fontSize`, and `theme.background`.
- Addons loaded: `FitAddon`, `SerializeAddon`, `WebLinksAddon`.
- Hooks used: `onTitleChange` (updates UI title), `onResize` (sends cols/rows to server), `onData` (sends input), `attachCustomKeyEventHandler` (Shift+Enter opens composer).
- Mobile UX: custom touch scroll handling and input `textarea` attributes to reduce autofill/suggestions.
- `SerializeAddon` powers `getSnapshot()` (for reconnect).
- `onOutput` hook is used to tap terminal output (TTS fallback).
