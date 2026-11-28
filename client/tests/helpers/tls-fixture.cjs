'use strict';

const crypto = require('node:crypto');

// Generate an isolated, short-lived test CA with Node alone. No committed keys,
// external OpenSSL installation or globally disabled TLS verification is needed.
const materials = new Map();
function certificate(ip = '127.0.0.1') {
  if (materials.has(ip)) return materials.get(ip);
  function der(tag, ...parts) {
    const body = Buffer.concat(parts.map(value => Buffer.isBuffer(value) ? value : Buffer.from(value)));
    const length = body.length < 128 ? Buffer.from([body.length]) : (() => {
      const bytes = []; let size = body.length;
      while (size) { bytes.unshift(size & 255); size >>>= 8; }
      return Buffer.from([128 | bytes.length, ...bytes]);
    })();
    return Buffer.concat([Buffer.from([tag]), length, body]);
  }
  const seq = (...parts) => der(0x30, ...parts);
  const oid = value => {
    const numbers = value.split('.').map(Number), bytes = [40 * numbers[0] + numbers[1]];
    for (const number of numbers.slice(2)) {
      const encoded = [number & 127]; let remaining = Math.floor(number / 128);
      while (remaining) { encoded.unshift((remaining & 127) | 128); remaining = Math.floor(remaining / 128); }
      bytes.push(...encoded);
    }
    return der(6, Buffer.from(bytes));
  };
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(oid('1.2.840.113549.1.1.11'), der(5, Buffer.alloc(0)));
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, 'SoduWork generated TLS fixture ' + ip))));
  const time = offset => der(0x17, new Date(Date.now() + offset).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z');
  const extensions = der(0xa3, seq(
    seq(oid('2.5.29.19'), der(1, Buffer.from([255])), der(4, seq(der(1, Buffer.from([255]))))),
    seq(oid('2.5.29.17'), der(4, seq(
      ...['localhost', 'archive.invalid', 'redirect.invalid'].map(host => der(0x82, host)),
      der(0x87, ip === '::1' ? Buffer.from('00000000000000000000000000000001', 'hex') : Buffer.from(ip.split('.').map(Number))),
    ))),
  ));
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    seq(time(-86400000), time(86400000)), name, pair.publicKey.export({ format: 'der', type: 'spki' }), extensions);
  const signed = seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, pair.privateKey)])));
  const pem = '-----BEGIN CERTIFICATE-----\n' + signed.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  const material = { cert: pem, key: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), tls: { ca: pem } };
  materials.set(ip, material);
  return material;
}

module.exports = { certificate };
