/* =======================================================================
   Petit serveur statique local, sans dépendance, pour tester l'appli dans
   Chrome sur PC sans passer par un build/install APK à chaque changement.
   Sert le dossier www/ sur http://localhost:5173

   Usage : node scripts/dev-server.js
   (à lancer dans un 2e terminal pendant que `npm run watch` tourne dans
   le premier, pour que www/app.js se recompile automatiquement)
   ======================================================================= */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "www");
const PORT = 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (req.url === "/" || req.url === "") filePath = path.join(ROOT, "index.html");

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 — fichier introuvable : " + req.url);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Serveur local prêt : http://localhost:${PORT}`);
});
