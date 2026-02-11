const CACHE_NAME = 'globalchat-v1';
self.addEventListener('install', event => {
    self.skipWaiting();
});
self.addEventListener('fetch', event => {
    event.respondWith(fetch(event.request));
});