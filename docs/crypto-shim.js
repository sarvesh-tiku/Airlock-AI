// Browser stand-ins for the two node:crypto calls the engine makes.
// Version hashes here are FNV-1a based: fine for change detection in a playground.
export const randomUUID = () => crypto.randomUUID();
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export function createHash() {
  let data = '';
  return { update(value) { data += String(value); return this; }, digest() { return fnv1a(data, 0x811c9dc5) + fnv1a(data, 0x01000193) + fnv1a(data, 0xdeadbeef); } };
}
