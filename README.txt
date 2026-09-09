RECOVERY PLOT - mobile app
==========================

Deploy: upload the four files in this folder, keeping them together, to any
static host (Netlify drop, GitHub Pages, S3, a folder on your own server).
index.html is the entry point. No build step, no server code.

  index.html    the app
  physics.js    flight simulation + Estes kit/motor data
  support.js    rendering runtime
  README.txt    this file

Must be served over HTTPS (or opened from localhost). Two features need it:
  - GPS, for USE MY LOCATION and MARK SPOT
  - the device compass on the WALK screen
Both fail gracefully on http:// or desktop and say so on screen.

Needs a network connection for:
  - map tiles (OpenStreetMap)
  - wind (Open-Meteo, then National Weather Service as fallback)
The simulation itself runs entirely on the phone and needs no network.

Local test:
  python3 -m http.server 8000
  then open http://localhost:8000/deploy/

The flight log is stored in the browser under the key rp.flightlog.v1.
Clearing site data erases it.
