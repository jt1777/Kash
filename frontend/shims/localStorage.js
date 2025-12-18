// localStorage shim for SSR
if (typeof window === 'undefined') {
  const noop = () => {};
  const storage = {};
  
  global.localStorage = {
    getItem: (key) => storage[key] || null,
    setItem: (key, value) => { storage[key] = String(value); },
    removeItem: (key) => { delete storage[key]; },
    clear: () => { Object.keys(storage).forEach(key => delete storage[key]); },
    key: (index) => Object.keys(storage)[index] || null,
    get length() { return Object.keys(storage).length; },
  };
}
