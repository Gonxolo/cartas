# Mesa de cartas

A shared card table for phones on the same Wi-Fi. No internet and no app install needed on the players' phones: everyone uses their browser (iPhone or Android). It all lives in one file, `mesa.js`, and needs only Node.js (no `npm install`).

## Option A: laptop (most reliable)

1. **Make a local network.** An **Android** phone can usually run a hotspot with airplane mode on (Airplane mode → turn Wi-Fi on → Hotspot on). iPhone Personal Hotspot needs cellular, so it won't work in the air. Another option: everyone joins the plane's Wi-Fi without paying. The devices can often reach each other, though some planes block that.
2. Connect the laptop and the other phones to that network.
3. On the laptop:
   ```bash
   node mesa.js
   ```
4. It prints a URL like `http://172.20.10.3:8080`. Open it on every phone and enter your names.

## Option B: phones only (Android host)

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

## How to play

- **☰ Menú → Partida nueva**: French deck (52), Spanish (40 or 48), 1–3 decks, optional jokers. Then **Repartir** N cards each.
- Tap the **deck** to draw, tap the **discard pile** to take its top card.
- Tap cards in your hand to select them, then **Bajar** (lay them on the table as a new group), **Descartar**, **Pasar a…** (give to a player) or **Juntar** (move them to the front of your hand).
- Tap a group on the table (it gets a yellow outline) and you can **Agregar al grupo** (add your selected cards to it) or **Tomar grupo / Tomar carta** (take it back into your hand).
- Menu extras: flip the deck's top card to the discard or table, put the discard back into the deck, show your hand to everyone, set turns, remove a player.
- Each player has **+ / −** buttons for keeping score, and the log at the top shows every move.
- The game is saved to `mesa-state.json`, so if the server restarts or a phone reconnects nothing is lost. Delete that file to start completely fresh.
