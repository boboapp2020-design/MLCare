/* MLCare Service Worker — ให้ติดตั้งเป็นแอป + ใช้งานออฟไลน์ได้
   กลยุทธ์: network-first สำหรับไฟล์แอป (โค้ดใหม่ขึ้นเสมอเมื่อออนไลน์),
            fallback เป็น cache เมื่อออฟไลน์. ไม่ยุ่งกับ API (cross-origin). */
var CACHE = 'mlcare-v1';
var SHELL = [
  '.', 'index.html', 'styles.css',
  'config.js', 'data.js', 'app.js', 'employees.js',
  'icon-192.png', 'icon-512.png', 'ICon.png', 'home.png',
  'manifest.json'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache ทีละไฟล์ ไม่ให้ล้มทั้งชุดถ้าบางไฟล์ 404 (เช่น employees.js บน GitHub Pages)
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { return null; });
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // เฉพาะ GET และ same-origin เท่านั้น — ปล่อย API (Apps Script) ผ่านตรงๆ
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then(function (res) {
      // เก็บสำเนาไว้ใช้ตอนออฟไลน์
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        // ถ้าเป็นการเปิดหน้า (navigation) แต่ออฟไลน์ ให้ตอบ index.html
        if (req.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      });
    })
  );
});
