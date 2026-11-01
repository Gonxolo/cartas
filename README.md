# Mesa de cartas

Card table for phones with no internet (made for planes). **https://gonxolo.github.io/cartas/** is an offline web app (PWA): each player opens it once while online (Safari/Chrome; optionally Share → Add to Home Screen) and after that it works in airplane mode.

## Live table (recommended)

A real shared table: one deck, one discard pile and one table, with every phone showing only its own hand. One phone is the **host** (it holds the game) and the others connect to it **directly, phone to phone**, by scanning QR codes. No server, no laptop, no internet.

**1. A common network.** Everyone must be on the same Wi-Fi. It doesn't need internet:
- **Android hotspot.** Works in airplane mode: Airplane mode → turn Wi-Fi on → turn Hotspot on.
- **The plane's Wi-Fi**, joined without paying. This works if the airline doesn't isolate passengers from each other; many do.
- A battery travel router (e.g. GL.iNet), if you have one.
- An iPhone Personal Hotspot won't work: it needs cellular, which airplane mode turns off.

**2. Pair (two scans per player, a few seconds each).**
1. Host: **Crear mesa** → name → a QR appears.
2. Each other player taps **Unirme** → **Escanear código del anfitrión**. Scanning the QR with the phone's normal camera app also works.
3. Their phone shows a reply QR. The host points their phone at it (the host's camera is already scanning). Done; the host's screen is ready for the next player.

**3. Play.**
- **☰ Menú → Partida nueva**: French deck (52), Spanish (40 or 48), 1–3 decks, optional jokers. Then **Repartir** N cards each.
- Tap the **deck** to draw and the **discard pile** to take its top card.
- Select cards in your hand → **Bajar** (meld on the table), **Descartar**, **Pasar a…** (give to a player), **Juntar**.
- Tap a group on the table → **Agregar al grupo** / **Tomar grupo** / **Tomar carta**.
- Turns, scores (+/−), reveal your hand, reshuffle the discard pile into the deck, remove a player: all in the menu. The log at the top shows every move.

**If someone disconnects** (their phone slept, the page reloaded): they tap **Reconectar** and the host taps **＋ Invitar**. Repeat the two scans and they get **their same seat and cards back**. The game lives on the host's phone and is saved there. If the host's app reloads, they tap **Continuar mi mesa** and invite everyone again. The app keeps screens awake while playing. Keep the host phone plugged in if you can.

### Before the flight: test it at home

Everyone opens the link once while online. Then put every phone in airplane mode, start the Android hotspot (or use any home Wi-Fi with the internet unplugged), and do one pairing. If it works there, it works on the plane. If you update the app later, open it twice while online so the new version is cached.

### How the connection works, and why it's built this way

Browsers can't open a server, and they can't use Bluetooth or Wi-Fi Direct to talk to each other: Web Bluetooth can't advertise, and iOS doesn't support it at all. What they *can* do is **WebRTC**, a direct encrypted phone-to-phone connection over any local network, with no internet. Normally a website relays the connection setup ("signaling") between the two phones. Here **the QR codes are the signaling**. WebRTC's ~2 KB setup message is compressed to ~100 bytes (the ICE username/password, the DTLS certificate fingerprint and the phone's local addresses), so the QR stays small and quick to scan. After that, the phones talk directly (`docs/net.js`). The host's phone runs the game rules (`docs/engine.js`, the same rules as `mesa.js`) and sends each player only what they're allowed to see (`docs/live.js`).

The camera is open while the codes are being generated. That makes the browser use its real local IP instead of an anonymized `.local` name, which connects more reliably on some networks.

The one thing a browser app can't do is connect **with no shared network at all**. That would need a native app (Apple's MultipeerConnectivity / Google's Nearby Connections, which build their own peer-to-peer Wi-Fi/Bluetooth link) and App Store distribution. For that case, use the mode below.

## No common network at all: «Sin red» mode

On the home screen, under **Sin red**: one player taps **Crear partida** and shows the QR; the others scan it (or type the code) and each picks a different player number. Every phone computes the same shuffle from the code, so each sees only their own hand and draws from their own slice of the deck. Nothing is synced: discards and melds are shown by turning your screen around. To pick up a card everyone saw, use **+ Tomar carta vista**.

## Alternative: `mesa.js` server (laptop or Termux)

The same live table, but served by a small Node.js server instead of the host's phone. You no longer need it, since the live table above does this with no server. It is still useful if someone has a laptop, or as a fallback if WebRTC misbehaves on some phone. It all lives in one file, `mesa.js`, and needs only Node.js (no `npm install`).

### Option A: laptop

1. **Make a local network.** An **Android** phone can usually run a hotspot with airplane mode on (Airplane mode → turn Wi-Fi on → Hotspot on). iPhone Personal Hotspot needs cellular, so it won't work in the air. Another option: everyone joins the plane's Wi-Fi without paying. The devices can often reach each other, though some planes block that.
2. Connect the laptop and the other phones to that network.
3. On the laptop:
   ```bash
   node mesa.js
   ```
4. It prints a URL like `http://172.20.10.3:8080`. Open it on every phone and enter your names.

### Option B: phones only (Android host)

**Do this before you lose internet:**
1. On the Android phone, install **Termux** (Google Play or F-Droid), open it and run:
   ```bash
   pkg install nodejs
   termux-setup-storage
   ```
2. Get `mesa.js` onto that phone, for example by emailing or WhatsApp-ing it to yourself and saving it to Downloads.

**On the plane:**
1. Turn on that Android phone's hotspot and connect the other phones to it.
2. In Termux:
   ```bash
   termux-wake-lock
   node ~/storage/downloads/mesa.js
   ```
3. The others open `http://192.168.43.1:8080` (common Android hotspot address; if it fails, check the hotspot's IP in Settings → Hotspot / connected devices). The host phone opens `http://localhost:8080` in Chrome.

### How to play

- **☰ Menú → Partida nueva**: French deck (52), Spanish (40 or 48), 1–3 decks, optional jokers. Then **Repartir** N cards each.
- Tap the **deck** to draw, tap the **discard pile** to take its top card.
- Tap cards in your hand to select them, then **Bajar** (lay them on the table as a new group), **Descartar**, **Pasar a…** (give to a player) or **Juntar** (move them to the front of your hand).
- Tap a group on the table (it gets a yellow outline) and you can **Agregar al grupo** (add your selected cards to it) or **Tomar grupo / Tomar carta** (take it back into your hand).
- Menu extras: flip the deck's top card to the discard or table, put the discard back into the deck, show your hand to everyone, set turns, remove a player.
- Each player has **+ / −** buttons for keeping score, and the log at the top shows every move.
- The game is saved to `mesa-state.json`, so if the server restarts or a phone reconnects nothing is lost. Delete that file to start completely fresh.
