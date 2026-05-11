# Phantom (macOS)

> *The AI nobody sees but you.*

Copiloto de IA invisible para macOS. Lee tu pantalla, te contesta, y desaparece de cualquier screen-share o grabación.

Hecho con **Electron** + `setContentProtection(true)` (que en macOS llama a `CGSetWindowSharingType(NSWindowSharingNone)` — la misma técnica que usa Cluely).

## Características

- **Ventana flotante** always-on-top, sin marco, transparente, draggable.
- **🥷 Invisible para screen sharing** (Zoom, Meet, Teams, OBS, grabaciones de QuickTime, etc).
- **Captura de pantalla** del escritorio + análisis con IA multimodal (Claude / GPT).
- **Chat de seguimiento** con historial.
- **Detección de phishing** con banner rojo y guías paso a paso.
- **Atajos globales del sistema:**
  - `⌘ + Shift + H` → ocultar / mostrar
  - `⌘ + Shift + R` → analizar pantalla (resumir)
  - `⌘ + Shift + A` → contestar pregunta visible

## Requisitos

- macOS 11 (Big Sur) o superior — recomendado macOS 14+
- Node.js 18+ (sólo para desarrollo / build)
- API key de Anthropic o OpenAI

## Instalación / desarrollo

```bash
cd Phantom-Desktop
npm install
npm start
```

La primera vez la app te pide permiso para **grabar pantalla** (System Settings → Privacy & Security → Screen Recording). Hay que activarlo para que pueda capturar el escritorio.

## Build de release (.dmg)

```bash
npm run build:mac-dmg
```

El instalador queda en `dist/Phantom-1.0.0-arm64.dmg`.

## Configuración

Al abrir la app, click en ⚙ → poné tu API key (Anthropic o OpenAI) → Guardar.
La key se guarda en `~/Library/Application Support/Phantom/config.json` (sólo en tu Mac).

## Cómo se logra la invisibilidad

```js
mainWindow.setContentProtection(true);
```

Esto le dice a macOS que la ventana **no debe ser capturada** por:
- Screen sharing en videollamadas (Zoom, Google Meet, Microsoft Teams, etc.)
- Software de grabación (QuickTime Player, OBS, Loom, Camtasia, etc.)
- Screenshots del sistema (`Cmd+Shift+3/4` muestran la pantalla SIN la ventana de Phantom)

Vos la seguís viendo perfectamente en tu monitor.

> ⚠️ Limitación: si graban con una cámara externa apuntando al monitor, se ve. La protección es a nivel del compositor de macOS, no físico.

## Estructura

```
Phantom-Desktop/
├── package.json
├── main.js              # proceso principal de Electron
├── preload.js           # bridge seguro main ↔ renderer (window.phantom.*)
├── renderer/
│   ├── index.html
│   ├── styles.css
│   └── renderer.js      # lógica UI
├── assets/
│   ├── icon.png
│   └── icon-1024.png
└── README.md
```

## Métodos de captura (con fallback)

`main.js` intenta dos métodos de captura en cascada:

1. **Electron `desktopCapturer`** → vía API nativa de Electron.
2. **`/usr/sbin/screencapture`** → fallback con el binario nativo de macOS, que tiene su propio flujo de TCC más estable y a veces ya está pre-aprobado.

## Próximas mejoras

- [ ] Tray icon con menú rápido.
- [ ] Captura de región (no toda la pantalla).
- [ ] Notarización + firma con Apple Developer ID para distribuir afuera.
- [ ] Auto-update con `electron-updater`.
- [ ] Onboarding interactivo para primer uso.
