/*
 * Almacén clave-valor mínimo sobre IndexedDB.
 * Lo comparten la página y el service worker (que no puede leer localStorage),
 * para que el service worker sepa qué espacio consultar y a qué hora avisar.
 */
(function (g) {
  'use strict';
  const DB = 'habitos-kv';
  const STORE = 'kv';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function set(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  g.KV = { get, set };
})(self);
