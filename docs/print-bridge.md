# The print bridge — thermal slips, cash drawers and kitchen tickets

A browser cannot open a socket to a receipt printer. The **print bridge** is a
tiny Node script that runs on the till machine and does exactly that job: it
accepts raw ESC/POS bytes over local HTTP and forwards them to the printer's
TCP port 9100. Every layout decision lives in the app's tested TypeScript
(`src/lib/escpos/`); the bridge only moves bytes.

## Setting it up

1. On the till machine (Node 20+ installed):

   ```
   node scripts/print-bridge.mjs
   ```

   Keep it running — a scheduled task / service / startup shortcut is the
   usual answer. It listens on `http://127.0.0.1:9723` by default.

2. Create `scripts/print-bridge.config.json`:

   ```json
   {
     "port": 9723,
     "bind": "127.0.0.1",
     "printers": {
       "receipt": { "type": "tcp", "host": "192.168.1.50", "port": 9100 },
       "kitchen": { "type": "tcp", "host": "192.168.1.51", "port": 9100 }
     }
   }
   ```

   The printer names (`receipt`, `kitchen`) are what the till refers to. The
   hosts are the printers' own network addresses — check the printer's config
   slip (most print one when you hold the feed button at power-on).

3. In the app: **Setup → Printing** on each till machine. Enter the bridge
   URL, press *Test connection*, pick the printer names it reports, and print
   the test slip.

## Sharing one bridge between tills

Set `"bind": "0.0.0.0"` and point the other tills' Setup → Printing at
`http://<this machine's LAN address>:9723`. Binding beyond loopback is the
shop's explicit choice — anything on the LAN can then print.

## USB-only printers

v1 speaks TCP 9100 only — every networked 80mm thermal and kitchen printer of
the last fifteen years has it. For a USB-only model, use the vendor utility to
put it on the network, or install the vendor's 9100 emulation. Direct
USB/serial support is a possible later addition to the bridge.

## The cash drawer

The drawer plugs into the RECEIPT printer's RJ11 socket. When a sale is paid
with a tender whose *Opens cash drawer* flag is on (Setup → Tender types), the
till sends the kick pulse with the print job — no separate wiring.

## Manual verification checklist (real hardware)

- [ ] Test slip prints, cuts, and the accents line reads cleanly (CP858).
- [ ] A sale prints its slip; TOTAL is double-height; columns line up.
- [ ] Cash sale kicks the drawer; card sale (flag off) does not.
- [ ] Gift receipt shows no prices.
- [ ] Kitchen ticket prints on the kitchen printer with double-size items.
- [ ] Pull the network cable to the SERVER (not the printer): an offline sale
      still prints its slip — the bridge and printer are local.
- [ ] Kill the bridge: the till toasts the failure and offers the browser
      print instead; nothing hangs.

## Notes

- HTTPS pages calling `http://127.0.0.1` are allowed by modern Chromium
  (loopback is exempt from mixed-content blocking). If a locked-down browser
  refuses, serve the app over plain HTTP on the LAN or run the browser with
  loopback exemptions.
- The bridge answers CORS `*` — safe on loopback; on `0.0.0.0` it means
  anything on the LAN can print, which is what sharing a printer means.
