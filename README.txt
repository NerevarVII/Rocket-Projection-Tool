RECOVERY PLOT - mobile app
==========================

Deploy: upload every file in this folder, keeping them together, to any
static host (GitHub Pages, Netlify drop, S3, a folder on your own server).
index.html is the entry point. No build step, no server code.

  index.html            the app
  physics.js            flight simulation + Estes kit/motor data (NAR certified)
  support.js            rendering runtime
  sw.js                 service worker: makes the app work with no signal
  manifest.webmanifest  lets the phone install it to the home screen
  icon-192.png          home-screen icon
  icon-512.png          home-screen icon
  README.txt            this file

Must be served over HTTPS (or opened from localhost). Four things need it:
  - GPS, for USE MY LOCATION and MARK SPOT
  - the device compass (WALK screen, wind and rod tools)
  - the accelerometer, for LINE UP THE REAL ROD
  - the service worker, for offline use
All fail gracefully on http:// or desktop and say so on screen.

Offline:
  Once opened over HTTPS, the app, its libraries and every map tile you have
  looked at are kept on the phone. Pan around the field at home before you go
  and the map is there at the pad. The last forecast fetched is kept for 36 h
  and used, labelled LAST KNOWN, when there is no signal. The simulation runs
  entirely on the phone.

Install on iPhone: open in Safari, Share, Add to Home Screen. It then opens
full-screen like an app.

When you deploy a new version:
  - in index.html, bump BUILD (the physics.js cache-buster)
  - in sw.js, bump VERSION (drops the old offline copy on next open)
  Phones that had the old version pick up the new one on the next open with
  signal; it goes live on the open after that.

Local test:
  python3 -m http.server 8000
  then open http://localhost:8000/

Data kept in the browser (Clearing site data erases all of it):
  rp.flightlog.v1   the flight log
  rp.pad.v1         home pad
  rp.lastwx.v1      last forecast, for offline
  rp.mykits.v1, rp.motorstock.v1, rp.fleet.v1   your rockets and engines
